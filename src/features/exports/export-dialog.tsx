"use client";

import { useEffect, useState } from "react";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui";
import type { BasicExportFormat } from "@/render/render-deck";

type Fetcher = typeof fetch;

export function ExportDialog({
  projectId,
  revision,
  fetcher = fetch,
}: {
  readonly projectId: string;
  readonly revision: number;
  readonly fetcher?: Fetcher;
}) {
  const [format, setFormat] = useState<BasicExportFormat>("pdf");
  const [issues, setIssues] = useState<readonly { repairAction: string }[]>([]);
  const [status, setStatus] = useState<"idle" | "checking" | "started" | "failed">("idle");

  async function startExport() {
    setStatus("checking");
    setIssues([]);
    const preflight = await fetcher(`/api/v1/projects/${projectId}/preflight`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedRevision: revision, format, options: {} }),
    });
    const checked = await preflight.json();
    if (!preflight.ok || !checked.data?.canExport) {
      setIssues(checked.data?.issues ?? []);
      setStatus("failed");
      return;
    }
    const created = await fetcher(`/api/v1/projects/${projectId}/exports`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        expectedRevision: revision,
        formats: [format],
        options: {},
        confirmedWarnings: [],
      }),
    });
    setStatus(created.ok ? "started" : "failed");
  }

  return (
    <Dialog labelledBy="export-dialog-title">
      <DialogHeader>
        <h2 id="export-dialog-title">Export revision {revision}</h2>
      </DialogHeader>
      <DialogBody>
        <label>
          Format
          <select value={format} onChange={(event) => setFormat(event.target.value as BasicExportFormat)}>
            <option value="png_zip">PNG ZIP</option>
            <option value="jpg_zip">JPG ZIP</option>
            <option value="pdf">PDF</option>
          </select>
        </label>
        {issues.map((issue, index) => <p role="alert" key={index}>{issue.repairAction}</p>)}
        {status === "started" ? <p role="status">Export started</p> : null}
        {status === "failed" && issues.length === 0 ? <p role="alert">Export could not be started.</p> : null}
      </DialogBody>
      <DialogFooter>
        <Button disabled={status === "checking"} onClick={startExport}>Export</Button>
      </DialogFooter>
    </Dialog>
  );
}

export function ExportCenter({ fetcher = fetch }: { readonly fetcher?: Fetcher }) {
  const [items, setItems] = useState<readonly {
    id: string;
    format: string;
    state: string;
    revision: number;
  }[]>([]);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    fetcher("/api/v1/exports", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error("history unavailable");
        if (active) setItems(body.data?.items ?? []);
      })
      .catch(() => active && setFailed(true));
    return () => { active = false; };
  }, [fetcher]);

  if (failed) return <p role="alert">Exports are temporarily unavailable.</p>;
  if (items.length === 0) return <p>No exports yet. Start one from a saved project.</p>;
  return (
    <ul>
      {items.map((item) => (
        <li key={item.id}>
          Revision {item.revision} · {item.format} · {item.state}
          {item.state === "ready" ? (
            <form action={`/api/v1/exports/${item.id}/download`} method="post">
              <Button type="submit">Download</Button>
            </form>
          ) : null}
        </li>
      ))}
    </ul>
  );
}
