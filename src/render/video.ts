import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import type { RenderedPage } from "./render-deck";

const runFile = promisify(execFile);
const MIN_SECONDS_PER_SLIDE = 1;
const MAX_SECONDS_PER_SLIDE = 15;

export type VideoExportOptions = Readonly<{
  secondsPerSlide: number;
  audioAssetId: string | null;
}>;

export type RenderedMp4 = Readonly<{
  bytes: Buffer;
  width: number;
  height: number;
  durationSeconds: number;
  hasAudio: boolean;
}>;

export type VideoCommandRunner = (command: string, args: readonly string[]) => Promise<Readonly<{ stdout: string | Buffer; stderr: string | Buffer }>>;

export class VideoRenderError extends Error {
  constructor(readonly code: "INVALID_OPTIONS" | "VIDEO_RENDER_FAILED" | "VIDEO_INSPECTION_FAILED") {
    super(code);
  }
}

export function parseVideoExportOptions(value: unknown): VideoExportOptions {
  if (value === undefined || value === null) return { secondsPerSlide: 3, audioAssetId: null };
  if (typeof value !== "object" || Array.isArray(value)) throw new VideoRenderError("INVALID_OPTIONS");
  const options = value as Record<string, unknown>;
  const secondsPerSlide = options.secondsPerSlide ?? 3;
  if (typeof secondsPerSlide !== "number" || !Number.isInteger(secondsPerSlide) || secondsPerSlide < MIN_SECONDS_PER_SLIDE || secondsPerSlide > MAX_SECONDS_PER_SLIDE) {
    throw new VideoRenderError("INVALID_OPTIONS");
  }
  const audioAssetId = options.audioAssetId ?? null;
  if (audioAssetId !== null && (typeof audioAssetId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(audioAssetId))) {
    throw new VideoRenderError("INVALID_OPTIONS");
  }
  return { secondsPerSlide, audioAssetId };
}

export function createNodeVideoCommandRunner(): VideoCommandRunner {
  return async (command, args) => runFile(command, [...args], { maxBuffer: 8 * 1024 * 1024 });
}

export async function probeVideoRuntime(runner: VideoCommandRunner = createNodeVideoCommandRunner()): Promise<Readonly<{ ffmpegVersion: string; ffprobeVersion: string }>> {
  try {
    const [ffmpeg, ffprobe] = await Promise.all([
      runner("ffmpeg", ["-version"]),
      runner("ffprobe", ["-version"]),
    ]);
    const ffmpegVersion = String(ffmpeg.stdout).split("\n")[0]?.trim() ?? "";
    const ffprobeVersion = String(ffprobe.stdout).split("\n")[0]?.trim() ?? "";
    if (!ffmpegVersion.startsWith("ffmpeg version") || !ffprobeVersion.startsWith("ffprobe version")) {
      throw new VideoRenderError("VIDEO_RENDER_FAILED");
    }
    return { ffmpegVersion, ffprobeVersion };
  } catch (error) {
    if (error instanceof VideoRenderError) throw error;
    throw new VideoRenderError("VIDEO_RENDER_FAILED");
  }
}

function concatList(framePaths: readonly string[], secondsPerSlide: number): string {
  // The concat demuxer needs the final frame repeated so it applies its declared duration.
  return [...framePaths.map((path) => `file '${path.replaceAll("'", "'\\''")}'\nduration ${secondsPerSlide}`), `file '${framePaths.at(-1)!.replaceAll("'", "'\\''")}'`].join("\n");
}

function parseProbe(value: string | Buffer): { width: number; height: number; durationSeconds: number; hasAudio: boolean } {
  let parsed: unknown;
  try { parsed = JSON.parse(String(value)); } catch { throw new VideoRenderError("VIDEO_INSPECTION_FAILED"); }
  if (!parsed || typeof parsed !== "object") throw new VideoRenderError("VIDEO_INSPECTION_FAILED");
  const root = parsed as { streams?: unknown; format?: { duration?: unknown } };
  const streams = Array.isArray(root.streams) ? root.streams : [];
  const video = streams.find((stream): stream is { codec_type?: unknown; codec_name?: unknown; width?: number; height?: number } =>
    Boolean(stream && typeof stream === "object" && (stream as { codec_type?: unknown }).codec_type === "video"),
  );
  if (!video || video.codec_name !== "h264" || typeof video.width !== "number" || typeof video.height !== "number" || !Number.isInteger(video.width) || !Number.isInteger(video.height)) {
    throw new VideoRenderError("VIDEO_INSPECTION_FAILED");
  }
  const durationSeconds = Number(root.format?.duration);
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) throw new VideoRenderError("VIDEO_INSPECTION_FAILED");
  return {
    width: video.width,
    height: video.height,
    durationSeconds,
    hasAudio: streams.some((stream) => stream && typeof stream === "object" && (stream as { codec_type?: unknown }).codec_type === "audio"),
  };
}

export async function renderMp4(input: Readonly<{
  pages: readonly RenderedPage[];
  width: number;
  height: number;
  options: VideoExportOptions;
  audio?: Readonly<{ bytes: Buffer; extension: string }>;
  runner?: VideoCommandRunner;
}>): Promise<RenderedMp4> {
  if (input.pages.length === 0 || !Number.isInteger(input.width) || !Number.isInteger(input.height) || input.width < 1 || input.height < 1) {
    throw new VideoRenderError("VIDEO_RENDER_FAILED");
  }
  if ((input.audio === undefined) !== (input.options.audioAssetId === null)) throw new VideoRenderError("INVALID_OPTIONS");
  const directory = await mkdtemp(join(tmpdir(), "orincard-mp4-"));
  const runner = input.runner ?? createNodeVideoCommandRunner();
  try {
    const framePaths = await Promise.all(input.pages.map(async (page, index) => {
      const path = join(directory, `frame-${String(index + 1).padStart(4, "0")}.png`);
      await writeFile(path, page.bytes);
      return path;
    }));
    const listPath = join(directory, "frames.txt");
    const outputPath = join(directory, "orincard.mp4");
    await writeFile(listPath, concatList(framePaths, input.options.secondsPerSlide));
    const args = [
      "-hide_banner", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", listPath,
      ...(input.audio ? ["-stream_loop", "-1", "-i", join(directory, `audio.${input.audio.extension}`)] : []),
      "-map", "0:v:0",
      ...(input.audio ? ["-map", "1:a:0", "-shortest", "-c:a", "aac", "-b:a", "128k"] : []),
      "-fps_mode", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", outputPath,
    ];
    if (input.audio) await writeFile(join(directory, `audio.${input.audio.extension}`), input.audio.bytes);
    try { await runner("ffmpeg", args); } catch { throw new VideoRenderError("VIDEO_RENDER_FAILED"); }
    const bytes = await readFile(outputPath).catch(() => { throw new VideoRenderError("VIDEO_RENDER_FAILED"); });
    let inspected: { width: number; height: number; durationSeconds: number; hasAudio: boolean };
    try {
      const probe = await runner("ffprobe", ["-v", "error", "-show_entries", "format=duration:stream=codec_type,codec_name,width,height", "-of", "json", outputPath]);
      inspected = parseProbe(probe.stdout);
    } catch (error) {
      if (error instanceof VideoRenderError) throw error;
      throw new VideoRenderError("VIDEO_INSPECTION_FAILED");
    }
    if (inspected.width !== input.width || inspected.height !== input.height || inspected.hasAudio !== Boolean(input.audio)) {
      throw new VideoRenderError("VIDEO_INSPECTION_FAILED");
    }
    const expectedDuration = input.pages.length * input.options.secondsPerSlide;
    if (Math.abs(inspected.durationSeconds - expectedDuration) > 0.25) throw new VideoRenderError("VIDEO_INSPECTION_FAILED");
    return { bytes, ...inspected };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
