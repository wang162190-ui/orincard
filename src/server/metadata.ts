import type { Metadata } from "next";
import { type Locale, localizedPath, routing, stripLocale } from "../i18n/routing";

export const PRIVATE_ROUTE_PREFIXES = [
  "/api", "/auth", "/billing", "/brand-kits", "/create", "/editor", "/exports",
  "/login", "/projects", "/reset-password", "/settings", "/signup", "/tools",
] as const;

export function siteOrigin(environment: Readonly<Record<string, string | undefined>> = process.env) {
  const value = environment.NEXT_PUBLIC_APP_URL?.trim();
  return value ? new URL(value).origin : "http://localhost:3000";
}

/**
 * 判定一条路径是否属于私有区。
 *
 * **先剥 locale 段再前缀匹配**：加了语言前缀之后 `/zh-Hans/billing` 匹配不上 `/billing`，
 * 账单页的 noindex 会静默失效——页面照常渲染，只是从此可被搜索引擎收录，不会有任何报错。
 */
export function isPrivateRoute(pathname: string) {
  const path = stripLocale(pathname);
  return PRIVATE_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** robots.txt 的 disallow 列表：每个私有前缀都要按语言各写一条，否则中文私有页不受约束。 */
export function privateRouteDisallowList(): string[] {
  return routing.locales.flatMap((locale) => PRIVATE_ROUTE_PREFIXES.map((path) => `${localizedPath(path, locale)}/`));
}

/** 一条公开路径的全部语言版本，键就是 hreflang 的值。 */
export function localeAlternates(path: string, environment?: Readonly<Record<string, string | undefined>>): Record<string, string> {
  const origin = siteOrigin(environment);
  const languages: Record<string, string> = {};
  for (const locale of routing.locales) {
    languages[locale] = new URL(localizedPath(path, locale), origin).toString();
  }
  // x-default 指向默认语言：搜索引擎拿不准用户语言时落到英文版，与 localePrefix: 'as-needed' 一致。
  languages["x-default"] = new URL(localizedPath(path, routing.defaultLocale), origin).toString();
  return languages;
}

export function publicMetadata(
  input: { readonly title: string; readonly description: string; readonly path?: string; readonly locale?: Locale },
  environment: Readonly<Record<string, string | undefined>> = process.env,
): Metadata {
  const preview = environment.VERCEL_ENV === "preview";
  const path = input.path ?? "/";
  const locale = input.locale ?? routing.defaultLocale;
  return {
    title: input.title,
    description: input.description,
    alternates: {
      // canonical 跟随当前语言：中文页的 canonical 指向中文 URL，否则两个语言版本
      // 互相指认对方是正本，hreflang 与 canonical 自相矛盾，搜索引擎会忽略整组声明。
      canonical: new URL(localizedPath(path, locale), siteOrigin(environment)).toString(),
      languages: localeAlternates(path, environment),
    },
    robots: preview ? { index: false, follow: false } : { index: true, follow: true },
  };
}
