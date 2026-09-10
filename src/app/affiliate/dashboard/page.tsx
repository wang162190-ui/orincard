"use client";

import { useEffect, useState } from "react";
import { WorkspaceShell } from "@/components/workspace-shell";

type Summary = { status: string; referralUrl: string | null; clicks: number; conversions: number; grossCommissionCents: number; refundedCommissionCents: number; netCommissionCents: number };

export default function AffiliateDashboardPage() {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [notice, setNotice] = useState("Loading affiliate status…");
  useEffect(() => { void fetch("/api/v1/affiliate/dashboard", { cache: "no-store" }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Affiliate status is unavailable."); setSummary(body.data); setNotice(""); }).catch((error) => setNotice(error instanceof Error ? error.message : "Affiliate status is unavailable.")); }, []);
  return <WorkspaceShell current="workspace" title="Affiliate status"><div className="stack-lg"><section className="card stack"><h1>Affiliate status</h1>{notice ? <p role="status">{notice}</p> : null}{summary ? <><p><strong>{summary.status.replaceAll("_", " ")}</strong></p>{summary.referralUrl ? <p>Your approved link: <a href={summary.referralUrl}>{summary.referralUrl}</a></p> : <p>A referral link is available after approval.</p>}<div className="card-grid"><p><strong>{summary.clicks}</strong><br />Clicks</p><p><strong>{summary.conversions}</strong><br />Conversions</p><p><strong>${(summary.netCommissionCents / 100).toFixed(2)}</strong><br />Net commission</p></div><p className="meta">Gross ${(summary.grossCommissionCents / 100).toFixed(2)} · Refund reversals ${(summary.refundedCommissionCents / 100).toFixed(2)}</p><p className="meta">Statistics are aggregated and never disclose purchaser identities.</p></> : null}</section></div></WorkspaceShell>;
}
