"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";

type Summary = { status: string; referralUrl: string | null; clicks: number; conversions: number; grossCommissionCents: number; refundedCommissionCents: number; netCommissionCents: number };

export default function AffiliateDashboardPage() {
  const t = useTranslations("AffiliateDashboard");
  const [summary, setSummary] = useState<Summary | null>(null);
  const [notice, setNotice] = useState(t("loading"));
  useEffect(() => { void fetch("/api/v1/affiliate/dashboard", { cache: "no-store" }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? t("unavailable")); setSummary(body.data); setNotice(""); }).catch((error) => setNotice(error instanceof Error ? error.message : t("unavailable"))); }, [t]);
  return <WorkspaceShell current="affiliate" title={t("shellTitle")}><div className="stack-lg"><section className="card stack"><h1>{t("heading")}</h1>{notice ? <p role="status">{notice}</p> : null}{summary ? <><p><strong>{summary.status.replaceAll("_", " ")}</strong></p>{summary.referralUrl ? <p>{t("approvedLink")}<a href={summary.referralUrl}>{summary.referralUrl}</a></p> : <p>{t("noLink")}</p>}<div className="card-grid"><p><strong>{summary.clicks}</strong><br />{t("clicks")}</p><p><strong>{summary.conversions}</strong><br />{t("conversions")}</p><p><strong>${(summary.netCommissionCents / 100).toFixed(2)}</strong><br />{t("netCommission")}</p></div><p className="meta">{t("grossAndRefunds", { gross: `$${(summary.grossCommissionCents / 100).toFixed(2)}`, refunded: `$${(summary.refundedCommissionCents / 100).toFixed(2)}` })}</p><p className="meta">{t("privacyNote")}</p></> : null}</section></div></WorkspaceShell>;
}
