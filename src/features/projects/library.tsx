"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Panel, PanelBody } from "@/components/ui";
import { Link } from "@/i18n/navigation";
import type { ProjectSummary } from "@/server/projects";

type FilterState = Readonly<{ query: string; platform: string; state: string }>;

function operationKey(operation: string): string {
  return `library-${operation}-${globalThis.crypto.randomUUID()}`;
}

export function ProjectLibrary({ initialProjects }: { readonly initialProjects: readonly ProjectSummary[] }) {
  const t = useTranslations("Projects");
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
      if (!response.ok) throw new Error(body.error?.message ?? t("loadFailed"));
      setProjects(body.data?.projects ?? []);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("loadFailed"));
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
      if (!response.ok) throw new Error(body.error?.message ?? t(operation === "duplicate" ? "duplicateFailed" : "archiveFailed"));
      setMessage(t(operation === "duplicate" ? "duplicated" : "archived"));
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : t("operationFailed"));
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
        <p className="eyebrow">{t("eyebrow")}</p>
        <div className="row-between wrap">
          <div>
            <h1 style={{ fontSize: 34 }}>{t("heading")}</h1>
            <p className="lead" style={{ marginTop: 8, fontSize: 16 }}>{t("lead")}</p>
          </div>
          <Link className="btn btn-primary" href="/create">{t("newCarousel")}</Link>
        </div>
      </header>

      <form className="row wrap" aria-label={t("filters")} onSubmit={(event) => { event.preventDefault(); void load(); }}>
        <label className="stack" style={{ gap: 4 }}>
          <span className="label">{t("search")}</span>
          <input aria-label={t("searchProjects")} value={filters.query} onChange={(event) => setFilters({ ...filters, query: event.target.value })} placeholder={t("searchPlaceholder")} />
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="label">{t("platform")}</span>
          <select aria-label={t("platform")} value={filters.platform} onChange={(event) => updateFilter("platform", event.target.value)}>
            <option value="">{t("allPlatforms")}</option><option value="linkedin">LinkedIn</option><option value="instagram">Instagram</option><option value="tiktok">TikTok</option>
          </select>
        </label>
        <label className="stack" style={{ gap: 4 }}>
          <span className="label">{t("status")}</span>
          <select aria-label={t("status")} value={filters.state} onChange={(event) => updateFilter("state", event.target.value)}>
            <option value="">{t("allStates")}</option><option value="draft">{t("stateDraft")}</option><option value="archived">{t("stateArchived")}</option>
          </select>
        </label>
        <Button type="submit" variant="secondary" disabled={loading} style={{ alignSelf: "end" }}>{t("search")}</Button>
      </form>

      <p className="meta" role="status" style={{ minHeight: 20, margin: 0 }}>{loading ? t("loading") : message}</p>
      {projects.length === 0 ? (
        <Panel><PanelBody><p style={{ margin: 0 }}>{t("empty")}</p></PanelBody></Panel>
      ) : (
        <div className="stack" data-testid="project-list">
          {projects.map((project) => (
            <Panel key={project.id} data-project-id={project.id}>
              <PanelBody>
                <div className="row-between wrap">
                  <div>
                    <h2 className="h3">{project.title}</h2>
                    <p className="meta" style={{ margin: "6px 0 0" }}>
                      {project.platform} · {project.state} · {t("updated")} <time dateTime={project.updatedAt}>{project.updatedAt.slice(0, 10)}</time>
                    </p>
                  </div>
                  <div className="row wrap">
                    <Link className="btn btn-secondary btn-sm" href={`/editor/${project.id}`}>{t("continueEditing")}</Link>
                    <Button size="small" variant="ghost" disabled={loading} onClick={() => void mutate(project, "duplicate")}>{t("duplicate")}</Button>
                    {project.state === "draft" ? <Button size="small" variant="ghost" disabled={loading} onClick={() => void mutate(project, "archive")}>{t("archive")}</Button> : null}
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
