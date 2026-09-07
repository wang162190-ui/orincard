import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import {
  countPdfPages,
  inspectDeckPreflight,
  renderDeck,
  type DeckRenderDriver,
  type DeckRenderDriverInput,
} from "../../src/render/render-deck";
import { packageBasicExport } from "../../src/server/export-package";
import { validateExportTaskPayload } from "../../src/trigger/export";

async function fixture(): Promise<CarouselDocument> {
  return JSON.parse(
    await readFile(
      new URL("../fixtures/base-document.json", import.meta.url),
      "utf8",
    ),
  ) as CarouselDocument;
}

describe("T034 basic visual export (AC-004, AC-006)", () => {
  it("installs licensed font packages in the Trigger image", async () => {
    const config = await readFile(new URL("../../trigger.config.ts", import.meta.url), "utf8");
    expect(config).toContain("additionalPackages");
    expect(config).toContain('"@fontsource-variable/inter"');
    expect(config).toContain('"@fontsource-variable/source-serif-4"');
    expect(config).toContain('"@fontsource/noto-sans-sc"');
  });

  it("produces real PNG, JPG, and PDF bytes with local Chromium", async () => {
    const document = await fixture();
    const rendered = await renderDeck({
      document,
      assets: {},
      formats: ["png_zip", "jpg_zip", "pdf"],
    });

    expect(rendered.failures).toEqual([]);
    const png = rendered.outputs.find((output) => output.format === "png_zip");
    const jpg = rendered.outputs.find((output) => output.format === "jpg_zip");
    const pdf = rendered.outputs.find((output) => output.format === "pdf");
    expect(png?.pages[0]?.bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(png?.pages[0]?.bytes.readUInt32BE(16)).toBe(1080);
    expect(png?.pages[0]?.bytes.readUInt32BE(20)).toBe(1350);
    expect(jpg?.pages[0]?.bytes.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]));
    expect(pdf?.pdf?.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(countPdfPages(pdf!.pdf!)).toBe(document.slides.length);
    expect(png?.inspectedHtml).toContain("@font-face");
    expect(png?.inspectedHtml).toContain("font-family:Inter Variable");
    expect(png?.inspectedHtml).toContain("font-family:Source Serif 4 Variable");

    const packaged = await packageBasicExport({
      ...png!,
      rendererVersion: "b04-v1",
    });
    const zip = await JSZip.loadAsync(packaged.bytes);
    expect(Object.keys(zip.files).sort()).toEqual([
      ...document.slides.map((_, index) => `${String(index + 1).padStart(2, "0")}.png`),
      "manifest.json",
    ]);
  }, 30_000);

  it("runs real font, image, and text measurements before rendering", async () => {
    const document = await fixture();
    const overflowing = structuredClone(document);
    overflowing.slides[1]!.bodyBlocks = [{
      kind: "paragraph",
      text: "Long content ".repeat(2_000),
      emphasisRanges: [],
    }];
    const result = await inspectDeckPreflight({ document: overflowing, assets: {} });
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TEXT_OVERFLOW", slideId: overflowing.slides[1]!.id }),
    ]));
    expect(result.issues.some((issue) => issue.code === "FONT_NOT_READY")).toBe(false);
  }, 30_000);

  it("renders every fixed-revision slide in order at the platform dimensions", async () => {
    const document = await fixture();
    const driver: DeckRenderDriver = {
      render: vi.fn(async ({ format, html, slides, width, height }: DeckRenderDriverInput) => ({
        pages: format === "pdf"
          ? []
          : slides.map((slide, index) => ({
              slideId: slide.id,
              bytes: Buffer.from(`${format}:${index + 1}:${slide.id}`),
            })),
        pdf: format === "pdf" ? Buffer.from("%PDF-1.7 test") : undefined,
        pdfPages: format === "pdf" ? slides.length : undefined,
        inspectedHtml: html,
        width,
        height,
      })),
    };

    const rendered = await renderDeck({
      document,
      assets: {},
      formats: ["png_zip", "jpg_zip", "pdf"],
      driver,
    });

    expect(driver.render).toHaveBeenCalledTimes(3);
    expect(rendered.failures).toEqual([]);
    expect(rendered.outputs.map((output) => output.format)).toEqual([
      "png_zip",
      "jpg_zip",
      "pdf",
    ]);
    for (const output of rendered.outputs) {
      expect(output.width).toBe(1080);
      expect(output.height).toBe(1350);
      expect(output.slideIds).toEqual(document.slides.map((slide) => slide.id));
      expect(output.pageCount).toBe(document.slides.length);
      expect(output.inspectedHtml).not.toContain("sourceText");
    }
  });

  it("packages numbered image files and a PDF manifest without hidden source text", async () => {
    const document = await fixture();
    const image = await packageBasicExport({
      format: "png_zip",
      width: 1080,
      height: 1350,
      slideIds: document.slides.map((slide) => slide.id),
      pages: document.slides.map((slide, index) => ({
        slideId: slide.id,
        bytes: Buffer.from(`real-page-${index + 1}`),
      })),
      documentHash: "a".repeat(64),
      rendererVersion: "b04-v1",
    });
    const pdf = await packageBasicExport({
      format: "pdf",
      width: 1080,
      height: 1350,
      slideIds: document.slides.map((slide) => slide.id),
      pdf: Buffer.from("%PDF-1.7 real-pdf"),
      pdfPages: document.slides.length,
      documentHash: "a".repeat(64),
      rendererVersion: "b04-v1",
    });

    expect(image.filename).toBe("orincard-png.zip");
    expect(image.manifest.files.map((file) => file.name)).toEqual(
      document.slides.map((_, index) => `${String(index + 1).padStart(2, "0")}.png`),
    );
    expect(image.manifest.files.every((file) => /^[a-f0-9]{64}$/.test(file.sha256))).toBe(true);
    expect(pdf.filename).toBe("orincard.pdf");
    expect(pdf.manifest.pageCount).toBe(document.slides.length);
    expect(JSON.stringify(image.manifest)).not.toContain(document.title);
  });

  it("keeps a failed format isolated and accepts only reference-only task payloads", async () => {
    const document = await fixture();
    const rendered = await renderDeck({
      document,
      assets: {},
      formats: ["png_zip", "pdf"],
      driver: {
        async render(input) {
          if (input.format === "pdf") throw new Error("PDF renderer unavailable");
          return {
            pages: input.slides.map((slide) => ({
              slideId: slide.id,
              bytes: Buffer.from(slide.id),
            })),
            width: input.width,
            height: input.height,
            inspectedHtml: input.html,
          };
        },
      },
    });

    expect(rendered.outputs).toHaveLength(1);
    expect(rendered.outputs[0]?.format).toBe("png_zip");
    expect(rendered.failures).toEqual([
      { format: "pdf", code: "RENDER_FAILED", retryable: true },
    ]);
    expect(
      validateExportTaskPayload({
        jobId: "11111111-1111-4111-8111-111111111111",
        schemaVersion: 1,
        requestId: "request-1",
      }),
    ).toEqual({
      jobId: "11111111-1111-4111-8111-111111111111",
      schemaVersion: 1,
      requestId: "request-1",
    });
    expect(() =>
      validateExportTaskPayload({
        jobId: "11111111-1111-4111-8111-111111111111",
        schemaVersion: 1,
        requestId: "request-1",
        document,
      }),
    ).toThrow("reference-only");
  });
});
