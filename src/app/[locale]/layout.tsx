import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/source-serif-4/wght.css";
import "@fontsource/noto-sans-sc/400.css";
// 700 也要装：中文标题是粗的，只有 400 时浏览器会合成伪粗体，和导出件对不上。
import "@fontsource/noto-sans-sc/700.css";
import { hasLocale, NextIntlClientProvider } from "next-intl";
import { getTranslations, setRequestLocale } from "next-intl/server";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { routing } from "@/i18n/routing";
import { publicMetadata } from "@/server/metadata";
import "@/styles/tokens.css";
import "@/components/ui.css";
import "@/styles/showcase.css";

type LocaleParams = { readonly params: Promise<{ readonly locale: string }> };

// 两种语言都在构建期预生成。没有这一条，每个页面都会退化成请求时渲染。
export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

export async function generateMetadata({ params }: LocaleParams) {
  const { locale } = await params;
  // 站点标题和描述是搜索结果里唯一露出的两行字，中文站挂英文描述等于白做本地化。
  // 这里用 getTranslations 而不是 useTranslations：generateMetadata 不是组件。
  const resolved = hasLocale(routing.locales, locale) ? locale : routing.defaultLocale;
  const t = await getTranslations({ locale: resolved, namespace: "Meta" });
  return {
    ...publicMetadata(
      {
        title: t("title"),
        description: t("description"),
        locale: resolved,
      },
    ),
    icons: {
      icon: "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%23141310' d='M2 9 6 5l5 6L22 3l-5 10 6 3-8 1-8 4 2-7z'/%3E%3C/svg%3E",
    },
  };
}

export default async function LocaleLayout({ children, params }: Readonly<{ children: ReactNode }> & LocaleParams) {
  const { locale } = await params;
  // 未注册的语言直接 404，不静默回落：`/fr/pricing` 若渲染出英文页，
  // 就等于凭空多出一批与 hreflang 对不上的可索引 URL。
  if (!hasLocale(routing.locales, locale)) notFound();
  setRequestLocale(locale);
  return (
    <html lang={locale}>
      <body>
        {/* locale 显式传入：客户端组件推断不出它，而消息仍从服务端配置继承。 */}
        <NextIntlClientProvider locale={locale}>{children}</NextIntlClientProvider>
      </body>
    </html>
  );
}
