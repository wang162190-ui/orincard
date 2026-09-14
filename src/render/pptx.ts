import PptxGenJS from "pptxgenjs";
import {
  getPlatformDimensions,
  parseCarouselDocument,
  type CarouselDocument,
} from "../domain/document";
import type { SlideRenderAsset } from "./slide";

const PX_PER_INCH = 96;
const PPTX_MIME = "application/vnd.openxmlformats-officedocument.presentationml.presentation";

export { PPTX_MIME };

export type RenderedPptx = {
  readonly bytes: Buffer;
  readonly width: number;
  readonly height: number;
  readonly slideIds: readonly string[];
};

type PptxSlide = CarouselDocument["slides"][number];

function inches(value: number): number {
  return value / PX_PER_INCH;
}

function hex(value: string | undefined, fallback: string): string {
  const candidate = value?.trim().replace(/^#/, "");
  return candidate && /^[0-9a-f]{6}$/i.test(candidate) ? candidate.toUpperCase() : fallback;
}

// PNG / PDF / MP4 都走浏览器渲染，字体栈里有 Noto Sans SC，中文正常。
// 只有 PPTX 是把字体名写进文件、由 PowerPoint 自己去找——写 "Inter" 的话，
// PowerPoint 对中文字符只能回落到它自己的默认 CJK 字体，出来的版式和预览对不上。
const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3000-\u303F\uFF00-\uFFEF]/;

export function deckHasCjk(document: CarouselDocument): boolean {
  return document.slides.some((slide) =>
    CJK.test(
      [
        slide.eyebrow ?? "",
        slide.title ?? "",
        slide.cta ?? "",
        ...slide.bodyBlocks.map((block) => (block.kind === "bullets" ? block.items.join("") : block.text)),
      ].join(""),
    ),
  );
}

function fontFace(fontPairId: string, display: boolean, cjk: boolean): string {
  // 中文一律走 Noto Sans SC：仓库里打包的就是它，导出件与预览用的是同一套字形。
  if (cjk) return "Noto Sans SC";
  if (fontPairId === "source-serif-inter") {
    return display ? "Source Serif 4" : "Inter";
  }
  return "Arial";
}

function textAlign(value: CarouselDocument["theme"]["alignment"]): "left" | "center" | "right" {
  return value;
}

function imageBox(slide: PptxSlide, width: number, height: number) {
  if (slide.mode === "image") return { x: 0, y: 0, w: width, h: height };
  if (slide.mode === "screenshot") return { x: width * 0.08, y: height * 0.18, w: width * 0.84, h: height * 0.44 };
  return { x: width * 0.08, y: height * 0.54, w: width * 0.84, h: height * 0.32 };
}

function addImages(
  pptxSlide: PptxGenJS.Slide,
  slide: PptxSlide,
  assets: Readonly<Record<string, SlideRenderAsset | undefined>>,
  width: number,
  height: number,
) {
  const box = imageBox(slide, width, height);
  for (const slot of slide.assetSlots) {
    const asset = assets[slot.assetId];
    if (!asset || asset.state !== "ready" || !asset.src.startsWith("data:")) {
      throw new Error("PPTX_ASSET_UNAVAILABLE");
    }
    pptxSlide.addImage({
      data: asset.src,
      altText: slot.alt || asset.alt,
      sizing: {
        type: slot.fit === "cover" ? "cover" : "contain",
        x: inches(box.x),
        y: inches(box.y),
        w: inches(box.w),
        h: inches(box.h),
      },
      transparency: Math.round((1 - slot.opacity) * 100),
    });
  }
}

function addBody(
  pptxSlide: PptxGenJS.Slide,
  slide: PptxSlide,
  input: {
    readonly bodyFont: string;
    readonly color: string;
    readonly align: "left" | "center" | "right";
    readonly width: number;
    readonly y: number;
  },
) {
  let y = input.y;
  for (const block of slide.bodyBlocks) {
    if (block.kind === "bullets") {
      for (const item of block.items) {
        pptxSlide.addText(item, {
          x: inches(input.width * 0.1), y: inches(y), w: inches(input.width * 0.8), h: inches(52),
          fontFace: input.bodyFont, fontSize: 17, color: input.color, align: input.align,
          bullet: true, breakLine: false, margin: 0,
        });
        y += 58;
      }
      continue;
    }
    const text = block.kind === "quote"
      ? `“${block.text}”${block.attribution ? ` — ${block.attribution}` : ""}`
      : block.text;
    pptxSlide.addText(text, {
      x: inches(input.width * 0.1), y: inches(y), w: inches(input.width * 0.8), h: inches(92),
      fontFace: input.bodyFont, fontSize: block.kind === "quote" ? 19 : 17, italic: block.kind === "quote",
      color: input.color, align: input.align, margin: 0, breakLine: false,
    });
    y += 104;
  }
}

export async function renderPptx(input: {
  readonly document: unknown;
  readonly assets: Readonly<Record<string, SlideRenderAsset | undefined>>;
}): Promise<RenderedPptx> {
  const document = parseCarouselDocument(input.document);
  const { width, height } = getPlatformDimensions(document.platform);
  const pptx = new PptxGenJS();
  const layout = `ORINCARD_${document.platform.toUpperCase()}`;
  pptx.defineLayout({ name: layout, width: inches(width), height: inches(height) });
  pptx.layout = layout;
  pptx.author = "Orincard";
  pptx.subject = "Editable carousel export";
  pptx.title = "Orincard carousel";
  const cjk = deckHasCjk(document);
  pptx.theme = { headFontFace: fontFace(document.theme.fontPairId, true, cjk), bodyFontFace: fontFace(document.theme.fontPairId, false, cjk) };

  const colors = document.theme.colors ?? [];
  const background = hex(document.theme.background.value, "FFFFFF");
  const foreground = hex(colors[1], "111111");
  const accent = hex(colors[2], foreground);
  const bodyFont = fontFace(document.theme.fontPairId, false, cjk);
  const titleFont = fontFace(document.theme.fontPairId, true, cjk);
  const align = textAlign(document.theme.alignment);

  document.slides.forEach((slide, index) => {
    const output = pptx.addSlide();
    output.background = { color: background };
    output.addShape(pptx.ShapeType.rect, {
      x: 0, y: 0, w: inches(width), h: inches(height), line: { color: background, transparency: 100 }, fill: { color: background },
    });
    addImages(output, slide, input.assets, width, height);
    if (slide.eyebrow) output.addText(slide.eyebrow, {
      x: inches(width * 0.1), y: inches(height * 0.1), w: inches(width * 0.8), h: inches(34),
      fontFace: bodyFont, fontSize: 11, bold: true, color: accent, align, charSpacing: 1.2, margin: 0,
    });
    if (slide.title) output.addText(slide.title, {
      x: inches(width * 0.1), y: inches(height * 0.17), w: inches(width * 0.8), h: inches(height * (slide.mode === "image" ? 0.26 : 0.22)),
      fontFace: titleFont, fontSize: 30 * document.theme.textScale, bold: true, color: foreground, align, margin: 0, fit: "shrink",
    });
    addBody(output, slide, { bodyFont, color: foreground, align, width, y: height * 0.42 });
    if (slide.cta) output.addText(slide.cta, {
      x: inches(width * 0.1), y: inches(height * 0.87), w: inches(width * 0.8), h: inches(42),
      fontFace: bodyFont, fontSize: 15, bold: true, color: accent, align, margin: 0,
    });
    if (slide.counterVisible && document.theme.counterStyle !== "none") output.addText(
      document.theme.counterStyle === "fraction" ? `${index + 1} / ${document.slides.length}` : String(index + 1),
      { x: inches(width * 0.85), y: inches(height * 0.93), w: inches(width * 0.08), h: inches(24), fontFace: bodyFont, fontSize: 9, color: foreground, align: "right", margin: 0 },
    );
    if (document.brandSnapshot && (slide.role === "intro" || slide.role === "outro")) {
      const brand = document.brandSnapshot;
      output.addText([
        { text: brand.displayName ?? brand.name, options: { bold: true } },
        ...(brand.website ? [{ text: `\n${brand.website}`, options: { breakLine: false } }] : []),
      ], {
        x: inches(width * 0.1), y: inches(height * 0.8), w: inches(width * 0.55), h: inches(58),
        fontFace: bodyFont, fontSize: 11, color: foreground, align, margin: 0,
      });
      const assetId = brand.headshotAssetId ?? brand.logoAssetId;
      const asset = assetId ? input.assets[assetId] : undefined;
      if (asset?.state === "ready" && asset.src.startsWith("data:")) {
        output.addImage({ data: asset.src, altText: asset.alt, sizing: { type: "contain", x: inches(width * 0.72), y: inches(height * 0.79), w: inches(width * 0.14), h: inches(width * 0.14) } });
      }
    }
  });

  const bytes = await pptx.write({ outputType: "nodebuffer", compression: true });
  if (!(bytes instanceof Uint8Array)) throw new Error("PPTX_WRITE_FAILED");
  return { bytes: Buffer.from(bytes), width, height, slideIds: document.slides.map((slide) => slide.id) };
}
