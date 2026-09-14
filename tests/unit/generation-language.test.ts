import { describe, expect, it } from "vitest";
import { GENERATION_LANGUAGES, isGenerationLanguage } from "../../src/server/generation";
import { buildGenerationPrompt } from "../../src/server/prompts";
import type { SourceRecord } from "../../src/server/sources";

// S18 之前 language 是个 maxLength=80 的自由文本框。"中文" / "zh" / "Chinese, please"
// 都能提交，模型对每种写法的反应不一样，导出侧也没法据此判断该用哪套字体。
const source = {
  id: "src_1",
  ownerId: "user_1",
  kind: "text",
  metadata: { title: "Demo" },
  segments: [{ segmentId: "seg_1", text: "A short source paragraph." }],
  state: "ready",
  expiresAt: "2026-12-31T00:00:00.000Z",
} as unknown as SourceRecord;

describe("S18 generation language is an enum", () => {
  it("accepts exactly the two shipped locales", () => {
    expect([...GENERATION_LANGUAGES]).toEqual(["en", "zh-Hans"]);
    for (const language of GENERATION_LANGUAGES) expect(isGenerationLanguage(language)).toBe(true);
  });

  it.each([
    "中文",
    "zh",
    "zh-CN",
    "Chinese, please",
    "English",
    "",
    " en ",
    "EN",
    null,
    undefined,
    42,
    ["en"],
  ])("rejects free text %p", (value) => {
    expect(isGenerationLanguage(value)).toBe(false);
  });

  it("sends a full natural-language instruction, not the bare locale code", () => {
    // 传 "zh-Hans" 进 prompt 时模型有时把它当成一个无意义的标签而整份输出英文，
    // 所以这里断言的是替换后的指令文本，而不是「prompt 里包含 language 字段」。
    const zh = buildGenerationPrompt(source, {
      language: "zh-Hans",
      format: "carousel",
      pageCount: 6,
      instructions: "",
      templateId: "ink",
      platform: "instagram",
    });
    const zhRequirements = (JSON.parse(zh.input) as { requirements: { language: string } }).requirements;
    expect(zhRequirements.language).toContain("Simplified Chinese");
    expect(zhRequirements.language).not.toBe("zh-Hans");

    const en = buildGenerationPrompt(source, {
      language: "en",
      format: "carousel",
      pageCount: 6,
      instructions: "",
      templateId: "ink",
      platform: "instagram",
    });
    expect((JSON.parse(en.input) as { requirements: { language: string } }).requirements.language).toBe(
      "English",
    );
  });
});
