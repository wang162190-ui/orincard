import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { PublicFooter, PublicHeader } from "@/components/public-header";
import { Link } from "@/i18n/navigation";
import { listContent, readContent, type ContentLocale } from "@/server/content";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("Blog");
  return { title: t("metaTitle"), description: t("lead") };
}

export default async function BlogIndex({
  params,
}: {
  readonly params: Promise<{ readonly locale: string }>;
}) {
  const { locale } = await params;
  const t = await getTranslations("Blog");
  // 列表要标题和摘要，而这两样只存在文章的 frontmatter 里，所以这里逐篇读。
  // 种子只有 3 篇，列表页是静态的；等文章多到这里成为瓶颈，再抽一层索引也不迟。
  const articles = await Promise.all(
    listContent("blog").map((slug) => readContent("blog", slug, locale as ContentLocale)),
  );

  return (
    <>
      <PublicHeader />
      <main className="container" style={{ paddingBlock: "clamp(48px, 8vw, 96px)" }}>
        <section style={{ maxWidth: 760 }}>
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1>{t("headline")}</h1>
          <p className="lead" style={{ marginTop: 20 }}>
            {t("lead")}
          </p>
        </section>
        <section aria-label={t("listLabel")} className="card-grid" style={{ marginTop: 48 }}>
          {articles.map((article) => (
            <article className="card stack" key={article.slug}>
              <h2 className="h3">{article.title}</h2>
              <p>{article.description}</p>
              <Link className="btn btn-secondary" href={`/blog/${article.slug}`}>
                {t("readArticle")}
              </Link>
            </article>
          ))}
        </section>
      </main>
      <PublicFooter />
    </>
  );
}
