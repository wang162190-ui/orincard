import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { ContentNotFoundError, readContent, type ContentBlock } from "@/server/content";

const TITLES = { privacy: "Privacy", terms: "Terms", affiliate: "Affiliate policy" } as const;

function Block({ block }: { readonly block: ContentBlock }) {
  if (block.kind === "heading") return block.level === 2 ? <h2>{block.text}</h2> : <h3>{block.text}</h3>;
  if (block.kind === "list") { const items = block.items.map((item) => <li key={item}>{item}</li>); return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>; }
  return <p>{block.text}</p>;
}

async function legal(slug: string) { try { return await readContent("legal", slug); } catch (error) { if (error instanceof ContentNotFoundError) notFound(); throw error; } }

export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const slug = (await params).slug;
  if (!(slug in TITLES)) notFound();
  return { title: `${TITLES[slug as keyof typeof TITLES]} draft — Orincard`, robots: { index: false, follow: false } };
}

export default async function LegalPage({ params }: { readonly params: Promise<{ readonly slug: string }> }) {
  const slug = (await params).slug;
  if (!(slug in TITLES)) notFound();
  const content = await legal(slug);
  return <main className="marketing"><article className="card stack-lg"><header><p className="eyebrow">Legal draft</p><h1>{TITLES[slug as keyof typeof TITLES]}</h1><p role="status"><strong>Draft — not legally reviewed or approved for publication.</strong></p></header>{content.blocks.map((block, index) => <Block block={block} key={`${block.kind}-${index}`} />)}</article></main>;
}
