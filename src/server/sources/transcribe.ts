// T042. The transcript side of a video source: subtitle cues on one path, a real
// transcription provider on the other, and one shared cue shape so both end up carrying
// the same honest time offsets.
//
// processing.md is explicit that a segment we never transcribed must not become a fact,
// so nothing in this module invents text or timings. A provider failure is a typed error
// that the caller turns into a parse failure with an alternative action; it never comes
// back as an empty success.

export interface TranscriptCue {
  // Seconds from the start of the source, not from the start of the chunk that produced
  // this cue. Chunked audio has its offset applied before the cue leaves the client.
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
}

export type TranscriptionFailureReason =
  | "not-configured"
  | "rejected"
  | "unavailable"
  | "timeout"
  | "too-large";

// A transcription that did not happen is an infrastructure or configuration fault, never a
// verdict about the video. Keeping it as a thrown, typed error stops it from being
// flattened into "this video has no speech".
export class TranscriptionError extends Error {
  constructor(readonly reason: TranscriptionFailureReason, message: string) {
    super(message);
    this.name = "TranscriptionError";
  }
}

export interface TranscriptionChunk {
  readonly audio: Uint8Array;
  readonly filename: string;
  readonly mimeType: string;
  // Where this chunk starts inside the whole source. ffmpeg segments on exact boundaries,
  // so this is a measured value, not an estimate.
  readonly offsetSeconds: number;
  readonly durationSeconds: number;
  readonly language?: string;
}

export interface TranscriptionClient {
  transcribe(chunk: TranscriptionChunk): Promise<readonly TranscriptCue[]>;
}

// The provider request cap. Chunks are cut well below it; anything that still arrives
// larger is refused rather than truncated, because a truncated chunk would silently drop
// speech and leave the gap looking like silence.
export const TRANSCRIPTION_MAX_CHUNK_BYTES = 24 * 1_024 * 1_024;

export const TRANSCRIPTION_TIMEOUT_MS = 120_000;

function parseTimestamp(value: string): number | undefined {
  // Accepts HH:MM:SS.mmm, MM:SS.mmm and the SRT comma variant.
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(value.trim());
  if (!match) return undefined;
  const hours = match[1] ? Number.parseInt(match[1], 10) : 0;
  const minutes = Number.parseInt(match[2]!, 10);
  const seconds = Number.parseInt(match[3]!, 10);
  const fraction = Number.parseInt(match[4]!.padEnd(3, "0"), 10);
  if (minutes > 59 || seconds > 59) return undefined;
  return hours * 3_600 + minutes * 60 + seconds + fraction / 1_000;
}

function cleanCueText(lines: readonly string[]): string {
  return lines
    .join("\n")
    // Cue payloads carry voice and styling spans (<v Speaker>, <i>, <00:00:01.000>).
    // They are markup around the words, not words, so they go before the text is kept.
    .replace(/<[^>\n]*>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/ *\n */g, "\n")
    .trim();
}

export interface SubtitleParseLimits {
  readonly maxCues: number;
  readonly maxCharacters: number;
}

export const SUBTITLE_LIMITS: SubtitleParseLimits = {
  // A 30 minute talk runs to a few thousand cues; the cap is generous enough for dense
  // dialogue and small enough that a crafted file cannot exhaust the worker.
  maxCues: 20_000,
  maxCharacters: 400_000,
};

// One reader for WebVTT and SRT. They differ in a header line, an optional numeric index
// and the decimal separator, all of which are tolerated here, so the caller does not have
// to sniff the format before handing the text over.
export function parseSubtitleCues(
  text: string,
  limits: SubtitleParseLimits = SUBTITLE_LIMITS,
): TranscriptCue[] {
  const cues: TranscriptCue[] = [];
  let characters = 0;
  const blocks = text
    .replace(/^﻿/, "")
    .replace(/\r\n?/g, "\n")
    .split(/\n{2,}/);

  for (const block of blocks) {
    if (cues.length >= limits.maxCues || characters >= limits.maxCharacters) break;
    const lines = block.split("\n").filter((line) => line.trim().length > 0);
    if (lines.length === 0) continue;
    // WEBVTT headers, NOTE/STYLE/REGION blocks and the SRT sequence number all sit where
    // a timing line would be; skipping by "does this line contain -->" handles them all.
    const timingIndex = lines.findIndex((line) => line.includes("-->"));
    if (timingIndex === -1) continue;
    const timing = lines[timingIndex]!;
    const [rawStart, rawRest] = timing.split("-->");
    if (rawStart === undefined || rawRest === undefined) continue;
    const start = parseTimestamp(rawStart);
    // Cue settings (align, position) trail the end timestamp on the same line.
    const end = parseTimestamp(rawRest.trim().split(/\s+/)[0] ?? "");
    if (start === undefined || end === undefined || end < start) continue;

    const body = cleanCueText(lines.slice(timingIndex + 1));
    if (!body) continue;
    const room = limits.maxCharacters - characters;
    const kept = Array.from(body).slice(0, room).join("");
    if (!kept) break;
    characters += Array.from(kept).length;
    cues.push({ startSeconds: start, endSeconds: end, text: kept });
  }
  return cues;
}

export interface CueGroupingLimits {
  readonly windowSeconds: number;
  readonly maxSegments: number;
  readonly maxCharacters: number;
}

export const CUE_GROUPING: CueGroupingLimits = {
  // Single cues are two seconds of half a sentence. Grouping them into windows gives the
  // model paragraphs to work with while the locator still points at a real span of the
  // original recording.
  windowSeconds: 45,
  maxSegments: 200,
  maxCharacters: 400_000,
};

export interface GroupedCues {
  readonly startSeconds: number;
  readonly endSeconds: number;
  readonly text: string;
}

// Cues in, readable spans out. Boundaries only ever fall between cues, so every span
// start and end is a timestamp that came from the subtitle file or the provider.
export function groupCues(
  cues: readonly TranscriptCue[],
  limits: CueGroupingLimits = CUE_GROUPING,
): GroupedCues[] {
  const groups: GroupedCues[] = [];
  let characters = 0;
  let current: { start: number; end: number; parts: string[] } | undefined;

  const flush = () => {
    if (!current) return;
    const text = current.parts.join(" ").replace(/\s+/g, " ").trim();
    if (text) {
      groups.push({ startSeconds: current.start, endSeconds: current.end, text });
    }
    current = undefined;
  };

  for (const cue of cues) {
    if (groups.length >= limits.maxSegments || characters >= limits.maxCharacters) break;
    const text = cue.text.trim();
    if (!text) continue;
    const room = limits.maxCharacters - characters;
    const kept = Array.from(text).slice(0, room).join("");
    if (!kept) break;
    characters += Array.from(kept).length;

    if (current && cue.endSeconds - current.start > limits.windowSeconds) flush();
    if (groups.length >= limits.maxSegments) break;
    if (!current) {
      current = { start: cue.startSeconds, end: cue.endSeconds, parts: [kept] };
      continue;
    }
    current.parts.push(kept);
    current.end = Math.max(current.end, cue.endSeconds);
  }
  flush();
  return groups.slice(0, limits.maxSegments);
}

export interface PublishedAudio {
  readonly url: string;
  readonly cleanup: () => Promise<void>;
}

export interface VolcengineTranscriptionOptions {
  readonly beforeRequest?: (chunk: TranscriptionChunk) => Promise<void>;
  readonly apiKey?: string;
  readonly resourceId?: string;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
  readonly publishAudio?: (chunk: TranscriptionChunk) => Promise<PublishedAudio>;
}

interface VolcengineUtterance {
  readonly start_time?: unknown;
  readonly end_time?: unknown;
  readonly text?: unknown;
}

interface VolcengineResult {
  readonly text?: unknown;
  readonly utterances?: unknown;
}

export function cuesFromVolcengineResponse(
  body: { readonly result?: VolcengineResult },
  chunk: Pick<TranscriptionChunk, "offsetSeconds" | "durationSeconds">,
): TranscriptCue[] {
  const utterances = Array.isArray(body.result?.utterances)
    ? (body.result.utterances as VolcengineUtterance[])
    : [];
  const cues = utterances.flatMap((utterance) => {
    if (
      typeof utterance.text !== "string" ||
      typeof utterance.start_time !== "number" ||
      typeof utterance.end_time !== "number" ||
      utterance.end_time < utterance.start_time
    ) return [];
    const text = utterance.text.trim();
    return text
      ? [{
          startSeconds: chunk.offsetSeconds + utterance.start_time / 1_000,
          endSeconds: chunk.offsetSeconds + utterance.end_time / 1_000,
          text,
        }]
      : [];
  });
  if (cues.length > 0) return cues;
  const text = typeof body.result?.text === "string" ? body.result.text.trim() : "";
  return text
    ? [{
        startSeconds: chunk.offsetSeconds,
        endSeconds: chunk.offsetSeconds + chunk.durationSeconds,
        text,
      }]
    : [];
}

export function createVolcengineTranscriptionClient(
  options: VolcengineTranscriptionOptions = {},
): TranscriptionClient {
  const apiKey = options.apiKey ?? process.env.VOLCENGINE_SPEECH_API_KEY ?? "";
  const resourceId = options.resourceId ?? process.env.AI_TRANSCRIBE_MODEL ?? "volc.seedasr.auc";
  const baseUrl = options.baseUrl ?? "https://openspeech.bytedance.com/api/v3/auc/bigmodel";
  const timeoutMs = options.timeoutMs ?? TRANSCRIPTION_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const fetchImpl = options.fetchImpl ?? fetch;
  const providerLanguage = (language?: string) =>
    language === "en" ? "en-US" : language === "zh" ? "zh-CN" : language;

  return {
    async transcribe(chunk) {
      // Named prerequisites, checked before any work: tasks.md forbids a missing
      // credential from turning into a skip that later reads as a pass.
      if (!apiKey) {
        throw new TranscriptionError(
          "not-configured",
          "VOLCENGINE_SPEECH_API_KEY is not configured, so this video cannot be transcribed.",
        );
      }
      if (!resourceId) {
        throw new TranscriptionError(
          "not-configured",
          "AI_TRANSCRIBE_MODEL is not configured, so this video cannot be transcribed.",
        );
      }
      if (chunk.audio.byteLength > TRANSCRIPTION_MAX_CHUNK_BYTES) {
        throw new TranscriptionError(
          "too-large",
          "An audio chunk exceeded the transcription request limit.",
        );
      }

      if (!options.publishAudio) {
        throw new TranscriptionError("not-configured", "Temporary audio publishing is not configured.");
      }

      // The worker persists its budget/attempt guard before any provider request.
      await options.beforeRequest?.(chunk);
      const published = await options.publishAudio(chunk);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const taskId = crypto.randomUUID();
        const headers = {
          "content-type": "application/json",
          "x-api-key": apiKey,
          "x-api-resource-id": resourceId,
          "x-api-request-id": taskId,
        };
        const submit = await fetchImpl(`${baseUrl}/submit`, {
          method: "POST",
          headers: { ...headers, "x-api-sequence": "-1" },
          body: JSON.stringify({
            audio: {
              url: published.url,
              format: chunk.filename.split(".").pop()?.toLowerCase() ?? "mp3",
              ...(providerLanguage(chunk.language) ? { language: providerLanguage(chunk.language) } : {}),
            },
            request: { model_name: "bigmodel", show_utterances: true, enable_itn: true },
          }),
          signal: controller.signal,
        });
        if (submit.status === 401 || submit.status === 403) {
          throw new TranscriptionError("not-configured", "The transcription credential was rejected.");
        }
        if (submit.status === 413) {
          throw new TranscriptionError("too-large", "The transcription service refused this audio chunk as too large.");
        }
        if (!submit.ok || submit.headers.get("x-api-status-code") !== "20000000") {
          throw new TranscriptionError(
            submit.status >= 500 || submit.status === 429 ? "unavailable" : "rejected",
            "The transcription service could not process this audio.",
          );
        }
        while (true) {
          const query = await fetchImpl(`${baseUrl}/query`, {
            method: "POST", headers, body: "{}", signal: controller.signal,
          });
          const status = query.headers.get("x-api-status-code");
          if (status === "20000001" || status === "20000002") {
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
            continue;
          }
          if (!query.ok || status !== "20000000") {
            throw new TranscriptionError("rejected", "The transcription service could not process this audio.");
          }
          const body = (await query.json()) as { result?: VolcengineResult };
          return cuesFromVolcengineResponse(body, chunk);
        }
      } catch (error) {
        if (error instanceof TranscriptionError) throw error;
        const aborted = error instanceof Error && error.name === "AbortError";
        throw new TranscriptionError(
          aborted ? "timeout" : "unavailable",
          aborted ? "Transcription took too long." : "The transcription service could not be reached.",
        );
      } finally {
        clearTimeout(timer);
        await published.cleanup().catch(() => undefined);
      }
    },
  };
}
