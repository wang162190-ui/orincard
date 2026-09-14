import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ContentNotFoundError, readContent, type ContentBlock, type ContentLocale } from "@/server/content";

function Block({ block }: { readonly block: ContentBlock }) {
  if (block.kind === "heading") return block.level === 2 ? <h2>{block.text}</h2> : <h3>{block.text}</h3>;
  if (block.kind === "list") {
    const items = block.items.map((item) => <li key={item}>{item}</li>);
    return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>;
  }
  return <p>{block.text}</p>;
}

// 正文跟着 URL 里的语言段走。没有这个参数，中文页会一直渲染英文正文。
async function document(slug: string, locale: string) {
  try { return await readContent("help", slug, locale as ContentLocale); } catch (error) { if (error instanceof ContentNotFoundError) notFound(); throw error; }
}

export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string; readonly locale: string }> }): Promise<Metadata> {
  const { slug, locale } = await params;
  const content = await document(slug, locale);
  const t = await getTranslations("Help");
  return { title: t("metaTitle", { title: content.title }), description: content.description };
}

export default async function HelpArticle({ params }: { readonly params: Promise<{ readonly slug: string; readonly locale: string }> }) {
  const { slug, locale } = await params;
  const content = await document(slug, locale);
  const t = await getTranslations("Help");
  return <WorkspaceShell current="workspace" title={t("shellTitle")}><article className="card stack-lg"><header><p className="eyebrow">{t("eyebrow")}</p><h1>{content.title}</h1><p>{content.description}</p></header>{content.blocks.map((block, index) => <Block block={block} key={`${block.kind}-${index}`} />)}</article></WorkspaceShell>;
}
