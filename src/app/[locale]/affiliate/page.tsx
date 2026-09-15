"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";
import { Button } from "@/components/ui";
import { Link } from "@/i18n/navigation";

export default function AffiliatePage() {
  const t = useTranslations("Affiliate");
  const [notice, setNotice] = useState("");
  async function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice(t("sending"));
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/affiliate/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: form.get("channel"), audience: form.get("audience") }) });
    const body = await response.json();
    setNotice(response.ok ? t("received") : body.error?.message ?? t("failed"));
  }
  return <WorkspaceShell current="affiliate" title={t("shellTitle")}><div className="stack-lg"><header><p className="eyebrow">{t("eyebrow")}</p><h1>{t("heading")}</h1><p className="lead">{t("lead")}</p></header><form className="card stack" onSubmit={(event) => void apply(event)}><label className="field">{t("channel")}<input className="input" name="channel" required maxLength={120} /></label><label className="field">{t("audience")}<textarea className="textarea" name="audience" required maxLength={1000} /></label><Button type="submit">{t("submit")}</Button>{notice ? <p role="status">{notice}</p> : null}</form><Link href="/affiliate/dashboard">{t("viewStatus")}</Link></div></WorkspaceShell>;
}
