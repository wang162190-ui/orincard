import { describe, expect, it } from "vitest";
import en from "../../messages/en.json";
import zhHans from "../../messages/zh-Hans.json";

// 漏翻不会报错，只会让中文站悄悄渲染出英文（next-intl 在缺 key 时回退到 defaultLocale）。
// 所以「两份词条 key 集合完全一致」必须是断言，不能靠人工核对。
function flatten(value: unknown, prefix = ""): string[] {
  if (typeof value !== "object" || value === null) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flatten(child, prefix ? `${prefix}.${key}` : key),
  );
}

const enKeys = flatten(en).sort();
const zhKeys = flatten(zhHans).sort();

describe("message catalogs", () => {
  it("declares exactly the same keys in both locales", () => {
    const missingInZh = enKeys.filter((key) => !zhKeys.includes(key));
    const missingInEn = zhKeys.filter((key) => !enKeys.includes(key));
    // 分开断言：报错时直接读得出是哪一侧少了哪几条，而不是只看到两个大数组不相等。
    expect(missingInZh, "keys present in en.json but missing from zh-Hans.json").toEqual([]);
    expect(missingInEn, "keys present in zh-Hans.json but missing from en.json").toEqual([]);
    expect(zhKeys).toEqual(enKeys);
  });

  it("has no empty or whitespace-only values in either locale", () => {
    for (const [locale, catalog] of [["en", en], ["zh-Hans", zhHans]] as const) {
      const blank = flatten(catalog).filter((key) => {
        const value = key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], catalog);
        return typeof value !== "string" || value.trim().length === 0;
      });
      expect(blank, `blank entries in ${locale}.json`).toEqual([]);
    }
  });

  it("keeps ICU placeholders identical between locales", () => {
    // 中文译文漏掉一个 {progress} 不会崩，只会让用户看到一句永远停在同一状态的提示。
    const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const read = (catalog: unknown, key: string) =>
      key.split(".").reduce<unknown>((node, part) => (node as Record<string, unknown>)[part], catalog) as string;
    const mismatched = enKeys.filter(
      (key) => placeholders(read(en, key)).join(",") !== placeholders(read(zhHans, key)).join(","),
    );
    expect(mismatched, "keys whose ICU placeholders differ between en and zh-Hans").toEqual([]);
  });
});
