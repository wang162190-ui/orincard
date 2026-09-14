import { defineRouting } from "next-intl/routing";

// docs/sdd/orincard/spec.md 第 12 节（2026-09-14 变更）：界面与生成内容支持 en 与 zh-Hans 两种语言，
// 两者都完整本地化。不做繁中/日文/阿拉伯语，因此不引入 RTL。
//
// localePrefix 用 'as-needed'：英文保持无前缀（`/pricing`），中文走 `/zh-Hans/pricing`。
// 这不是风格偏好——`src/server/metadata.ts` 的 publicMetadata 已经给每个公开页写了
// alternates.canonical，站点地图和 robots 也都按无前缀英文 URL 生成。改成 'always' 会让
// 所有已收录的英文 URL 一次性变成 301，且与既有 canonical 自相矛盾。
export const routing = defineRouting({
  locales: ["en", "zh-Hans"],
  defaultLocale: "en",
  localePrefix: "as-needed",
});

export type Locale = (typeof routing.locales)[number];

/**
 * 给一条**不带前缀**的路径套上 locale 前缀，规则与 `localePrefix: 'as-needed'` 一致。
 *
 * `('/pricing', 'en')` → `/pricing`（默认语言不加前缀）
 * `('/pricing', 'zh-Hans')` → `/zh-Hans/pricing`
 * `('/', 'zh-Hans')` → `/zh-Hans`（不是 `/zh-Hans/`）
 */
export function localizedPath(pathname: string, locale: Locale): string {
  if (locale === routing.defaultLocale) return pathname;
  return pathname === "/" ? `/${locale}` : `/${locale}${pathname}`;
}

/**
 * 去掉路径开头的 locale 段，还原成路由树里的真实路径。
 *
 * `/zh-Hans/billing` → `/billing`；`/billing` → `/billing`；`/zh-Hans` → `/`。
 * 只剥**已注册**的 locale：`/zh/billing` 里的 `zh` 不是我们的 locale，原样返回，
 * 免得把一个恰好同名的真实路由段吃掉。
 */
export function stripLocale(pathname: string): string {
  for (const locale of routing.locales) {
    if (pathname === `/${locale}`) return "/";
    if (pathname.startsWith(`/${locale}/`)) return pathname.slice(locale.length + 1);
  }
  return pathname;
}
