import { notFound } from "next/navigation";
import { setRequestLocale } from "next-intl/server";
import { hasLocale } from "next-intl";
import { routing } from "@/i18n/routing";

// 未匹配任何路由的 URL 的落点。没有它，`/no-such-page` 根本进不了 `[locale]` 段，
// 于是 `[locale]/not-found.tsx` 不生效，用户看到的是 Next 原生 404。
//
// 静态段优先于 catch-all，所以已有的 23 条路由一条都不受影响；`/api/**` 与 `/auth/**`
// 不在 `[locale]` 下，`src/proxy.ts` 的 NON_LOCALIZED_PREFIXES 也已把它们排除在
// 语言协商之外，不会被这里吃掉。
type Params = { readonly params: Promise<{ readonly locale: string }> };

export default async function CatchAllNotFound({ params }: Params) {
  const { locale } = await params;
  // setRequestLocale 必须在 notFound() 之前：not-found.tsx 是服务端组件，
  // 拿不到请求 locale 就渲染不出对应语言的文案。
  if (hasLocale(routing.locales, locale)) setRequestLocale(locale);
  notFound();
}
