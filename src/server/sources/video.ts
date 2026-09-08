import { randomUUID } from "node:crypto";
import {
  sourceParseFailure,
  sourceParseResult,
  type SourceParseLimits,
  type SourceParseResult,
  type SourceParser,
  type SourceSegment,
} from "./index";
import { SourceToolError, missingExecutables, runCommand, type CommandRunner } from "./ocr";
import {
  CUE_GROUPING,
  TranscriptionError,
  createOpenAiTranscriptionClient,
  groupCues,
  parseSubtitleCues,
  type TranscriptCue,
  type TranscriptionClient,
} from "./transcribe";

// T042. processing.md draws the line for this parser: only files, subtitles and direct
// links the user is entitled to read, no promise about arbitrary platform URLs, ffmpeg for
// the audio track, chunking at the provider's size limit, and real time offsets kept
// throughout. A segment that was never transcribed must not become a fact, so every path
// out of here is either cues with measured timings or a typed failure.

export const VIDEO_EXECUTABLES = ["ffprobe", "ffmpeg"] as const;

export const VIDEO_PARSE_LIMITS: SourceParseLimits = {
  // The development upload ceiling from processing.md. Production may raise it only after
  // the sizing work described there.
  maxBytes: 50 * 1_024 * 1_024,
  maxSegments: CUE_GROUPING.maxSegments,
  maxCharacters: CUE_GROUPING.maxCharacters,
  timeoutMs: 280_000,
};

// processing.md: Video <= 30 minutes. Longer input is refused with an instruction rather
// than quietly transcribed in part.
export const VIDEO_MAX_DURATION_SECONDS = 30 * 60;

// Ten minutes of mono 16 kHz mp3 at 32 kbps is about 2.4 MB, comfortably inside the
// provider request cap, and the boundary doubles as the chunk's exact time offset.
export const VIDEO_AUDIO_CHUNK_SECONDS = 600;
export const VIDEO_MAX_AUDIO_CHUNKS = 6;

const FFPROBE_TIMEOUT_MS = 30_000;
const SUBTITLE_EXTRACT_TIMEOUT_MS = 60_000;
const AUDIO_EXTRACT_TIMEOUT_MS = 120_000;
const MAX_SUBTITLE_BYTES = 16 * 1_024 * 1_024;
const MAX_AUDIO_CHUNK_BYTES = 24 * 1_024 * 1_024;

export interface VideoParseInput {
  readonly filePath: string;
  readonly byteLength?: number;
  readonly title?: string;
  // Set when the source began life as a link rather than an upload, so the parser can
  // refuse the ones we have no right to read before touching the network.
  readonly url?: string;
  // A transcript the user supplied themselves. Preferred over everything else: it costs
  // nothing, it is exact, and it is the alternative we offer when transcription is off.
  readonly subtitleText?: string;
  readonly language?: string;
}

export type VideoUrlClass = "direct" | "platform" | "unsupported";

// Watch pages, not media. Downloading them would mean scraping a service whose terms we
// have no standing under, so they get an alternative entry instead of an attempt.
const PLATFORM_HOSTS = [
  "youtube.com",
  "youtu.be",
  "vimeo.com",
  "bilibili.com",
  "b23.tv",
  "tiktok.com",
  "douyin.com",
  "twitch.tv",
  "dailymotion.com",
  "facebook.com",
  "instagram.com",
  "twitter.com",
  "x.com",
  "netflix.com",
  "iqiyi.com",
  "youku.com",
  "qq.com",
] as const;

const DIRECT_MEDIA_EXTENSIONS = [
  ".mp4",
  ".m4v",
  ".mov",
  ".webm",
  ".mkv",
  ".m4a",
  ".mp3",
  ".wav",
  ".ogg",
  ".oga",
  ".flac",
] as const;

export function classifyVideoUrl(value: string): VideoUrlClass {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "unsupported";
  }
  if (url.protocol !== "https:") return "unsupported";
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    PLATFORM_HOSTS.some((platform) => host === platform || host.endsWith(`.${platform}`))
  ) {
    return "platform";
  }
  const path = url.pathname.toLowerCase();
  return DIRECT_MEDIA_EXTENSIONS.some((extension) => path.endsWith(extension))
    ? "direct"
    : "unsupported";
}

export interface VideoProbe {
  readonly durationSeconds: number;
  readonly hasAudio: boolean;
  readonly hasSubtitles: boolean;
  readonly title?: string;
}

interface ProbeStream {
  readonly codec_type?: unknown;
}

export function parseFfprobeOutput(stdout: string): VideoProbe | undefined {
  let payload: {
    streams?: unknown;
    format?: { duration?: unknown; tags?: Record<string, unknown> };
  };
  try {
    payload = JSON.parse(stdout) as typeof payload;
  } catch {
    return undefined;
  }
  const streams = Array.isArray(payload.streams) ? (payload.streams as ProbeStream[]) : [];
  const rawDuration = payload.format?.duration;
  const durationSeconds =
    typeof rawDuration === "string" ? Number.parseFloat(rawDuration) : Number(rawDuration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return undefined;
  const titleTag = payload.format?.tags?.title;
  return {
    durationSeconds,
    hasAudio: streams.some((stream) => stream.codec_type === "audio"),
    hasSubtitles: streams.some((stream) => stream.codec_type === "subtitle"),
    title: typeof titleTag === "string" && titleTag.trim() ? titleTag.trim() : undefined,
  };
}

function toolFailure(error: SourceToolError): SourceParseResult {
  if (error.reason === "timeout") return sourceParseFailure("SOURCE_TIMEOUT");
  return sourceParseFailure("SOURCE_UNAVAILABLE", {
    action: "retry-later",
    message: "This video could not be read right now. Try again in a moment.",
  });
}

// Every transcription fault maps to an alternative the user can actually take. The one
// thing none of them may do is come back as a successful parse with no speech in it.
export function transcriptionFailure(error: TranscriptionError): SourceParseResult {
  switch (error.reason) {
    case "timeout":
      return sourceParseFailure("SOURCE_TIMEOUT");
    case "too-large":
      return sourceParseFailure("SOURCE_TOO_LARGE", {
        action: "split-input",
        message: "This recording is too long to transcribe in one piece. Split it and import the parts.",
      });
    case "not-configured":
      return sourceParseFailure("SOURCE_UNAVAILABLE", {
        action: "paste-text",
        message: "Transcription is unavailable, so this video has no text yet. Paste the transcript instead.",
      });
    default:
      return sourceParseFailure("SOURCE_UNAVAILABLE", {
        action: "paste-text",
        message: "This video could not be transcribed. Paste the transcript instead, or try again later.",
      });
  }
}

export function createVideoSourceParser(options: {
  readonly runner?: CommandRunner;
  readonly transcription?: TranscriptionClient | null;
  readonly createId?: () => string;
  readonly now?: () => number;
} = {}): SourceParser<VideoParseInput> {
  const runner = options.runner ?? runCommand;
  const transcription =
    options.transcription === undefined
      ? createOpenAiTranscriptionClient()
      : options.transcription;
  const createId = options.createId ?? randomUUID;
  const now = options.now ?? (() => Date.now());

  async function readEmbeddedSubtitles(
    filePath: string,
    timeoutMs: number,
  ): Promise<string> {
    const extracted = await runner(
      "ffmpeg",
      ["-v", "error", "-i", filePath, "-map", "0:s:0", "-f", "webvtt", "pipe:1"],
      { timeoutMs, maxOutputBytes: MAX_SUBTITLE_BYTES },
    );
    if (extracted.timedOut) throw new SourceToolError("ffmpeg", "timeout");
    // A deck whose subtitle stream will not convert is not a fatal error: the audio path
    // is still available, so an empty string simply falls through to transcription.
    if (extracted.code !== 0) return "";
    return extracted.stdout.toString("utf8");
  }

  async function readAudioChunk(
    filePath: string,
    offsetSeconds: number,
    durationSeconds: number,
    timeoutMs: number,
  ): Promise<Uint8Array> {
    const extracted = await runner(
      "ffmpeg",
      [
        "-v",
        "error",
        // Seeking before -i is the fast path and lands on the exact requested second,
        // which is what makes the chunk offset a measurement rather than a guess.
        "-ss",
        offsetSeconds.toFixed(3),
        "-t",
        durationSeconds.toFixed(3),
        "-i",
        filePath,
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-b:a",
        "32k",
        "-f",
        "mp3",
        "pipe:1",
      ],
      { timeoutMs, maxOutputBytes: MAX_AUDIO_CHUNK_BYTES },
    );
    if (extracted.timedOut) throw new SourceToolError("ffmpeg", "timeout");
    if (extracted.code !== 0) throw new SourceToolError("ffmpeg", "failed");
    if (extracted.truncated) throw new SourceToolError("ffmpeg", "failed");
    return extracted.stdout;
  }

  return {
    kind: "video",
    async parse(input, limits = VIDEO_PARSE_LIMITS): Promise<SourceParseResult> {
      const deadline = now() + limits.timeoutMs;
      const remaining = (cap: number) => Math.min(cap, Math.max(deadline - now(), 0));

      if (input.url) {
        const classified = classifyVideoUrl(input.url);
        if (classified === "platform") {
          return sourceParseFailure("SOURCE_BLOCKED", {
            action: "upload-file",
            message:
              "We can't import video from this site. Upload the file you have the rights to, or paste the transcript.",
          });
        }
        if (classified === "unsupported") {
          return sourceParseFailure("SOURCE_UNSUPPORTED_FORMAT", {
            action: "upload-file",
            message:
              "This link is not a direct video or audio file. Upload the file instead, or paste the transcript.",
          });
        }
      }
      if (input.byteLength !== undefined && input.byteLength > limits.maxBytes) {
        return sourceParseFailure("SOURCE_TOO_LARGE");
      }

      try {
        const probed = await runner(
          "ffprobe",
          [
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            input.filePath,
          ],
          { timeoutMs: remaining(FFPROBE_TIMEOUT_MS), maxOutputBytes: 4 * 1_024 * 1_024 },
        );
        if (probed.timedOut) return sourceParseFailure("SOURCE_TIMEOUT");
        if (probed.code !== 0) return sourceParseFailure("SOURCE_MALFORMED");
        const probe = parseFfprobeOutput(probed.stdout.toString("utf8"));
        if (!probe) return sourceParseFailure("SOURCE_MALFORMED");
        if (probe.durationSeconds > VIDEO_MAX_DURATION_SECONDS) {
          return sourceParseFailure("SOURCE_TOO_LARGE", {
            action: "split-input",
            message: `This recording is longer than ${VIDEO_MAX_DURATION_SECONDS / 60} minutes. Split it and import the parts separately.`,
          });
        }

        // Order of preference: the transcript the user handed us, then a subtitle track
        // already inside the file, and only then paid transcription.
        let cues: TranscriptCue[] = [];
        let transcribed = false;
        if (input.subtitleText) {
          cues = parseSubtitleCues(input.subtitleText);
        }
        if (cues.length === 0 && probe.hasSubtitles) {
          const embedded = await readEmbeddedSubtitles(
            input.filePath,
            remaining(SUBTITLE_EXTRACT_TIMEOUT_MS),
          );
          if (embedded) cues = parseSubtitleCues(embedded);
        }

        if (cues.length === 0) {
          if (!probe.hasAudio) {
            return sourceParseFailure("SOURCE_NO_TEXT_LAYER", {
              action: "paste-text",
              message:
                "This file has no subtitles and no audio track to transcribe. Paste the transcript instead.",
            });
          }
          if (!transcription) {
            return sourceParseFailure("SOURCE_UNAVAILABLE", {
              action: "paste-text",
              message:
                "Transcription is unavailable, so this video has no text yet. Paste the transcript instead.",
            });
          }

          const chunkCount = Math.min(
            Math.ceil(probe.durationSeconds / VIDEO_AUDIO_CHUNK_SECONDS),
            VIDEO_MAX_AUDIO_CHUNKS,
          );
          for (let index = 0; index < chunkCount; index += 1) {
            const offsetSeconds = index * VIDEO_AUDIO_CHUNK_SECONDS;
            const durationSeconds = Math.min(
              VIDEO_AUDIO_CHUNK_SECONDS,
              probe.durationSeconds - offsetSeconds,
            );
            if (durationSeconds <= 0) break;
            if (remaining(AUDIO_EXTRACT_TIMEOUT_MS) <= 0) {
              return sourceParseFailure("SOURCE_TIMEOUT");
            }
            const audio = await readAudioChunk(
              input.filePath,
              offsetSeconds,
              durationSeconds,
              remaining(AUDIO_EXTRACT_TIMEOUT_MS),
            );
            // Silence extracts to a handful of frames. Sending it would cost money to be
            // told there is nothing there, so the chunk is skipped and its span simply
            // produces no segment — not an invented one.
            if (audio.byteLength < 1_024) continue;
            transcribed = true;
            cues.push(
              ...(await transcription.transcribe({
                audio,
                filename: `chunk-${index}.mp3`,
                mimeType: "audio/mpeg",
                offsetSeconds,
                durationSeconds,
                ...(input.language ? { language: input.language } : {}),
              })),
            );
          }
        }

        const grouped = groupCues(cues, {
          windowSeconds: CUE_GROUPING.windowSeconds,
          maxSegments: limits.maxSegments,
          maxCharacters: limits.maxCharacters,
        });
        const segments: SourceSegment[] = grouped.map((group) => ({
          segmentId: createId(),
          text: group.text,
          locator: {
            kind: "time",
            startSeconds: group.startSeconds,
            endSeconds: group.endSeconds,
          },
        }));

        const coveredSeconds = Math.min(
          probe.durationSeconds,
          VIDEO_MAX_AUDIO_CHUNKS * VIDEO_AUDIO_CHUNK_SECONDS,
        );
        return sourceParseResult(
          segments,
          {
            title: input.title ?? probe.title,
            durationSeconds: probe.durationSeconds,
            ...(transcribed && coveredSeconds < probe.durationSeconds
              ? { truncated: true }
              : {}),
          },
          // Nothing readable came back. With an audio track that means speech we could not
          // hear rather than an empty file, and both want the same alternative: paste it.
          "SOURCE_NO_TEXT_LAYER",
        );
      } catch (error) {
        if (error instanceof TranscriptionError) return transcriptionFailure(error);
        if (error instanceof SourceToolError) return toolFailure(error);
        throw error;
      }
    },
  };
}

export async function missingVideoExecutables(
  runner: CommandRunner = runCommand,
): Promise<string[]> {
  return missingExecutables(VIDEO_EXECUTABLES, runner);
}
