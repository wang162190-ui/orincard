"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui";

type AccountPreferences = {
  readonly language: string;
  readonly tone: string;
  readonly slideCount: number;
  readonly generationInstructions: string;
};

const DEFAULT_ACCOUNT_PREFERENCES: AccountPreferences = {
  language: "English",
  tone: "professional",
  slideCount: 6,
  generationInstructions: "",
};

export function AccountSettings() {
  const [preferences, setPreferences] = useState<AccountPreferences>(DEFAULT_ACCOUNT_PREFERENCES);
  const [notice, setNotice] = useState("Loading preferences…");
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/v1/settings", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? "Could not load preferences.");
        setPreferences(body.data.preferences);
        setNotice("Preferences are saved to your account.");
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : "Could not load preferences."));
  }, []);

  useEffect(() => {
    if (!exportJobId || downloadUrl) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/v1/account/export?jobId=${encodeURIComponent(exportJobId)}`, { cache: "no-store" })
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(body.error?.message ?? "Could not read export status.");
          if (body.data.downloadUrl) {
            setDownloadUrl(body.data.downloadUrl);
            setNotice("Your account data package is ready.");
          } else if (body.data.state === "failed") {
            setExportJobId(null);
            setNotice("Account export failed. You can try again.");
          } else {
            setNotice(`Preparing account data… ${body.data.progress}%`);
          }
        })
        .catch((error) => setNotice(error instanceof Error ? error.message : "Could not read export status."));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [downloadUrl, exportJobId]);

  async function save() {
    setNotice("Saving…");
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences }),
    });
    const body = await response.json();
    setNotice(response.ok ? "Preferences saved." : body.error?.message ?? "Could not save preferences.");
  }

  async function requestExport() {
    setNotice("Starting account export…");
    setDownloadUrl(null);
    const response = await fetch("/api/v1/account/export", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } });
    const body = await response.json();
    if (!response.ok) {
      setNotice(body.error?.message ?? "Could not start account export.");
      return;
    }
    setExportJobId(body.data.jobId);
  }

  return (
    <div className="stack-lg">
      <section className="card stack">
        <h2>Creation defaults</h2>
        <label>Language<input value={preferences.language} onChange={(event) => setPreferences({ ...preferences, language: event.target.value })} /></label>
        <label>Tone<select value={preferences.tone} onChange={(event) => setPreferences({ ...preferences, tone: event.target.value })}><option value="professional">Professional</option><option value="friendly">Friendly</option><option value="bold">Bold</option><option value="educational">Educational</option></select></label>
        <label>Default slide count<input type="number" min={2} max={20} value={preferences.slideCount} onChange={(event) => setPreferences({ ...preferences, slideCount: Number(event.target.value) })} /></label>
        <label>Generation instructions<textarea value={preferences.generationInstructions} maxLength={2000} onChange={(event) => setPreferences({ ...preferences, generationInstructions: event.target.value })} /></label>
        <div><Button onClick={() => void save()}>Save preferences</Button></div>
      </section>
      <section className="card stack">
        <h2>Account data</h2>
        <p>Download your profile preferences and account-owned project, brand, source, asset and export records.</p>
        <div className="row">
          <Button onClick={() => void requestExport()} disabled={Boolean(exportJobId && !downloadUrl)}>Prepare data package</Button>
          {downloadUrl ? <a className="button" href={downloadUrl} download="orincard-account-data.zip">Download ZIP</a> : null}
        </div>
      </section>
      <p role="status" className="meta">{notice}</p>
    </div>
  );
}
