import { describe, expect, it } from "vitest";
import { localizedPath, routing } from "../../src/i18n/routing";
import { isPrivateRoute, localeAlternates, privateRouteDisallowList, publicMetadata } from "../../src/server/metadata";

const ENVIRONMENT = { NEXT_PUBLIC_APP_URL: "https://orincard.test" } as const;

describe("S13 私有路由在带 locale 前缀时仍然私有", () => {
  it.each(["/billing", "/zh-Hans/billing", "/zh-Hans/settings", "/zh-Hans/projects/abc", "/zh-Hans/api/v1/x"])(
    "treats %s as private",
    (path) => expect(isPrivateRoute(path)).toBe(true),
  );

  it.each(["/", "/pricing", "/zh-Hans", "/zh-Hans/pricing", "/zh-Hans/help/getting-started", "/templates"])(
    "treats %s as public",
    (path) => expect(isPrivateRoute(path)).toBe(false),
  );

  // robots.txt 只写 `/billing/` 的话，`/zh-Hans/billing/` 不受任何约束。
  it("disallows every private prefix in every locale", () => {
    const disallow = privateRouteDisallowList();
    expect(disallow).toContain("/billing/");
    expect(disallow).toContain("/zh-Hans/billing/");
    expect(disallow).toHaveLength(14 * routing.locales.length);
  });
});

describe("S13 hreflang", () => {
  it("points每种语言到它自己的 URL，x-default 落在英文", () => {
    expect(localeAlternates("/pricing", ENVIRONMENT)).toEqual({
      en: "https://orincard.test/pricing",
      "zh-Hans": "https://orincard.test/zh-Hans/pricing",
      "x-default": "https://orincard.test/pricing",
    });
  });

  it("keeps the root path clean", () => {
    expect(localizedPath("/", "en")).toBe("/");
    expect(localizedPath("/", "zh-Hans")).toBe("/zh-Hans");
    expect(localeAlternates("/", ENVIRONMENT)["zh-Hans"]).toBe("https://orincard.test/zh-Hans");
  });

  // canonical 必须跟随当前语言。若中文页把 canonical 指回英文 URL，
  // hreflang 说「这两页互为语言版本」而 canonical 说「中文页不是正本」，两者自相矛盾。
  it("makes canonical follow the rendered locale", () => {
    expect(publicMetadata({ title: "t", description: "d", path: "/pricing" }, ENVIRONMENT).alternates?.canonical)
      .toBe("https://orincard.test/pricing");
    expect(publicMetadata({ title: "t", description: "d", path: "/pricing", locale: "zh-Hans" }, ENVIRONMENT).alternates?.canonical)
      .toBe("https://orincard.test/zh-Hans/pricing");
  });

  it("ships the alternates on every public page", () => {
    const metadata = publicMetadata({ title: "t", description: "d", path: "/templates", locale: "zh-Hans" }, ENVIRONMENT);
    expect(metadata.alternates?.languages).toMatchObject({ en: "https://orincard.test/templates" });
    expect(metadata.robots).toEqual({ index: true, follow: true });
  });

  it("still hides everything on preview", () => {
    const metadata = publicMetadata({ title: "t", description: "d" }, { ...ENVIRONMENT, VERCEL_ENV: "preview" });
    expect(metadata.robots).toEqual({ index: false, follow: false });
  });
});
