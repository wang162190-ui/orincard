// vitest 里没有 Next 的请求作用域，`next-intl/server` 会解析到抛错的 react-client 桩，
// 于是任何用 getTranslations 的 Server Component 都渲染不了。
//
// 这里只补上请求上下文，词条仍旧从真实的 messages/*.json 里读 —— 断言验的是词条文件的内容，
// 不是 mock 的返回值。key 打错、漏翻，用例照样红。
export async function createIntlServerStub() {
  return {
    setRequestLocale: () => {},
    getTranslations: async (options?: { locale?: string; namespace?: string } | string) => {
      const { locale, namespace } = typeof options === "string"
        ? { locale: "en", namespace: options }
        : { locale: options?.locale ?? "en", namespace: options?.namespace };
      const file = locale === "zh-Hans"
        ? await import("../../messages/zh-Hans.json")
        : await import("../../messages/en.json");
      const messages = file.default as Record<string, Record<string, string>>;
      const table = namespace ? messages[namespace] : undefined;
      return (key: string) => (table ? table[key] : key);
    },
  };
}
