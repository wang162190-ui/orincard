import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { createElement } from "react";
import { prerender } from "react-dom/static";
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
import fontManifestJson from "./font-manifest.json" with { type: "json" };

export const BASIC_EXPORT_FORMATS = ["png_zip", "jpg_zip", "pdf"] as const;
export type BasicExportFormat = (typeof BASIC_EXPORT_FORMATS)[number];
export const EXPORT_FORMATS = [...BASIC_EXPORT_FORMATS, "pptx", "mp4"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

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

// Seeding createRequire with a run-time path stops Turbopack from recognising the
// pattern and rewriting the resolved specifiers into bundle module ids, which
// readFile cannot open. The fonts must come off disk so their hashes stay verifiable.
const require = createRequire(join(process.cwd(), "package.json"));

async function loadExportFont(
  id: string,
  packageJsonPath: string,
): Promise<{ readonly entry: { readonly style: string; readonly weight: string }; readonly bytes: Buffer }> {
  const manifest = fontManifestJson as {
    readonly fonts: readonly {
      readonly id: string;
      readonly packageVersion: string;
      readonly file: string;
      readonly sha256: string;
      readonly style: string;
      readonly weight: string;
    }[];
  };
  const entry = manifest.fonts.find((font) => font.id === id);
  if (!entry) throw new Error(`FONT_NOT_DECLARED: ${id}`);
  const packageJson = JSON.parse(await readFile(packageJsonPath, "utf8")) as { readonly version?: string };
  if (packageJson.version !== entry.packageVersion) throw new Error(`FONT_PACKAGE_VERSION_MISMATCH: ${id}`);
  const bytes = await readFile(join(dirname(packageJsonPath), entry.file));
  if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
    throw new Error(`FONT_HASH_MISMATCH: ${id}`);
  }
  return { entry, bytes };
}

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
  const [slideCss, inter, serif, noto, notoBold] = await Promise.all([
    // Bundlers rewrite import.meta.url to the entry module, which in the deployed
    // Trigger worker resolved to src/trigger/. Anchor on the working directory so the
    // same path holds for the Next.js server and the worker container.
    readFile(join(process.cwd(), "src/render/slide.css"), "utf8"),
    loadExportFont("inter-latin-variable", require.resolve("@fontsource-variable/inter/package.json")),
    loadExportFont("source-serif-4-latin-variable", require.resolve("@fontsource-variable/source-serif-4/package.json")),
    loadExportFont("noto-sans-sc-simplified-400", require.resolve("@fontsource/noto-sans-sc/package.json")),
    // 中文标题是粗的。只嵌 400 的话浏览器会合成伪粗体，笔画糊成一团，
    // 而且和 PPTX 里真正的 Noto Sans SC Bold 对不上。
    loadExportFont("noto-sans-sc-simplified-700", require.resolve("@fontsource/noto-sans-sc/package.json")),
  ]);
  const fontCss = [
    ["Inter Variable", inter],
    ["Source Serif 4 Variable", serif],
    ["Noto Sans SC", noto],
    ["Noto Sans SC", notoBold],
  ].map(([family, font]) => {
    const loaded = font as Awaited<ReturnType<typeof loadExportFont>>;
    return `@font-face{font-family:${family};font-style:${loaded.entry.style};font-weight:${loaded.entry.weight};font-display:block;src:url(data:font/woff2;base64,${loaded.bytes.toString("base64")}) format("woff2")}`;
  }).join("\n");
  const slides = await Promise.all(document.slides.map(async (slide, index) => {
    const { prelude } = await prerender(
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
    );
    return new Response(prelude).text();
  }));
  return `<!doctype html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box}html,body{margin:0;padding:0;background:#fff}
.orincard-export-page{width:${width}px;height:${height}px;overflow:hidden;break-after:page;page-break-after:always}
.orincard-export-page:last-child{break-after:auto;page-break-after:auto}
.orincard-export-page>.orincard-slide{width:100%;height:100%;border-radius:0}
@page{size:${width}px ${height}px;margin:0}
${fontCss}
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
        const pdfPages = countPdfPages(pdf);
        return {
          pages: [],
          pdf,
          pdfPages,
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

export function countPdfPages(pdf: Buffer): number {
  if (pdf.subarray(0, 5).toString("ascii") !== "%PDF-") return 0;
  return pdf.toString("latin1").match(/\/Type\s*\/Page\b/g)?.length ?? 0;
}

export type DeckPreflightIssue = {
  readonly slideId: string;
  readonly code: "FONT_NOT_READY" | "ASSET_MISSING" | "ASSET_NOT_READY" | "TEXT_OVERFLOW" | "MEASUREMENT_FAILED";
  readonly repairAction: string;
};

export async function inspectDeckPreflight(input: {
  readonly document: unknown;
  readonly assets: Readonly<Record<string, SlideRenderAsset | undefined>>;
}): Promise<{ readonly ok: boolean; readonly issues: readonly DeckPreflightIssue[] }> {
  const document = parseCarouselDocument(input.document);
  assertLocalAssets(input.assets);
  const { width, height } = getPlatformDimensions(document.platform);
  const html = await deckHtml(document, input.assets, width, height);
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: "load" });
    const measured = await page.evaluate(async () => {
      await globalThis.document.fonts.ready;
      const fontsReady = ["Inter Variable", "Source Serif 4 Variable", "Noto Sans SC"]
        .every((family) => globalThis.document.fonts.check(`16px "${family}"`));
      return Array.from(globalThis.document.querySelectorAll<HTMLElement>("[data-slide-id]")).map((slide) => {
        const images = Array.from(slide.querySelectorAll<HTMLImageElement>("img[data-asset-id]"));
        const imagesReady = images.every((image) => image.complete && image.naturalWidth > 0);
        const measuredContent = Array.from(
          slide.querySelectorAll<HTMLElement>("[data-slide-content]"),
        ).filter((element) => element !== slide);
        return {
          slideId: slide.dataset.slideId ?? "",
          fontsReady,
          imagesReady,
          usable: measuredContent.length > 0 && measuredContent.every((element) => element.clientWidth > 0 && element.clientHeight > 0),
          overflow: measuredContent.some((element) =>
            element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
          ),
        };
      });
    });
    const issues: DeckPreflightIssue[] = [];
    for (const result of measured) {
      const slide = document.slides.find((item) => item.id === result.slideId);
      if (!slide) continue;
      if (!result.fontsReady) {
        issues.push({ slideId: slide.id, code: "FONT_NOT_READY", repairAction: "Wait for the selected font to finish loading, then retry." });
      }
      const requiredIds = [
        ...(slide.mode === "text" ? [] : slide.assetSlots.map((slot) => slot.assetId)),
        ...((slide.role === "intro" || slide.role === "outro")
          ? [document.brandSnapshot?.headshotAssetId ?? document.brandSnapshot?.logoAssetId]
          : []),
      ].filter((id): id is string => Boolean(id));
      if (slide.mode !== "text" && slide.assetSlots.length === 0) {
        issues.push({ slideId: slide.id, code: "ASSET_MISSING", repairAction: "Choose or upload an available image for this slide." });
      } else if (requiredIds.some((id) => !input.assets[id])) {
        issues.push({ slideId: slide.id, code: "ASSET_MISSING", repairAction: "Choose or upload an available image for this slide." });
      } else if (!result.imagesReady) {
        issues.push({ slideId: slide.id, code: "ASSET_NOT_READY", repairAction: "Wait for the image to finish loading, then retry." });
      }
      if (!result.usable) {
        issues.push({ slideId: slide.id, code: "MEASUREMENT_FAILED", repairAction: "Reload the slide preview, then retry the export check." });
      } else if (result.overflow) {
        issues.push({ slideId: slide.id, code: "TEXT_OVERFLOW", repairAction: "Shorten the text, split the slide, or choose a roomier layout." });
      }
    }
    return { ok: issues.length === 0, issues };
  } finally {
    await browser.close();
  }
}

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
