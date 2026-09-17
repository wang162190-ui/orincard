import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { notFound } from "next/navigation";
import { PublicFooter, PublicHeader } from "@/components/public-header";
import { ContentNotFoundError, readContent, type ContentBlock, type ContentLocale } from "@/server/content";

// 标题来自词条文件，正文来自 content/<locale>/legal/*（S17 起两种语言各一份）。
const TITLE_KEYS = { privacy: "privacy", terms: "terms", affiliate: "affiliate" } as const;

function Block({ block }: { readonly block: ContentBlock }) {
  if (block.kind === "heading") return block.level === 2 ? <h2>{block.text}</h2> : <h3>{block.text}</h3>;
  if (block.kind === "list") { const items = block.items.map((item) => <li key={item}>{item}</li>); return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>; }
  return <p>{block.text}</p>;
}

async function legal(slug: string, locale: string) { try { return await readContent("legal", slug, locale as ContentLocale); } catch (error) { if (error instanceof ContentNotFoundError) notFound(); throw error; } }

export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string; readonly locale: string }> }): Promise<Metadata> {
  const { slug, locale } = await params;
  if (!(slug in TITLE_KEYS)) notFound();
  const t = await getTranslations("Legal");
  const name = t(TITLE_KEYS[slug as keyof typeof TITLE_KEYS]);
  // 草稿才 noindex。正文签成 approved 之后还继续挂 noindex，等于生效条款搜不到，
  // 而且页面标题里仍写着「草稿」——那才是误导。状态由正文的 frontmatter 说了算。
  const draft = (await legal(slug, locale)).publicationStatus !== "approved";
  return draft
    ? { title: t("metaTitle", { name }), robots: { index: false, follow: false } }
    : { title: t("metaTitlePublished", { name }) };
}

export default async function LegalPage({ params }: { readonly params: Promise<{ readonly slug: string; readonly locale: string }> }) {
  const { slug, locale } = await params;
  if (!(slug in TITLE_KEYS)) notFound();
  const t = await getTranslations("Legal");
  const content = await legal(slug, locale);
  const draft = content.publicationStatus !== "approved";
  // 法务页原来是光秃秃一个 main，落到这个 URL 的人没有任何返回入口。
  return <><PublicHeader /><main className="marketing"><article className="card stack-lg"><header><p className="eyebrow">{draft ? t("eyebrow") : t("eyebrowPublished")}</p><h1>{t(TITLE_KEYS[slug as keyof typeof TITLE_KEYS])}</h1>{draft ? <p role="status"><strong>{t("draftNotice")}</strong></p> : <p role="status">{t("versionNotice", { version: content.policyVersion ?? "" })}</p>}</header>{content.blocks.map((block, index) => <Block block={block} key={`${block.kind}-${index}`} />)}</article></main><PublicFooter /></>;
}
