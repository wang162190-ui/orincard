"use client";

import { useEffect, useState } from "react";
import { Button, Panel, PanelBody, PanelHeader } from "../../components/ui";

type Version = Readonly<{ id: string; revision: number; reason: string; createdAt: string; documentHash: string }>;

export function VersionHistory({ projectId, revision }: Readonly<{ projectId: string; revision: number }>) {
  const [versions, setVersions] = useState<readonly Version[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch(`/api/v1/projects/${projectId}/versions?limit=20`, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ data: { items: Version[] } }> : Promise.reject(new Error("Version history is unavailable.")))
      .then((payload) => { if (active) setVersions(payload.data.items); })
      .catch(() => { if (active) setMessage("Version history is unavailable."); });
    return () => { active = false; };
  }, [projectId, revision]);

  async function restore(version: Version) {
    if (!globalThis.confirm(`Restore revision ${version.revision}? This creates a new current revision.`)) return;
    setBusy(true);
    setMessage("");
    try {
      const response = await fetch(`/api/v1/projects/${projectId}/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": `restore-${globalThis.crypto.randomUUID()}` },
        body: JSON.stringify({ versionId: version.id, expectedRevision: revision }),
      });
      if (!response.ok) throw new Error("Restore was not completed.");
      globalThis.location.reload();
    } catch {
      setMessage("Restore was not completed. Reload version history and try again.");
      setBusy(false);
    }
  }

  return (
    <Panel aria-label="Version history">
      <PanelHeader><h2 className="h3">Version history</h2></PanelHeader>
      <PanelBody className="stack">
        {message ? <p className="meta" role="status">{message}</p> : null}
        {versions.map((version) => (
          <div className="row-between" key={version.id}>
            <span className="meta">Revision {version.revision} · {version.reason}</span>
            <Button disabled={busy || version.revision === revision} onClick={() => void restore(version)} size="small" variant="ghost">
              {version.revision === revision ? "Current" : "Restore"}
            </Button>
          </div>
        ))}
      </PanelBody>
    </Panel>
  );
}
