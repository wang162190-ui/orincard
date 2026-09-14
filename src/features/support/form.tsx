"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button } from "@/components/ui";

type DiagnosticType = "project" | "job" | "export";

export function SupportForm() {
  const t = useTranslations("Support");
  const [category, setCategory] = useState("account");
  const [message, setMessage] = useState("");
  const [diagnostics, setDiagnostics] = useState<Record<DiagnosticType, { selected: boolean; id: string }>>({ project: { selected: false, id: "" }, job: { selected: false, id: "" }, export: { selected: false, id: "" } });
  const [notice, setNotice] = useState(t("idle"));

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const diagnosticRefs = (Object.entries(diagnostics) as [DiagnosticType, { selected: boolean; id: string }][]).filter(([, value]) => value.selected).map(([type, value]) => ({ type, id: value.id }));
    const response = await fetch("/api/v1/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category, message, diagnosticRefs }) });
    const body = await response.json();
    setNotice(response.ok ? t("received", { ticketId: body.data.ticketId }) : body.error?.message ?? t("failed"));
  }

  return <form className="card stack-lg" onSubmit={(event) => void submit(event)}>
    <label>{t("category")}<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="account">{t("categoryAccount")}</option><option value="billing">{t("categoryBilling")}</option><option value="export">{t("categoryExport")}</option><option value="copyright">{t("categoryCopyright")}</option><option value="other">{t("categoryOther")}</option></select></label>
    <label>{t("message")}<textarea required minLength={10} maxLength={5000} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
    <fieldset className="stack"><legend>{t("diagnosticsLegend")}</legend>{(["project", "job", "export"] as const).map((type) => <div key={type}><label><input type="checkbox" checked={diagnostics[type].selected} onChange={(event) => setDiagnostics({ ...diagnostics, [type]: { ...diagnostics[type], selected: event.target.checked } })} /> {t(type === "project" ? "attachProject" : type === "job" ? "attachJob" : "attachExport")}</label><input aria-label={t(type === "project" ? "projectIdLabel" : type === "job" ? "jobIdLabel" : "exportIdLabel")} disabled={!diagnostics[type].selected} value={diagnostics[type].id} onChange={(event) => setDiagnostics({ ...diagnostics, [type]: { ...diagnostics[type], id: event.target.value } })} /></div>)}</fieldset>
    <Button type="submit">{t("submit")}</Button><p role="status" className="meta">{notice}</p>
  </form>;
}
