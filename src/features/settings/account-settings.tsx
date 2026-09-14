"use client";

import { useTranslations } from "next-intl";
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
  const t = useTranslations("Settings");
  const [preferences, setPreferences] = useState<AccountPreferences>(DEFAULT_ACCOUNT_PREFERENCES);
  const [notice, setNotice] = useState(t("loadingPreferences"));
  const [exportJobId, setExportJobId] = useState<string | null>(null);
  const [downloadUrl, setDownloadUrl] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/v1/settings", { cache: "no-store" })
      .then(async (response) => {
        const body = await response.json();
        if (!response.ok) throw new Error(body.error?.message ?? t("loadFailed"));
        setPreferences(body.data.preferences);
        setNotice(t("loaded"));
      })
      .catch((error) => setNotice(error instanceof Error ? error.message : t("loadFailed")));
  }, [t]);

  useEffect(() => {
    if (!exportJobId || downloadUrl) return;
    const timer = window.setInterval(() => {
      void fetch(`/api/v1/account/export?jobId=${encodeURIComponent(exportJobId)}`, { cache: "no-store" })
        .then(async (response) => {
          const body = await response.json();
          if (!response.ok) throw new Error(body.error?.message ?? t("exportStatusFailed"));
          if (body.data.downloadUrl) {
            setDownloadUrl(body.data.downloadUrl);
            setNotice(t("exportReady"));
          } else if (body.data.state === "failed") {
            setExportJobId(null);
            setNotice(t("exportFailed"));
          } else {
            setNotice(t("exportProgress", { progress: body.data.progress }));
          }
        })
        .catch((error) => setNotice(error instanceof Error ? error.message : t("exportStatusFailed")));
    }, 1_500);
    return () => window.clearInterval(timer);
  }, [downloadUrl, exportJobId, t]);

  async function save() {
    setNotice(t("saving"));
    const response = await fetch("/api/v1/settings", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ preferences }),
    });
    const body = await response.json();
    setNotice(response.ok ? t("saved") : body.error?.message ?? t("saveFailed"));
  }

  async function requestExport() {
    setNotice(t("exportStarting"));
    setDownloadUrl(null);
    const response = await fetch("/api/v1/account/export", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } });
    const body = await response.json();
    if (!response.ok) {
      setNotice(body.error?.message ?? t("exportStartFailed"));
      return;
    }
    setExportJobId(body.data.jobId);
  }

  return (
    <div className="stack-lg">
      <section className="card stack">
        <h2>{t("defaultsHeading")}</h2>
        <label>{t("language")}<input value={preferences.language} onChange={(event) => setPreferences({ ...preferences, language: event.target.value })} /></label>
        <label>{t("tone")}<select value={preferences.tone} onChange={(event) => setPreferences({ ...preferences, tone: event.target.value })}><option value="professional">{t("toneProfessional")}</option><option value="friendly">{t("toneFriendly")}</option><option value="bold">{t("toneBold")}</option><option value="educational">{t("toneEducational")}</option></select></label>
        <label>{t("slideCount")}<input type="number" min={2} max={20} value={preferences.slideCount} onChange={(event) => setPreferences({ ...preferences, slideCount: Number(event.target.value) })} /></label>
        <label>{t("instructions")}<textarea value={preferences.generationInstructions} maxLength={2000} onChange={(event) => setPreferences({ ...preferences, generationInstructions: event.target.value })} /></label>
        <div><Button onClick={() => void save()}>{t("save")}</Button></div>
      </section>
      <section className="card stack">
        <h2>{t("dataHeading")}</h2>
        <p>{t("dataLead")}</p>
        <div className="row">
          <Button onClick={() => void requestExport()} disabled={Boolean(exportJobId && !downloadUrl)}>{t("prepare")}</Button>
          {downloadUrl ? <a className="button" href={downloadUrl} download="orincard-account-data.zip">{t("download")}</a> : null}
        </div>
      </section>
      <p role="status" className="meta">{notice}</p>
    </div>
  );
}
