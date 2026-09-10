import Link from "next/link";
import templates from "../../../content/templates.json";
import { WorkspaceShell } from "@/components/workspace-shell";

export default function TemplatesPage() {
  return <WorkspaceShell current="workspace" title="Templates"><div className="stack-lg"><header><p className="eyebrow">Original layouts</p><h1>Carousel templates</h1><p className="lead">Start with a clear structure, then make every word and style your own.</p></header><div className="card-grid" data-testid="template-list">{templates.map((template) => <article className="card stack" key={template.slug}><p className="eyebrow">{template.category} · {template.document.platform}</p><h2>{template.name}</h2><p>{template.description}</p><p className="meta">{template.document.slides.length} editable pages</p><div><Link className="btn btn-primary" href={`/templates/${template.slug}`}>View template</Link></div></article>)}</div></div></WorkspaceShell>;
}
