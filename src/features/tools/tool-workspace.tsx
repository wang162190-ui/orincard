"use client";

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
  const definition = getToolDefinition(tool);
  const [text, setText] = useState("");
  const [projectId, setProjectId] = useState("");
  const [revision, setRevision] = useState("");
  const [useTitle, setUseTitle] = useState(false);
  const [useCaption, setUseCaption] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [candidate, setCandidate] = useState<unknown>(null);
  const [notice, setNotice] = useState("Enter content or explicitly select project context.");
  const [confirmed, setConfirmed] = useState(false);
  const output = useMemo(() => candidateText(candidate), [candidate]);

  useEffect(() => {
    if (!jobId || candidate) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/v1/tools/${tool}?jobId=${encodeURIComponent(jobId)}`, { cache: "no-store" }).then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? "Could not read tool result.");
        if (body.data.candidate) { setCandidate(body.data.candidate); setNotice("Candidate ready. Review it before applying."); }
        else if (body.data.state === "failed") { setJobId(null); setNotice("Generation failed. Your project was not changed."); }
        else setNotice(`Generating candidate… ${body.data.progress}%`);
      }).catch((error) => setNotice(error instanceof Error ? error.message : "Could not read tool result."));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [candidate, jobId, tool]);

  async function generate() {
    setCandidate(null); setNotice("Starting…");
    const context = projectId && revision && (useTitle || useCaption) ? { projectId, expectedRevision: Number(revision), fields: { title: useTitle || undefined, caption: useCaption || undefined } } : undefined;
    const response = await fetch(`/api/v1/tools/${tool}`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ input: requestInput(tool, text), ...(context ? { context } : {}) }) });
    const body = await response.json();
    if (!response.ok) { setNotice(body.error?.message ?? "Could not start tool."); return; }
    setJobId(body.data.jobId); setNotice("Generating candidate…");
  }

  async function apply() {
    if (!jobId) return;
    const response = await fetch(`/api/v1/tools/${tool}/apply`, { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ resultJobId: jobId, projectId, expectedRevision: Number(revision), confirmed, target: { kind: "caption" } }) });
    const body = await response.json();
    setNotice(response.ok ? `Applied as project revision ${body.data.revision}.` : `${body.error?.message ?? "Apply failed."} Your project was not changed.`);
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
        <h1>{definition.label}</h1>
        <label>Input<textarea value={text} onChange={(event) => setText(event.target.value)} placeholder="Describe what you want to create" /></label>
        <fieldset className="stack"><legend>Optional project context</legend>
          <label>Project ID<input value={projectId} onChange={(event) => setProjectId(event.target.value)} /></label>
          <label>Expected revision<input type="number" min={1} value={revision} onChange={(event) => setRevision(event.target.value)} /></label>
          <label><input type="checkbox" checked={useTitle} onChange={(event) => setUseTitle(event.target.checked)} /> Include title</label>
          <label><input type="checkbox" checked={useCaption} onChange={(event) => setUseCaption(event.target.checked)} /> Include caption</label>
        </fieldset>
        <div><Button onClick={() => void generate()}>Generate candidate</Button></div>
      </section>
      {candidate ? <section className="card stack"><h2>Candidate result</h2><pre style={{ whiteSpace: "pre-wrap" }}>{output || JSON.stringify(candidate, null, 2)}</pre><div className="row"><Button variant="secondary" onClick={() => void navigator.clipboard.writeText(output)}>Copy</Button><Button variant="secondary" onClick={download}>Export</Button></div>
        {output ? <><label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed this candidate and want to apply it to the project caption.</label><Button disabled={!confirmed || !projectId || !revision} onClick={() => void apply()}>Apply to project</Button></> : null}
      </section> : null}
      <p role="status" className="meta">{notice}</p>
    </div>
  );
}
