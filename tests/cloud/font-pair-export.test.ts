import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import fontManifest from "../../src/render/font-manifest.json";
import { FONT_PAIRS } from "../../src/render/font-pairs";
import { renderDeck, type DeckRenderDriver } from "../../src/render/render-deck";

/**
 * 导出件里的字体是**另一条**链路：编辑器加载 fontsource 的 CSS，而 render-deck.ts 自己拼
 * @font-face 把字体 base64 内联进导出 HTML。两条链路可以各错各的，而且错了都不报错——
 * 浏览器丢掉一条非法的 @font-face 之后只是安静地回退到栈里的下一个家族。
 *
 * 这一条就是这么来的：`@font-face{font-family:Source Serif 4 Variable;…}` 不加引号时是一串
 * CSS 标识符，而标识符不能以数字开头，于是 `4` 让整条规则作废，**所有衬线标题在导出件里都变成
 * 了中文回退字体 Noto Sans SC 的拉丁字形**。Inter / JetBrains Mono / Noto Sans SC 名字里没有
 * 数字，所以只有衬线这一套坏掉。
 *
 * 注意这里检的是 HTML 而不是像素：栈里每套配对的回退目标都不同，衬线坏掉之后三张图**依然互不
 * 相同**，靠比图是抓不住的。
 */
const OUT = process.env.FONT_PAIR_EXPORT_OUT ?? "/tmp/orincard-font-pairs";

const COPY = {
  eyebrow: "ORINCARD 手记",
  title: "Ship 3 in 20 minutes",
  body: "中英混排 mixed 2026 Q3 — Inter / Serif 4 / Mono。",
};

async function deckWithPair(fontPairId: string): Promise<CarouselDocument> {
  const base = JSON.parse(
    await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8"),
  ) as CarouselDocument;
  return {
    ...base,
    theme: { ...base.theme, fontPairId },
    slides: base.slides.map((slide) => ({
      ...slide,
      mode: "text" as const,
      assetSlots: [],
      eyebrow: COPY.eyebrow,
      title: COPY.title,
      cta: null,
      bodyBlocks: [{ kind: "paragraph" as const, text: COPY.body, emphasisRanges: [] }],
    })),
  };
}

/** Captures the HTML renderDeck hands the browser, without paying for a browser. */
function capturingDriver(): { driver: DeckRenderDriver; html: () => string } {
  let captured = "";
  return {
    html: () => captured,
    driver: {
      async render(input) {
        captured = input.html;
        return {
          pages: input.slides.map((slide) => ({ slideId: slide.id, bytes: Buffer.of(0) })),
          inspectedHtml: input.html,
          width: input.width,
          height: input.height,
        };
      },
    },
  };
}

/** Every family the exporter inlines, spelled the way the CSS `font-family` stacks spell it. */
const EXPORTED_FAMILIES = [
  ...new Set(
    fontManifest.fonts.map((font) =>
      font.package.startsWith("@fontsource-variable/") ? `${font.family} Variable` : font.family,
    ),
  ),
];

describe("font pairs reach the exported deck", () => {
  it.each(Object.keys(FONT_PAIRS))("%s declares a usable @font-face for every family", async (pairId) => {
    const { driver, html } = capturingDriver();
    const deck = await renderDeck({
      document: await deckWithPair(pairId),
      assets: {},
      formats: ["png_zip"],
      driver,
    });
    expect(deck.failures).toEqual([]);

    for (const family of EXPORTED_FAMILIES) {
      // 必须带引号。裸写的家族名一旦含数字开头的成分就是非法标识符，整条规则作废。
      expect(html(), `family ${family}`).toContain(`@font-face{font-family:"${family}"`);
    }
    // 配对自己点名的家族当然也得在里面——上面那条只保证「清单里的都在」。
    for (const role of [FONT_PAIRS[pairId]!.display, FONT_PAIRS[pairId]!.body]) {
      expect(EXPORTED_FAMILIES, `pair ${pairId}`).toContain(
        role.css.match(/^"([^"]+)"/)![1],
      );
    }
  }, 60_000);

  it("writes one real PNG per pair for a human to look at", async () => {
    await mkdir(OUT, { recursive: true });
    for (const pairId of Object.keys(FONT_PAIRS)) {
      const deck = await renderDeck({
        document: await deckWithPair(pairId),
        assets: {},
        formats: ["png_zip"],
      });
      expect(deck.failures, `pair ${pairId}`).toEqual([]);
      await writeFile(join(OUT, `${pairId}.png`), deck.outputs[0]!.pages[0]!.bytes);
    }
  }, 180_000);
});
