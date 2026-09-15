import { describe, expect, it } from "vitest";
import templates from "../../content/templates.json";
import messages from "../../messages/en.json";
import { parseCarouselDocument, platformKeys } from "../../src/domain/document";
import { THEME_IDS, previewAppearance } from "../../src/render/templates";
import { CATEGORY_ORDER } from "../../src/features/templates/catalog";

/**
 * `content/templates.json` 是手写 JSON，没有任何类型约束：写错一个 layoutId 或者
 * 把文案写长了，页面照常构建，只有用户点进去才会发现——模板是获客页，这种错误静默上线
 * 的代价特别高。这组测试就是那道闸。
 */
describe("content/templates.json", () => {
  it("ships more than one template per category", () => {
    expect(templates.length).toBeGreaterThanOrEqual(12);
  });

  it("uses unique slugs", () => {
    const slugs = templates.map((template) => template.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("uses url-safe slugs so sitemap entries stay stable", () => {
    for (const template of templates) {
      expect(template.slug, template.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    }
  });

  it.each(templates.map((template) => [template.slug, template] as const))(
    "%s parses as a carousel document",
    (slug, template) => {
      expect(() => parseCarouselDocument(template.document), slug).not.toThrow();
    },
  );

  // 真正值钱的一条：模板不只要能解析，还要**排得下**。任何一个模板带着 TEXT_CAPACITY_REVIEW
  // 或 ASSET_REQUIRED 上线，用户一进编辑器就看到一条警告，那是我们自己塞给他的。
  it.each(templates.map((template) => [template.slug, template] as const))(
    "%s renders without appearance conflicts",
    (slug, template) => {
      const document = parseCarouselDocument(template.document);
      const preview = previewAppearance(document, {});
      expect(preview.conflicts, `${slug}: ${JSON.stringify(preview.conflicts)}`).toEqual([]);
    },
  );

  it("declares a platform and palette the product actually ships", () => {
    for (const template of templates) {
      expect(platformKeys, template.slug).toContain(template.document.platform);
      expect(THEME_IDS, template.slug).toContain(template.document.templateId);
    }
  });

  it("covers every shipped platform and palette", () => {
    const platforms = new Set(templates.map((template) => template.document.platform));
    const palettes = new Set(templates.map((template) => template.document.templateId));

    expect([...platforms].sort()).toEqual([...platformKeys].sort());
    expect([...palettes].sort()).toEqual([...THEME_IDS].sort());
  });

  // 画廊按 CATEGORY_ORDER 分组渲染，不在表里的 category 会让模板整个消失在页面上——
  // 没有报错，没有空态，就是少一张卡片。所以分类拼写由这条守。
  it("only uses categories the gallery knows how to render", () => {
    for (const template of templates) {
      expect(CATEGORY_ORDER, template.slug).toContain(template.category);
    }
  });

  // 分类名是渲染出来的词条，不是 JSON 里那个英文字符串。少一条 zh-Hans 用户就看到 key。
  // （两份 catalog 的 key 一致性由 tests/unit/i18n-messages.test.ts 守，这里只查 en。）
  it("ships a label for every category", () => {
    const labelled = Object.keys(messages.Templates)
      .filter((key) => key.startsWith("category"))
      .map((key) => key.slice("category".length));

    expect(labelled.sort()).toEqual([...CATEGORY_ORDER].sort());
  });

  it("puts at least one template in every category the gallery offers", () => {
    const used = new Set(templates.map((template) => template.category));
    expect([...CATEGORY_ORDER].filter((category) => !used.has(category))).toEqual([]);
  });

  it("gives every template the fields the gallery renders", () => {
    for (const template of templates) {
      expect(template.name.length, template.slug).toBeGreaterThan(0);
      expect(template.description.length, template.slug).toBeGreaterThan(0);
      expect(template.category.length, template.slug).toBeGreaterThan(0);
      expect(template.document.slides.length, template.slug).toBeGreaterThanOrEqual(4);
    }
  });
});
