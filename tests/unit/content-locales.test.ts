import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  CONTENT_LOCALES,
  contentFile,
  listContentEntries,
  parseTrustedMarkdown,
  readContent,
} from "../../src/server/content";

// 词条文件有 key 对齐断言（tests/unit/i18n-messages.test.ts），正文文件也需要同一层保护：
// 少一份中文 .mdx 不会让构建失败，只会让中文站上少一个页面或挂着英文正文。
const entries = listContentEntries();

describe("content catalogue is complete in every locale", () => {
  it.each(entries)("has a file for $kind/$slug in both locales", async ({ kind, slug }) => {
    for (const locale of CONTENT_LOCALES) {
      const path = contentFile(kind, slug, locale);
      const source = await readFile(resolve(process.cwd(), path), "utf8").catch(() => null);
      expect(source, `${path} is missing; ${locale} readers would get a 404 or English body.`).not.toBeNull();
      // 能读到还不够：坏掉的 frontmatter 或不支持的 Markdown 结构要在这里就炸，
      // 而不是等到某个用户第一次打开这个页面。
      expect(() => parseTrustedMarkdown(source as string, { kind, slug, locale })).not.toThrow();
    }
  });

  it("translates the title and description of every document", async () => {
    for (const { kind, slug } of entries) {
      const en = await readContent(kind, slug, "en");
      const zh = await readContent(kind, slug, "zh-Hans");
      expect(zh.title, `${kind}/${slug} zh-Hans title is still the English string.`).not.toBe(en.title);
      expect(zh.description, `${kind}/${slug} zh-Hans description is still the English string.`).not.toBe(
        en.description,
      );
      // 正文块数不要求逐块相等（中文段落可以合并或拆分），但空正文必须拦下。
      expect(zh.blocks.length, `${kind}/${slug} zh-Hans body is empty.`).toBeGreaterThan(0);
    }
  });

  it("keeps legal publication metadata identical across locales", async () => {
    for (const { kind, slug } of entries.filter((entry) => entry.kind === "legal")) {
      const en = await readContent(kind, slug, "en");
      const zh = await readContent(kind, slug, "zh-Hans");
      // 同一份政策的两个语言版本必须是同一个 policyVersion，否则「已审定」这件事
      // 会变成一份审定了、另一份没有，而页面上看不出区别。
      expect(zh.policyVersion, `${slug} policyVersion differs between locales.`).toBe(en.policyVersion);
      expect(zh.publicationStatus, `${slug} publicationStatus differs between locales.`).toBe(
        en.publicationStatus,
      );
      // contentHash 必须不同：它是逐字节算的，两份文字不同却同 hash 说明中文根本没翻。
      expect(zh.contentHash).not.toBe(en.contentHash);
    }
  });

  it("does not silently fall back to English when a locale file is missing", async () => {
    await expect(readContent("help", "getting-started", "zh-Hans")).resolves.toMatchObject({
      locale: "zh-Hans",
    });
    await expect(readContent("help", "no-such-article" as "getting-started", "zh-Hans")).rejects.toThrow();
  });
});
