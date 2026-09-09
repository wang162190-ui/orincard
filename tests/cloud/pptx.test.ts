import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import { EXPORT_FORMATS } from "../../src/render/render-deck";
import { PPTX_MIME, renderPptx } from "../../src/render/pptx";
import { packagePptxExport } from "../../src/server/export-package";

async function fixture(): Promise<CarouselDocument> {
  return JSON.parse(await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8")) as CarouselDocument;
}

function richDocument(source: CarouselDocument): CarouselDocument {
  const document = structuredClone(source);
  document.brandSnapshot = {
    kitId: "local-kit-01", kitVersion: 1, name: "Orincard", displayName: "Ada Lovelace", website: "https://example.com",
    cta: "Follow Ada", colors: ["#F5F1E8", "#11110E", "#D64F38"], fontPairId: "source-serif-inter",
    logoAssetId: "local-asset-01", headshotAssetId: null, counterDefaults: { visible: true, style: "fraction" },
  };
  document.assetRefs = [{ id: "local-asset-01", kind: "upload", mimeType: "image/png", rightsStatus: "verified" }];
  document.slides[1]!.bodyBlocks = [
    { kind: "paragraph", text: "Editable paragraph", emphasisRanges: [{ start: 0, end: 8 }] },
    { kind: "bullets", items: ["Editable bullet one", "Editable bullet two"] },
    { kind: "quote", text: "Editable quotation", attribution: "Ada", sourceRefs: [{ sourceId: "local-source-01", segmentId: "local-segment-01", kind: "quote" }] },
  ];
  document.slides[1]!.mode = "text_image";
  document.slides[1]!.assetSlots = [{ slotId: "hero", assetId: "local-asset-01", fit: "cover", crop: { x: 0, y: 0, width: 1, height: 1 }, opacity: 1, alt: "One pixel" }];
  return document;
}

const PIXEL = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLw5QAAAABJRU5ErkJggg==";

describe("T054 editable PPTX export (AC-006)", () => {
  it("writes native DrawingML text and ordered slides into a real PPTX", async () => {
    const document = richDocument(await fixture());
    const output = await renderPptx({ document, assets: { "local-asset-01": { id: "local-asset-01", src: PIXEL, state: "ready", alt: "One pixel", width: 1, height: 1 } } });
    const archive = await JSZip.loadAsync(output.bytes);
    const entries = Object.keys(archive.files).sort();
    expect(entries).toContain("[Content_Types].xml");
    expect(entries).toContain("ppt/presentation.xml");
    expect(entries.filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))).toHaveLength(document.slides.length);
    const slides = await Promise.all(document.slides.map((_, index) => archive.file(`ppt/slides/slide${index + 1}.xml`)!.async("string")));
    const text = slides.join("\n");
    for (const value of ["Make one useful point at a time", "Editable paragraph", "Editable bullet one", "“Editable quotation” — Ada", "Save this for your next carousel."]) {
      expect(text).toContain(`<a:t>${value}</a:t>`);
    }
    expect(text).toContain("<a:buChar");
    expect(output.slideIds).toEqual(document.slides.map((slide) => slide.id));
    expect(output.width).toBe(1080);
    expect(output.height).toBe(1350);
  }, 30_000);

  it("uses each supported platform geometry and packages private export metadata", async () => {
    const source = await fixture();
    const tiktok = { ...source, platform: "tiktok" as const };
    const output = await renderPptx({ document: tiktok, assets: {} });
    const archive = await JSZip.loadAsync(output.bytes);
    const presentation = await archive.file("ppt/presentation.xml")!.async("string");
    expect(output).toMatchObject({ width: 1080, height: 1920, slideIds: source.slides.map((slide) => slide.id) });
    expect(presentation).toContain('cx="10287000"');
    expect(presentation).toContain('cy="18288000"');
    const packaged = packagePptxExport({ ...output, documentHash: "a".repeat(64), rendererVersion: "b07-pptx-v1" });
    expect(packaged).toMatchObject({ filename: "orincard.pptx", mime: PPTX_MIME });
    expect(packaged.manifest).toMatchObject({ format: "pptx", pageCount: source.slides.length, documentHash: "a".repeat(64) });
    expect(JSON.stringify(packaged.manifest)).not.toContain(source.title);
    expect(EXPORT_FORMATS).toContain("pptx");
  }, 30_000);

  it("rejects invalid documents and unavailable selected assets", async () => {
    await expect(renderPptx({ document: { schemaVersion: 999 }, assets: {} })).rejects.toThrow("schema version");
    const document = richDocument(await fixture());
    await expect(renderPptx({ document, assets: {} })).rejects.toThrow("PPTX_ASSET_UNAVAILABLE");
  });
});
