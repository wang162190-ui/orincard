import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { PublicFooter, PublicHeader } from "@/components/public-header";
import { Link } from "@/i18n/navigation";
import {
  ContentNotFoundError,
  readContent,
  type ContentBlock,
  type ContentLocale,
} from "@/server/content";

function Block({ block }: { readonly block: ContentBlock }) {
  if (block.kind === "heading") {
    return block.level === 2 ? <h2>{block.text}</h2> : <h3>{block.text}</h3>;
  }
  if (block.kind === "list") {
    const items = block.items.map((item) => <li key={item}>{item}</li>);
    return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
  }
  return <p>{block.text}</p>;
}

// 正文跟着 URL 里的语言段走；缺中文文件时 readContent 抛 ContentNotFoundError，
// 这里按 404 处理而不是回落英文——中文站挂着英文正文比 404 更难被发现。
async function document(slug: string, locale: string) {
  try {
    return await readContent("blog", slug, locale as ContentLocale);
  } catch (error) {
    if (error instanceof ContentNotFoundError) notFound();
    throw error;
  }
}

export async function generateMetadata({
  params,
}: {
  readonly params: Promise<{ readonly slug: string; readonly locale: string }>;
}): Promise<Metadata> {
  const { slug, locale } = await params;
  const content = await document(slug, locale);
  return { title: content.title, description: content.description };
}

export default async function BlogArticle({
  params,
}: {
  readonly params: Promise<{ readonly slug: string; readonly locale: string }>;
}) {
  const { slug, locale } = await params;
  const content = await document(slug, locale);
  const t = await getTranslations("Blog");

  return (
    <>
      <PublicHeader />
      <main className="container" style={{ paddingBlock: "clamp(48px, 8vw, 96px)" }}>
        <article className="stack-lg" style={{ maxWidth: 760 }}>
          <header className="stack">
            <p className="eyebrow">{t("eyebrow")}</p>
            <h1>{content.title}</h1>
            <p className="lead">{content.description}</p>
          </header>
          {content.blocks.map((block, index) => (
            <Block block={block} key={`${block.kind}-${index}`} />
          ))}
          <p>
            <Link href="/blog">{t("backToIndex")}</Link>
          </p>
        </article>
      </main>
      <PublicFooter />
    </>
  );
}
