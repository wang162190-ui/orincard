import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { chromium } from "playwright";
import {
  getPlatformDimensions,
  parseCarouselDocument,
  type CarouselDocument,
} from "../domain/document";
import {
  SlideRenderer,
  type SlideRenderAsset,
} from "./slide";

export const BASIC_EXPORT_FORMATS = ["png_zip", "jpg_zip", "pdf"] as const;
export type BasicExportFormat = (typeof BASIC_EXPORT_FORMATS)[number];

export type RenderedPage = {
  readonly slideId: string;
  readonly bytes: Buffer;
};

export type DeckDriverResult = {
  readonly pages: readonly RenderedPage[];
  readonly pdf?: Buffer;
  readonly pdfPages?: number;
  readonly inspectedHtml: string;
  readonly width: number;
  readonly height: number;
};

export type DeckRenderDriverInput = {
  readonly format: BasicExportFormat;
  readonly html: string;
  readonly slides: CarouselDocument["slides"];
  readonly width: number;
  readonly height: number;
};

export interface DeckRenderDriver {
  render(input: DeckRenderDriverInput): Promise<DeckDriverResult>;
}

export type RenderedDeckOutput = DeckDriverResult & {
  readonly format: BasicExportFormat;
  readonly documentHash: string;
  readonly slideIds: readonly string[];
  readonly pageCount: number;
};

export type RenderDeckResult = {
  readonly outputs: readonly RenderedDeckOutput[];
  readonly failures: readonly {
    readonly format: BasicExportFormat;
    readonly code: "RENDER_FAILED";
    readonly retryable: true;
  }[];
};

function assertLocalAssets(
  assets: Readonly<Record<string, SlideRenderAsset | undefined>>,
): void {
  for (const asset of Object.values(assets)) {
    if (asset && !asset.src.startsWith("data:") && !asset.src.startsWith("file:")) {
      throw new Error("Export assets must be downloaded and verified before rendering.");
    }
  }
}

async function deckHtml(
  document: CarouselDocument,
  assets: Readonly<Record<string, SlideRenderAsset | undefined>>,
  width: number,
  height: number,
): Promise<string> {
  const slideCss = await readFile(new URL("./slide.css", import.meta.url), "utf8");
  const slides = document.slides.map((slide, index) =>
    renderToStaticMarkup(
      createElement(
        "section",
        { className: "orincard-export-page", "data-export-slide-id": slide.id },
        createElement(SlideRenderer, {
          input: {
            slide,
            platform: document.platform,
            theme: document.theme,
            brandSnapshot: document.brandSnapshot,
            assets,
            slideNumber: index + 1,
            slideCount: document.slides.length,
          },
        }),
      ),
    ),
  );
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}
.orincard-export-page{width:${width}px;height:${height}px;overflow:hidden;break-after:page;page-break-after:always}
.orincard-export-page:last-child{break-after:auto;page-break-after:auto}
.orincard-export-page>.orincard-slide{width:100%;height:100%;border-radius:0}
@page{size:${width}px ${height}px;margin:0}
${slideCss}
</style></head><body>${slides.join("")}</body></html>`;
}

export const chromiumDeckRenderDriver: DeckRenderDriver = {
  async render(input) {
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage({
        viewport: { width: input.width, height: input.height },
        deviceScaleFactor: 1,
      });
      await page.setContent(input.html, { waitUntil: "load" });
      await page.evaluate(async () => {
        await document.fonts.ready;
        await Promise.all(
          Array.from(document.images).map((image) =>
            image.complete
              ? Promise.resolve()
              : new Promise<void>((resolve, reject) => {
                  image.addEventListener("load", () => resolve(), { once: true });
                  image.addEventListener("error", () => reject(new Error("image decode failed")), { once: true });
                }),
          ),
        );
      });

      if (input.format === "pdf") {
        const pdf = await page.pdf({
          width: `${input.width}px`,
          height: `${input.height}px`,
          printBackground: true,
          margin: { top: "0", right: "0", bottom: "0", left: "0" },
        });
        return {
          pages: [],
          pdf,
          pdfPages: input.slides.length,
          inspectedHtml: input.html,
          width: input.width,
          height: input.height,
        };
      }

      const pages: RenderedPage[] = [];
      const locator = page.locator("[data-export-slide-id]");
      for (let index = 0; index < input.slides.length; index += 1) {
        const bytes = await locator.nth(index).screenshot(
          input.format === "jpg_zip"
            ? { type: "jpeg", quality: 92 }
            : { type: "png" },
        );
        pages.push({ slideId: input.slides[index]!.id, bytes });
      }
      return {
        pages,
        inspectedHtml: input.html,
        width: input.width,
        height: input.height,
      };
    } finally {
      await browser.close();
    }
  },
};

export async function renderDeck(input: {
  readonly document: unknown;
  readonly assets: Readonly<Record<string, SlideRenderAsset | undefined>>;
  readonly formats: readonly BasicExportFormat[];
  readonly driver?: DeckRenderDriver;
}): Promise<RenderDeckResult> {
  const document = parseCarouselDocument(input.document);
  assertLocalAssets(input.assets);
  const formats = [...new Set(input.formats)];
  if (formats.length === 0 || formats.some((format) => !BASIC_EXPORT_FORMATS.includes(format))) {
    throw new Error("At least one supported basic export format is required.");
  }
  const { width, height } = getPlatformDimensions(document.platform);
  const html = await deckHtml(document, input.assets, width, height);
  const documentHash = createHash("sha256")
    .update(JSON.stringify(document))
    .digest("hex");
  const driver = input.driver ?? chromiumDeckRenderDriver;
  const outputs: RenderedDeckOutput[] = [];
  const failures: RenderDeckResult["failures"][number][] = [];

  for (const format of formats) {
    try {
      const output = await driver.render({
        format,
        html,
        slides: document.slides,
        width,
        height,
      });
      const pageCount = format === "pdf" ? output.pdfPages : output.pages.length;
      if (pageCount !== document.slides.length) {
        throw new Error("Rendered page count does not match the fixed project version.");
      }
      if (
        format !== "pdf" &&
        output.pages.some((page, index) => page.slideId !== document.slides[index]?.id)
      ) {
        throw new Error("Rendered slide order does not match the fixed project version.");
      }
      outputs.push({
        ...output,
        format,
        documentHash,
        slideIds: document.slides.map((slide) => slide.id),
        pageCount,
      });
    } catch {
      failures.push({ format, code: "RENDER_FAILED", retryable: true });
    }
  }
  return { outputs, failures };
}
