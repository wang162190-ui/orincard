import { NextRequest, NextResponse } from "next/server";
import { describe, expect, it, vi } from "vitest";
import { routing, stripLocale } from "../../src/i18n/routing";
import { handleProxyRequest, shouldLocalize } from "../../src/proxy";

const SESSION = "sb-orincard-auth-token";

function request(path: string, cookies: Readonly<Record<string, string>> = {}) {
  const value = new NextRequest(new URL(path, "https://orincard.test"));
  for (const [name, cookie] of Object.entries(cookies)) value.cookies.set(name, cookie);
  return value;
}

/** 模拟 Supabase 轮换 refresh token：读到旧值，写回新值。 */
function rotating(next: string) {
  return async (handlers: Parameters<Parameters<typeof handleProxyRequest>[1]["refreshSession"]>[0]) => {
    handlers.getAll();
    handlers.setAll([{ name: SESSION, value: next, options: { httpOnly: true, path: "/" } }]);
  };
}

const idle = async () => {};

describe("S12 语言协商与会话刷新的组合", () => {
  // 本步的判据。next-intl 在语言协商时会返回 307，轮换后的 cookie 必须写在**那个** response 上。
  it("keeps a rotated session cookie on the locale redirect", async () => {
    const redirect = NextResponse.redirect(new URL("https://orincard.test/zh-Hans/pricing"), 307);
    const response = await handleProxyRequest(request("/pricing", { [SESSION]: "old-token" }), {
      isPreview: false,
      handleLocale: () => redirect,
      refreshSession: rotating("rotated-token"),
    });

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toBe("https://orincard.test/zh-Hans/pricing");
    expect(response.cookies.get(SESSION)?.value).toBe("rotated-token");
  });

  it("keeps a rotated session cookie on the locale rewrite", async () => {
    const rewrite = NextResponse.rewrite(new URL("https://orincard.test/en/pricing"));
    const response = await handleProxyRequest(request("/pricing"), {
      isPreview: false,
      handleLocale: () => rewrite,
      refreshSession: rotating("rotated-token"),
    });

    expect(response.headers.get("x-middleware-rewrite")).toContain("/en/pricing");
    expect(response.cookies.get(SESSION)?.value).toBe("rotated-token");
  });

  // Supabase 必须在 next-intl 之前跑：刷新出来的 cookie 要先写回 request，
  // 语言协商和下游 Server Component 才读得到刷新后的会话，而不是上一跳的旧值。
  it("refreshes the session before the locale middleware reads the request", async () => {
    const seen: (string | undefined)[] = [];
    await handleProxyRequest(request("/pricing", { [SESSION]: "old-token" }), {
      isPreview: false,
      handleLocale: (value) => {
        seen.push(value.cookies.get(SESSION)?.value);
        return NextResponse.next({ request: value });
      },
      refreshSession: rotating("rotated-token"),
    });
    expect(seen).toEqual(["rotated-token"]);
  });

  it("passes a request through untouched when nothing needs refreshing", async () => {
    const handleLocale = vi.fn(() => NextResponse.next());
    const response = await handleProxyRequest(request("/pricing"), { isPreview: false, handleLocale, refreshSession: idle });
    expect(handleLocale).toHaveBeenCalledOnce();
    expect(response.cookies.getAll()).toEqual([]);
  });
});

describe("S12 哪些路径不参与语言协商", () => {
  // 把 /api 交给 next-intl 会被改写成 /en/api/v1/...，48 条 API 路由一次性 404。
  it.each(["/api", "/api/v1/projects", "/auth/callback", "/robots.txt", "/sitemap.xml"])(
    "never rewrites %s",
    async (path) => {
      const handleLocale = vi.fn(() => NextResponse.redirect(new URL("https://orincard.test/en" + path)));
      const response = await handleProxyRequest(request(path), { isPreview: false, handleLocale, refreshSession: rotating("rotated-token") });
      expect(handleLocale).not.toHaveBeenCalled();
      expect(response.headers.get("location")).toBeNull();
      // 但它们仍然要拿到刷新后的会话 —— 不参与语言协商不等于不刷新会话。
      expect(response.cookies.get(SESSION)?.value).toBe("rotated-token");
      expect(shouldLocalize(path)).toBe(false);
    },
  );

  it.each(["/", "/pricing", "/zh-Hans/pricing", "/billing", "/apifoo"])("localizes %s", (path) => {
    expect(shouldLocalize(path)).toBe(true);
  });
});

describe("S12 私有路由在带 locale 前缀时仍然 noindex", () => {
  async function robots(path: string, isPreview = false) {
    const response = await handleProxyRequest(request(path), { isPreview, handleLocale: () => NextResponse.next(), refreshSession: idle });
    return response.headers.get("X-Robots-Tag");
  }

  // 这是计划里点名的静默失效：isPrivateRoute 按前缀精确匹配，
  // `/zh-Hans/billing` 匹配不上 `/billing`，中文账单页会悄悄变成可索引。
  it.each(["/billing", "/zh-Hans/billing", "/zh-Hans/settings", "/zh-Hans/projects/abc"])("marks %s noindex", async (path) => {
    expect(await robots(path)).toBe("noindex, nofollow");
  });

  it.each(["/pricing", "/zh-Hans/pricing", "/zh-Hans"])("leaves %s indexable in production", async (path) => {
    expect(await robots(path)).toBeNull();
  });

  it("marks every page noindex on preview", async () => {
    expect(await robots("/zh-Hans/pricing", true)).toBe("noindex, nofollow");
  });
});

describe("S12 locale 段剥离", () => {
  it("strips only registered locales", () => {
    expect(stripLocale("/zh-Hans/billing")).toBe("/billing");
    expect(stripLocale("/zh-Hans")).toBe("/");
    expect(stripLocale("/billing")).toBe("/billing");
    // `zh` 不是注册的 locale，不能当成前缀吃掉——否则一个同名真实路由段会被吞。
    expect(stripLocale("/zh/billing")).toBe("/zh/billing");
    expect(stripLocale("/enterprise")).toBe("/enterprise");
  });

  it("declares exactly the two approved locales", () => {
    expect([...routing.locales]).toEqual(["en", "zh-Hans"]);
    expect(routing.defaultLocale).toBe("en");
    // 'as-needed'：英文保持无前缀，已收录的英文 URL 与既有 canonical 都不变。
    expect(routing.localePrefix).toBe("as-needed");
  });
});
