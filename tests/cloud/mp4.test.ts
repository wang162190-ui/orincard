import { execFile } from "node:child_process";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import { renderDeck } from "../../src/render/render-deck";
import { parseVideoExportOptions, probeVideoRuntime, renderMp4, VideoRenderError } from "../../src/render/video";
import { packageMp4Export } from "../../src/server/export-package";

const runFile = promisify(execFile);

async function fixture(): Promise<CarouselDocument> {
  return JSON.parse(await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8")) as CarouselDocument;
}

async function renderedPages() {
  const deck = await renderDeck({ document: await fixture(), assets: {}, formats: ["png_zip"] });
  expect(deck.failures).toEqual([]);
  return deck.outputs[0]!;
}

async function sineMp3(): Promise<Buffer> {
  const directory = await mkdtemp(join(tmpdir(), "orincard-mp4-test-"));
  const file = join(directory, "tone.mp3");
  try {
    await runFile("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1", "-q:a", "7", file]);
    return await readFile(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("T055 MP4 export (AC-006)", () => {
  it("detects the real ffmpeg and ffprobe runtime required by local and Trigger rendering", async () => {
    const runtime = await probeVideoRuntime();
    expect(runtime.ffmpegVersion).toMatch(/^ffmpeg version /);
    expect(runtime.ffprobeVersion).toMatch(/^ffprobe version /);
  });

  it("validates explicit slide duration and optional owned audio identifiers", () => {
    expect(parseVideoExportOptions(undefined)).toEqual({ secondsPerSlide: 3, audioAssetId: null });
    expect(parseVideoExportOptions({ secondsPerSlide: 5, audioAssetId: "11111111-1111-4111-8111-111111111111" })).toEqual({ secondsPerSlide: 5, audioAssetId: "11111111-1111-4111-8111-111111111111" });
    expect(() => parseVideoExportOptions({ secondsPerSlide: 0 })).toThrow(VideoRenderError);
    expect(() => parseVideoExportOptions({ audioAssetId: "untrusted-path" })).toThrow(VideoRenderError);
  });

  it("creates a real H.264 MP4 at platform dimensions with every slide duration and no audio", async () => {
    const pages = await renderedPages();
    const video = await renderMp4({
      pages: pages.pages,
      width: pages.width,
      height: pages.height,
      options: { secondsPerSlide: 2, audioAssetId: null },
    });
    expect(video.bytes.subarray(4, 8).toString("ascii")).toBe("ftyp");
    expect(video).toMatchObject({ width: 1080, height: 1350, hasAudio: false });
    expect(video.durationSeconds).toBeCloseTo(pages.pageCount * 2, 1);

    const packaged = await packageMp4Export({
      ...video,
      slideIds: pages.slideIds,
      documentHash: pages.documentHash,
      rendererVersion: "b07-v1",
    });
    expect(packaged).toMatchObject({ filename: "orincard.mp4", mime: "video/mp4" });
    expect(packaged.manifest).toMatchObject({ format: "mp4", pageCount: pages.pageCount, hasAudio: false });
  }, 60_000);

  it("loops an authorized audio file over the ordered deck without changing its duration", async () => {
    const pages = await renderedPages();
    const video = await renderMp4({
      pages: pages.pages,
      width: pages.width,
      height: pages.height,
      options: { secondsPerSlide: 1, audioAssetId: "11111111-1111-4111-8111-111111111111" },
      audio: { bytes: await sineMp3(), extension: "mp3" },
    });
    expect(video).toMatchObject({ width: 1080, height: 1350, hasAudio: true });
    expect(video.durationSeconds).toBeCloseTo(pages.pageCount, 1);
  }, 60_000);
});
