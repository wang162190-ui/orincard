"use client";

import Link from "next/link";
import { useState } from "react";
import { Button, Panel, PanelBody } from "@/components/ui";
import type { ProjectSummary } from "@/server/projects";

type FilterState = Readonly<{ query: string; platform: string; state: string }>;

function operationKey(operation: string): string {
  return `library-${operation}-${globalThis.crypto.randomUUID()}`;
}

export function ProjectLibrary({ initialProjects }: { readonly initialProjects: readonly ProjectSummary[] }) {
  const [projects, setProjects] = useState(initialProjects);
  const [filters, setFilters] = useState<FilterState>({ query: "", platform: "", state: "" });
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState("");

  async function load(next: FilterState = filters) {
    setLoading(true);
    setMessage("");
    const search = new URLSearchParams();
    if (next.query.trim()) search.set("q", next.query.trim());
    if (next.platform) search.set("platform", next.platform);
    if (next.state) search.set("state", next.state);
    try {
      const response = await fetch(`/api/v1/projects?${search}`, { cache: "no-store" });
      const body = await response.json() as { data?: { projects?: ProjectSummary[] }; error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? "Projects could not be loaded.");
      setProjects(body.data?.projects ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Projects could not be loaded.");
    } finally {
      setLoading(false);
    }
  }

  async function mutate(project: ProjectSummary, operation: "duplicate" | "archive") {
    setLoading(true);
    setMessage("");
    try {
      const response = await fetch(`/api/v1/projects/${project.id}/${operation}`, {
        method: "POST",
        headers: { "content-type": "application/json", "idempotency-key": operationKey(operation) },
        body: JSON.stringify({ expectedRevision: project.revision }),
      });
      const body = await response.json() as { error?: { message?: string } };
      if (!response.ok) throw new Error(body.error?.message ?? `Project could not be ${operation}d.`);
      setMessage(operation === "duplicate" ? "Project copy created." : "Project archived.");
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "The project operation failed.");
      setLoading(false);
    }
  }

  const updateFilter = (key: keyof FilterState, value: string) => {
    const next = { ...filters, [key]: value };
    setFilters(next);
    if (key !== "query") void load(next);
  };

  return (
    <div className="stack" style={{ maxWidth: 1040 }}>
      <header>
        <p className="eyebrow">Project library</p>
        <div className="row-between wrap">
          <div>
            <h1 style={{ fontSize: 34 }}>Your projects</h1>
            <p className="lead" style={{ marginTop: 8, fontSize: 16 }}>Find a recent carousel, make a copy, or continue editing.</p>
          </div>
          <Link className="btn btn-primary" href="/create">New carousel</Link>
        </div>
      </header>

      <form className="row wrap" aria-label="Project filters" onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="label">Search</span>
          <input aria-label="Search projects" value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} placeholder="Project title" />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="label">Platform</span>
          <select aria-label="Platform" value={filters.platform} onChange={(event) => updateFilter("platform", event.target.value)}>
            <option value="">All platforms</option><option value="linkedin">LinkedIn</option><option value="instagram">Instagram</option><option value="tiktok">TikTok</option>
          </select>
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="label">Status</span>
          <select aria-label="Status" value={filters.state} onChange={(event) => updateFilter("state", event.target.value)}>
            <option value="">Active and archived</option><option value="draft">Active</option><option value="archived">Archived</option>
          </select>
        </label>
        <Button type="submit" variant="secondary" disabled={loading} style={{ alignSelf: "end" }}>Search</Button>
      </form>

      <p className="meta" role="status" style={{ minHeight: 20, margin: 0 }}>{loading ? "Loading projects…" : message}</p>
      {projects.length === 0 ? (
        <Panel><PanelBody><p style={{ margin: 0 }}>No projects match these filters.</p></PanelBody></Panel>
      ) : (
        <div className="stack" data-testid="project-list">
          {projects.map((project) => (
            <Panel key={project.id} data-project-id={project.id}>
              <PanelBody>
                <div className="row-between wrap">
                  <div>
                    <h2 className="h3">{project.title}</h2>
                    <p className="meta" style={{ margin: "6px 0 0" }}>
                      {project.platform} · {project.state} · Updated <time dateTime={project.updatedAt}>{project.updatedAt.slice(0, 10)}</time>
                    </p>
                  </div>
                  <div className="row wrap">
                    <Link className="btn btn-secondary btn-sm" href={`/editor/${project.id}`}>Continue editing</Link>
                    <Button size="small" variant="ghost" disabled={loading} onClick={() => void mutate(project, "duplicate")}>Duplicate</Button>
                    {project.state === "draft" ? <Button size="small" variant="ghost" disabled={loading} onClick={() => void mutate(project, "archive")}>Archive</Button> : null}
                  </div>
                </div>
              </PanelBody>
            </Panel>
          ))}
        </div>
      )}
    </div>
  );
}
