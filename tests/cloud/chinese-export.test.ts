import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import { inspectDeckPreflight, renderDeck } from "../../src/render/render-deck";
import { renderPptx } from "../../src/render/pptx";
import { renderMp4 } from "../../src/render/video";
import { VISUAL_EXPORT_FORMATS } from "../../src/render/preflight";

// 阶段二完成判据的可复跑版本：一份中文六页 carousel 走完 PNG / JPG / PDF / PPTX / MP4，
// 产物落到 OUT 目录供肉眼确认（豆腐块、回退字体在断言里看不出来，必须人看）。
// 不调用任何 AI 供应商，纯渲染，$0。
const OUT = process.env.CHINESE_EXPORT_OUT ?? "/tmp/orincard-s18";

async function base(): Promise<CarouselDocument> {
  return JSON.parse(
    await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8"),
  ) as CarouselDocument;
}

const COPY = [
  { eyebrow: "写作", title: "一次只讲清一个有用的点", body: null, cta: null },
  { eyebrow: null, title: "轮播图不是把长文切成几段", body: "每一页都要把读者往前推一步。", cta: null },
  { eyebrow: "01", title: "先给结论，再讲理由", body: "读者划到第二页之前，已经知道你要说什么。", cta: null },
  { eyebrow: "02", title: "一页一个念头", body: "两个念头挤在一页，读者两个都记不住。", cta: null },
  { eyebrow: "03", title: "把抽象的话换成具体的例子", body: "「提升效率」没有信息量，「把三小时压到二十分钟」才有。", cta: null },
  { eyebrow: null, title: "现在去改你上一篇的第一页", body: "把结论提到最前面，其余顺序不动。", cta: "关注获取更多写作方法" },
];

async function chineseDeck(): Promise<CarouselDocument> {
  const document = await base();
  expect(document.slides.length, "fixture must supply six slides for this acceptance").toBe(COPY.length);
  return {
    ...document,
    title: "一次只讲清一个有用的点",
    slides: document.slides.map((slide, index) => {
      const copy = COPY[index]!;
      return {
        ...slide,
        mode: "text" as const,
        assetSlots: [],
        eyebrow: copy.eyebrow,
        title: copy.title,
        cta: copy.cta,
        bodyBlocks: copy.body ? [{ kind: "paragraph" as const, text: copy.body, emphasisRanges: [] }] : [],
      };
    }),
  };
}

describe("S18 阶段二 — Chinese carousel through all five export formats", () => {
  it("renders PNG / JPG / PDF / PPTX / MP4 and writes them out for visual review", async () => {
    await mkdir(OUT, { recursive: true });
    const document = await chineseDeck();

    // 先过预检：一份排得下的中文稿不该被任何规则挡住。
    const preflight = await inspectDeckPreflight({ document, assets: {} });
    expect(preflight.issues, "a well-fitting Chinese deck must clear preflight").toEqual([]);
    expect(preflight.ok).toBe(true);

    const deck = await renderDeck({ document, assets: {}, formats: ["png_zip", "jpg_zip", "pdf"] });
    expect(deck.failures).toEqual([]);
    const byFormat = new Map(deck.outputs.map((output) => [output.format, output]));

    const png = byFormat.get("png_zip")!;
    expect(png.pages).toHaveLength(6);
    for (const [index, page] of png.pages.entries()) {
      await writeFile(join(OUT, `slide-${index + 1}.png`), page.bytes);
    }
    const jpg = byFormat.get("jpg_zip")!;
    expect(jpg.pages).toHaveLength(6);
    for (const [index, page] of jpg.pages.entries()) {
      await writeFile(join(OUT, `slide-${index + 1}.jpg`), page.bytes);
    }
    const pdf = byFormat.get("pdf")!;
    expect(pdf.pdfPages).toBe(6);
    await writeFile(join(OUT, "deck.pdf"), pdf.pdf!);

    const pptx = await renderPptx({ document, assets: {} });
    expect(pptx.slideIds).toHaveLength(6);
    await writeFile(join(OUT, "deck.pptx"), pptx.bytes);

    const mp4 = await renderMp4({
      pages: png.pages,
      width: png.width,
      height: png.height,
      options: { secondsPerSlide: 3, audioAssetId: null },
    });
    expect(mp4.durationSeconds).toBeGreaterThanOrEqual(17);
    await writeFile(join(OUT, "deck.mp4"), mp4.bytes);
  }, 180_000);

  it("blocks all five formats on a Chinese overflow case", async () => {
    const document = await chineseDeck();
    // 超长中文标题：中文没有空格，断行规则和拉丁文不同，这一条正是只用英文用例测不出来的。
    const overflowing: CarouselDocument = {
      ...document,
      slides: document.slides.map((slide, index) =>
        index === 2
          ? { ...slide, title: "先给结论再讲理由".repeat(24) }
          : slide,
      ),
    };

    const preflight = await inspectDeckPreflight({ document: overflowing, assets: {} });
    expect(preflight.ok).toBe(false);
    // 指名道姓地断言是被改长的那一页溢出：只查「有 issue」的话，任何一条无关的
    // 字体或素材问题都能让这条用例假装通过。
    expect(preflight.issues.map((issue) => `${issue.slideId}:${issue.code}`)).toEqual([
      `${document.slides[2]!.id}:TEXT_OVERFLOW`,
    ]);
    // 阻断必须覆盖全部五种格式，而不是只挡住走浏览器渲染的那三种。
    expect([...VISUAL_EXPORT_FORMATS]).toEqual(["png", "jpg", "pdf", "pptx", "mp4"]);
  }, 120_000);
});
