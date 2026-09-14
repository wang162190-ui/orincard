import { describe, expect, it } from "vitest";
import { createDeepSeekResponsesAdapter, createDeepSeekResponsesClient } from "../../src/server/ai";
import { generateCarouselDocument } from "../../src/server/generation";
import type { SourceRecord } from "../../src/server/sources";

// S18 把语言从自由文本收成枚举，但枚举只保证「传进去的值合法」。
// 真正要证明的是 zh-Hans 这个值能让模型整份输出中文——这只能真的调一次供应商。
// 计费：一次生成，约 $0.01–0.05。默认跳过，靠 ORINCARD_RUN_GENERATION_CLOUD=1 开启。
const live = process.env.ORINCARD_RUN_GENERATION_CLOUD === "1";

const CJK = /[一-鿿]/;
const LATIN_WORD = /[A-Za-z]{4,}/;

const source = {
  id: "local-src-zh",
  ownerId: "user_live",
  kind: "text",
  metadata: { title: "Writing carousels" },
  segments: [
    {
      segmentId: "local-seg-1",
      text:
        "A carousel is not a chopped-up article. Each page should move the reader forward: lead with the conclusion, keep one idea per page, and replace abstract claims with concrete examples.",
    },
  ],
  state: "ready",
  expiresAt: "2026-12-31T00:00:00.000Z",
} as unknown as SourceRecord;

describe.skipIf(!live)("S18 live generation honours the language enum", () => {
  it("returns Simplified Chinese for zh-Hans from an English source", async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    expect(apiKey, "DEEPSEEK_API_KEY is required for the live language test").toBeTruthy();
    const ai = createDeepSeekResponsesAdapter(createDeepSeekResponsesClient(apiKey!));

    const generate = () => generateCarouselDocument({
      ai,
      source,
      options: {
        language: "zh-Hans",
        format: "carousel",
        pageCount: 6,
        instructions: "",
        templateId: "ink",
        platform: "instagram",
      },
    });
    const document = await generate().catch((error: unknown) => {
      console.error("[generation-language-live] validation issues", JSON.stringify((error as { details?: unknown }).details ?? error, null, 2));
      throw error;
    });

    expect(document.slides).toHaveLength(6);
    const text = document.slides
      .map((slide) =>
        [slide.eyebrow ?? "", slide.title ?? "", slide.cta ?? "",
          ...slide.bodyBlocks.map((block) => (block.kind === "bullets" ? block.items.join("") : block.text))].join(""),
      )
      .join("\n");
    console.info("[generation-language-live] zh-Hans output\n", text);

    // 源文是英文，所以「出现中文」本身就是语言指令生效的证据。
    expect(CJK.test(document.title)).toBe(true);
    for (const slide of document.slides) {
      expect(CJK.test(slide.title ?? ""), `slide ${slide.id} title is not Chinese: ${slide.title}`).toBe(true);
    }
    // 整句英文没被翻过来的情况要拦下：允许专有名词，但不允许成段英文。
    const latinRuns = text.match(/[A-Za-z][A-Za-z ,.'-]{24,}/g) ?? [];
    expect(latinRuns, `untranslated English runs: ${latinRuns.join(" | ")}`).toEqual([]);
    expect(LATIN_WORD.test(text) && !CJK.test(text)).toBe(false);
  }, 300_000);
});
