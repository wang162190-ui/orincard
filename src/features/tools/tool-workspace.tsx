"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui";
import type { ToolId } from "@/domain/tools";
import { getToolDefinition } from "./registry";

function candidateText(candidate: unknown): string {
  if (!candidate || typeof candidate !== "object") return "";
  const value = candidate as { tool?: string; payload?: Record<string, unknown> };
  const payload = value.payload ?? {};
  if (value.tool === "caption") return [payload.text, Array.isArray(payload.hashtags) ? payload.hashtags.join(" ") : ""].filter(Boolean).join("\n\n");
  if (value.tool === "linkedin-post") return [payload.hook, payload.body, payload.cta, Array.isArray(payload.hashtags) ? payload.hashtags.join(" ") : ""].filter(Boolean).join("\n\n");
  if (value.tool === "post-ideas" && Array.isArray(payload.ideas)) return payload.ideas.map((idea, index) => `${index + 1}. ${String((idea as Record<string, unknown>).title ?? "")}\n${String((idea as Record<string, unknown>).angle ?? "")}`).join("\n\n");
  return "";
}

function requestInput(tool: ToolId, text: string) {
  if (tool === "post-ideas") return { topic: text, count: 5 };
  if (tool === "caption" || tool === "linkedin-post") return { text };
  if (tool === "quote-card") return { quote: text, attributionConfirmed: false };
  if (tool === "infographic") return { content: text };
  if (tool === "portrait") return { prompt: text, referenceAssetId: text };
  return { secondsPerSlide: 4 };
}

export function ToolWorkspace({ tool }: { readonly tool: ToolId }) {
  const t = useTranslations("ToolWorkspace");
  // 工具名归在 Tools 命名空间（工具列表页也用同一批 key），所以这里取第二个翻译函数。
  const toolName = useTranslations("Tools");
  const definition = getToolDefinition(tool);
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState("");
  const [revision, setRevision] = useState("");
  const [useTitle, setUseTitle] = useState(false);
  const [useCaption, setUseCaption] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<unknown>(null);
  const [notice, setNotice] = useState(t("idle"));
  const [confirmed, setConfirmed] = useState(false);
  const output = useMemo(() => candidateText(candidate), [candidate]);

  useEffect(() => {
    if (!jobId || candidate) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/v1/tools/${tool}?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? t("readFailed"));
        if (body.data.candidate) { setCandidate(body.data.candidate); setNotice(t("candidateReady")); }
        else if (body.data.state === "failed") { setJobId(null); setNotice(t("generationFailed")); }
        else setNotice(t("generatingProgress", { progress: body.data.progress }));
      }).catch((error) => setNotice(error instanceof Error ? error.message : t("readFailed")));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [candidate, jobId, t, tool]);

  async function generate() {
    setCandidate(null); setNotice(t("starting"));
    const context = projectId && revision && (useTitle || useCaption) ? { projectId, expectedRevision: Number(revision), fields: { title: useTitle || undefined, caption: useCaption || undefined } } : undefined;
    const response = await fetch(`/api/v1/tools/${tool}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ input: requestInput(tool, text), ...(context ? { context } : {}) }) });
    const body = await response.json();
    if (!response.ok) { setNotice(body.error?.message ?? t("startFailed")); return; }
    setJobId(body.data.jobId); setNotice(t("generating"));
  }

  async function apply() {
    if (!jobId) return;
    const response = await fetch(`/api/v1/tools/${tool}/apply`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ resultJobId: jobId, projectId, expectedRevision: Number(revision), confirmed, target: { kind: "caption" } }) });
    const body = await response.json();
    setNotice(response.ok ? t("applied", { revision: body.data.revision }) : t("unchangedSuffix", { message: body.error?.message ?? t("applyFailed") }));
    if (response.ok) setRevision(String(body.data.revision));
  }

  function download() {
    if (!output) return;
    const url = URL.createObjectURL(new Blob([output], { type: "text/markdown;charset=utf-8" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = `${tool}.md`; anchor.click(); URL.revokeObjectURL(url);
  }

  return (
    <div className="stack-lg">
      <section className="card stack">
        <h1>{toolName(definition.messageKey)}</h1>
        <label>{t("input")}<textarea value={text} onChange={(event) => setText(event.target.value)} placeholder={t("inputPlaceholder")} /></label>
        <fieldset className="stack"><legend>{t("contextLegend")}</legend>
          <label>{t("projectId")}<input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>
          <label>{t("expectedRevision")}<input type="number" min={1} value={revision} onChange={(event) => setRevision(event.target.value)} /></label>
          <label><input type="checkbox" checked={useTitle} onChange={(event) => setUseTitle(event.target.checked)} /> {t("includeTitle")}</label>
          <label><input type="checkbox" checked={useCaption} onChange={(event) => setUseCaption(event.target.checked)} /> {t("includeCaption")}</label>
        </fieldset>
        <div><Button onClick={() => void generate()}>{t("generate")}</Button></div>
      </section>
      {candidate ? <section className="card stack"><h2>{t("resultHeading")}</h2><pre style={{ whiteSpace: "pre-wrap" }}>{output || JSON.stringify(candidate, null, 2)}</pre><div className="row"><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(output)}>{t("copy")}</Button><Button variant="secondary" onClick={download}>{t("export")}</Button></div>
        {output ? <><label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> {t("confirm")}</label><Button disabled={!confirmed || !projectId || !revision} onClick={() => void apply()}>{t("apply")}</Button></> : null}
      </section> : null}
      <p role="status" className="meta">{notice}</p>
    </div>
  );
}
