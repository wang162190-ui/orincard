"use client";

import { useTranslations } from "next-intl";
import { use, useMemo, useState } from "react";
import Link from "next/link";
import { notFound, useRouter } from "next/navigation";
import templates from "../../../../../../content/templates.json";
import { WorkspacePage } from "@/components/workspace-page";
import { Button } from "@/components/ui";
import { parseCarouselDocument } from "@/domain/document";
import previews from "../../../../../../content/template-previews.json";

export default function TemplateDetailPage({ params }: { readonly params: Promise<{ readonly slug: string }> }) {
  const t = useTranslations("Templates");
  const { slug } = use(params);
  const template = templates.find((item) => item.slug === slug);
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const document = useMemo(() => template ? parseCarouselDocument(template.document) : null, [template]);
  if (!template || !document) notFound();
  const activeDocument = document;
  const preview = previews.find((item) => item.slug === slug);

  async function createCopy() {
    setBusy(true); setNotice("");
    const copy = { ...structuredClone(activeDocument), slides: activeDocument.slides.map((slide) => ({ ...slide, id: crypto.randomUUID(), revision: 1 })) };
    try {
      const response = await fetch("/api/v1/projects", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ document: copy }) });
      const body = await response.json();
      if (!response.ok || typeof body.data?.projectId !== "string") throw new Error(body.error?.message ?? t("copyFailed"));
      router.push(`/editor/${body.data.projectId}`);
    } catch (error) { setNotice(error instanceof Error ? error.message : t("copyFailed")); setBusy(false); }
  }

  return <WorkspacePage title={template.name}><div className="stack-lg"><header><p className="eyebrow">{template.category} · {document.platform}</p><h1>{template.name}</h1><p className="lead">{template.description}</p><div className="row"><Button disabled={busy} onClick={() => void createCopy()}>{busy ? t("creating") : t("use")}</Button><Link className="btn btn-secondary" href="/templates">{t("all")}</Link></div>{notice ? <p role="alert">{notice}</p> : null}</header><div className="template-detail"><section className="template-stage" aria-label={t("preview")}><div className="card"><img className="template-cover" src={preview?.thumbnail} alt={`${template.name} preview`} width="720" height="900" /><div className="filmstrip">{preview?.previews.map((src, index) => <button key={src} type="button" aria-pressed={index === 0}><img src={src} alt={t("page", { number: index + 1, role: document.slides[index]?.role ?? "content" })} width="120" height="150" /></button>)}</div></div></section><section className="card stack" aria-label={t("outline")}><h2>{t("outline")}</h2>{document.slides.map((slide, index) => <article key={slide.id} data-testid="template-slide"><p className="eyebrow">{t("page", { number: index + 1, role: slide.role })}</p><h3>{slide.title}</h3>{slide.bodyBlocks.map((block, blockIndex) => <p key={blockIndex}>{block.kind === "bullets" ? block.items.join(" · ") : block.text}</p>)}{slide.cta ? <p><strong>{slide.cta}</strong></p> : null}</article>)}</section></div></div></WorkspacePage>;
}
