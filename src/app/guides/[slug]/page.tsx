import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { WorkspaceShell } from "@/components/workspace-shell";
import { ContentNotFoundError, readContent, type ContentBlock } from "@/server/content";

function Block({ block }: { readonly block: ContentBlock }) {
  if (block.kind === "heading") return block.level === 2 ? <h2>{block.text}</h2> : <h3>{block.text}</h3>;
  if (block.kind === "list") { const items = block.items.map((item) => <li key={item}>{item}</li>); return block.ordered ? <ol>{items}</ol> : <ul>{items}</ul>; }
  return <p>{block.text}</p>;
}

async function document(slug: string) {
  try { return await readContent("guide", slug); } catch (error) { if (error instanceof ContentNotFoundError) notFound(); throw error; }
}

export async function generateMetadata({ params }: { readonly params: Promise<{ readonly slug: string }> }): Promise<Metadata> {
  const content = await document((await params).slug);
  return { title: `${content.title} — Orincard Guides`, description: content.description };
}

export default async function GuideArticle({ params }: { readonly params: Promise<{ readonly slug: string }> }) {
  const content = await document((await params).slug);
  return <WorkspaceShell current="workspace" title="Guides"><article className="card stack-lg"><header><p className="eyebrow">Guide</p><h1>{content.title}</h1><p>{content.description}</p></header>{content.blocks.map((block, index) => <Block block={block} key={`${block.kind}-${index}`} />)}</article></WorkspaceShell>;
}
