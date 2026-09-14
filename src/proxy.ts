import { createServerClient } from "@supabase/ssr";
import createIntlMiddleware from "next-intl/middleware";
import { type NextRequest, NextResponse } from "next/server";
import { routing, stripLocale } from "./i18n/routing";
import { readBrowserEnvironment } from "./server/environment";
import { isPrivateRoute } from "./server/metadata";

type RefreshedCookie = { readonly name: string; readonly value: string; readonly options?: Record<string, unknown> };

/**
 * 不参与语言协商的路径。这些不是页面，没有 `[locale]` 变体：
 * `/api/**` 是 48 条 API 路由，`/auth/callback` 是 Supabase 的 OAuth 回调，
 * `/robots.txt` 与 `/sitemap.xml` 由 `src/app/robots.ts` / `sitemap.ts` 生成。
 *
 * 它们**仍然要走会话刷新**（所以不能靠 matcher 把整条请求排除掉），只是不能被
 * 改写成 `/en/api/v1/...` —— 那会让整套 API 一次性 404。
 */
export const NON_LOCALIZED_PREFIXES = ["/api", "/auth", "/robots.txt", "/sitemap.xml"] as const;

export function shouldLocalize(pathname: string): boolean {
  return !NON_LOCALIZED_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`));
}

type ProxyDependencies = {
  /** 刷新会话。实现方通过 setAll 交回需要写给浏览器的 cookie。 */
  readonly refreshSession: (handlers: {
    readonly getAll: () => { name: string; value: string }[];
    readonly setAll: (cookies: readonly RefreshedCookie[]) => void;
  }) => Promise<void>;
  /** 语言协商。可能返回 next()、rewrite() 或 redirect()。 */
  readonly handleLocale: (request: NextRequest) => NextResponse;
  readonly isPreview: boolean;
};

/**
 * 会话刷新与语言协商的组合。**顺序是有意的，不能调换。**
 *
 * Supabase 先跑：它可能轮换 refresh token，并且要把新值写回 `request.cookies`，
 * 这样紧接着运行的 next-intl 以及下游的 Server Component 读到的是刷新后的会话。
 *
 * next-intl 后跑，然后把刷新出来的 cookie **写到它产出的那个 response 上**。
 * 这一条是整步的要害：next-intl 在语言协商时经常返回 307 redirect（例如带
 * `NEXT_LOCALE` cookie 的用户访问 `/pricing` 会被送去 `/zh-Hans/pricing`）。
 * 如果这时另起一个 `NextResponse.next()` 写 cookie，redirect 就丢了；反过来，
 * 如果直接返回 next-intl 的 response 而不补 cookie，**轮换后的 token 就在这一跳里蒸发，
 * 用户一切语言就掉登录**——正是本步判据要防的故障。
 */
export async function handleProxyRequest(request: NextRequest, dependencies: ProxyDependencies): Promise<NextResponse> {
  const refreshed: RefreshedCookie[] = [];
  await dependencies.refreshSession({
    getAll: () => request.cookies.getAll(),
    setAll: (cookies) => {
      for (const cookie of cookies) {
        request.cookies.set(cookie.name, cookie.value);
        refreshed.push(cookie);
      }
    },
  });

  const response = shouldLocalize(request.nextUrl.pathname)
    ? dependencies.handleLocale(request)
    : NextResponse.next({ request });
  for (const cookie of refreshed) {
    response.cookies.set(cookie.name, cookie.value, cookie.options);
  }

  // 私有路由判定必须先剥掉 locale 段，否则 `/zh-Hans/billing` 匹配不上 `/billing`，
  // 中文账单页的 noindex 会静默失效。
  if (dependencies.isPreview || isPrivateRoute(stripLocale(request.nextUrl.pathname))) {
    response.headers.set("X-Robots-Tag", "noindex, nofollow");
  }
  return response;
}

const handleLocale = createIntlMiddleware(routing);

export async function proxy(request: NextRequest) {
  const environment = readBrowserEnvironment(process.env);
  return handleProxyRequest(request, {
    isPreview: process.env.VERCEL_ENV === "preview",
    handleLocale,
    refreshSession: async (handlers) => {
      const client = createServerClient(environment.supabaseUrl, environment.supabasePublishableKey, {
        cookies: { getAll: handlers.getAll, setAll: (cookies) => handlers.setAll(cookies) },
      });
      await client.auth.getUser();
    },
  });
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)",
  ],
};
