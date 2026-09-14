"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button, Panel, PanelBody, PanelHeader } from "../../components/ui";

type Version = Readonly<{ id: string; revision: number; reason: string; createdAt: string; documentHash: string }>;

export function VersionHistory({ projectId, revision }: Readonly<{ projectId: string; revision: number }>) {
  const t = useTranslations("Versions");
  const [versions, setVersions] = useState<readonly Version[]>([]);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let active = true;
    void fetch(`/api/v1/projects/${projectId}/versions?limit=20`, { cache: "no-store" })
      .then(async (response) => response.ok ? response.json() as Promise<{ data: { items: Version[] } }> : Promise.reject(new Error(t("unavailable"))))
      .then((payload) => { if (active) setVersions(payload.data.items); })
      .catch(() => { if (active) setMessage(t("unavailable")); });
    return () => { active = false; };
  }, [projectId, revision, t]);

  async function restore(version: Version) {
    if (!globalThis.confirm(t("confirmRestore", { revision: version.revision }))) return;
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
      setMessage(t("restoreFailed"));
      setBusy(false);
    }
  }

  return (
    <Panel aria-label={t("label")}>
      <PanelHeader><h2 className="h3">{t("heading")}</h2></PanelHeader>
      <PanelBody className="stack">
        {message ? <p className="meta" role="status">{message}</p> : null}
        {versions.map((version) => (
          <div className="row-between" key={version.id}>
            <span className="meta">{t("entry", { revision: version.revision, reason: version.reason })}</span>
            <Button disabled={busy || version.revision === revision} onClick={() => void restore(version)} size="small" variant="ghost">
              {version.revision === revision ? t("current") : t("restore")}
            </Button>
          </div>
        ))}
      </PanelBody>
    </Panel>
  );
}
