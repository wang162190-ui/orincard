import { getTranslations } from "next-intl/server";
import Link from "next/link";
import templates from "../../../../content/templates.json";
import { WorkspaceShell } from "@/components/workspace-shell";

export default async function TemplatesPage() {
  const t = await getTranslations("Templates");
  return <WorkspaceShell current="workspace" title={t("shellTitle")}><div className="stack-lg"><header><p className="eyebrow">{t("eyebrow")}</p><h1>{t("heading")}</h1><p className="lead">{t("lead")}</p></header><div className="card-grid" data-testid="template-list">{templates.map((template) => <article className="card stack" key={template.slug}><p className="eyebrow">{template.category} · {template.document.platform}</p><h2>{template.name}</h2><p>{template.description}</p><p className="meta">{t("editablePages", { count: template.document.slides.length })}</p><div><Link className="btn btn-primary" href={`/templates/${template.slug}`}>{t("view")}</Link></div></article>)}</div></div></WorkspaceShell>;
}
