import { useTranslations } from "next-intl";
import { PublicFooter, PublicHeader } from "@/components/public-header";
import { Link } from "@/i18n/navigation";

// 放在 `[locale]` 段内而不是 `src/app/not-found.tsx`：根 404 拿不到 locale，也拿不到
// `[locale]/layout.tsx` 提供的 NextIntlClientProvider 与字体，只能渲染 Next 的原生页
// （实测 11.5 KB、零品牌标记）。配套的 `[locale]/[...rest]/page.tsx` 负责把未匹配的
// URL 也引进这一段，两者缺一不可。
export default function LocaleNotFound() {
  const t = useTranslations("NotFound");
  return (
    <>
      <PublicHeader />
      <main className="container" style={{ paddingBlock: "clamp(48px, 8vw, 96px)" }}>
        <section style={{ maxWidth: 640 }} className="stack">
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("title")}</h1>
          <p className="lead">{t("body")}</p>
          <div className="row wrap">
            <Link className="btn btn-primary" href="/">{t("backHome")}</Link>
            <Link className="btn btn-secondary" href="/templates">{t("browseTemplates")}</Link>
          </div>
        </section>
      </main>
      <PublicFooter />
    </>
  );
}
