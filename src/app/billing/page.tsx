"use client";

import { useEffect, useState } from "react";
import type { Entitlements, PlanKey } from "@/domain/entitlements";
import { WorkspaceShell } from "@/components/workspace-shell";
import { Button } from "@/components/ui";
import { UpgradeDialog } from "@/features/billing/upgrade-dialog";

type BillingData = { planKey: PlanKey; policyVersion: string; status: string; currentPeriod: { start: string; end: string } | null; cancelAtPeriodEnd: boolean; entitlements: Entitlements; balances: readonly { resource: string; granted: number; reserved: number; consumed: number; remaining: number; periodStart: string; periodEnd: string }[] };

export default function BillingPage() {
  const [data, setData] = useState<BillingData | null>(null);
  const [notice, setNotice] = useState("Loading billing…");
  const [upgrade, setUpgrade] = useState(false);
  useEffect(() => { void fetch("/api/v1/billing", { cache: "no-store" }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? "Billing is unavailable."); setData(body.data); setNotice(""); }).catch((error) => setNotice(error instanceof Error ? error.message : "Billing is unavailable.")); }, []);

  async function portal(action: "cancel" | "downgrade" | "manage") {
    setNotice(`Opening secure billing portal to ${action}…`);
    try {
      const response = await fetch("/api/v1/billing/portal", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } });
      const body = await response.json();
      if (!response.ok || typeof body.data?.url !== "string") throw new Error(body.error?.message ?? "Billing portal is unavailable.");
      window.location.assign(body.data.url);
    } catch (error) { setNotice(error instanceof Error ? error.message : "Billing portal is unavailable."); }
  }

  const paymentFailed = data && ["incomplete", "past_due", "unpaid"].includes(data.status);
  return <WorkspaceShell current="workspace" title="Billing"><div className="stack-lg"><section className="card stack"><h1>Billing</h1>{notice ? <p role="status">{notice}</p> : null}
    {data ? <><p><strong>{data.planKey.toUpperCase()}</strong> · {data.status.replaceAll("_", " ")}</p>{paymentFailed ? <p role="alert">Your latest payment needs attention. Open the billing portal to update payment details.</p> : null}{data.cancelAtPeriodEnd ? <p role="status">Cancellation is scheduled for the end of the current period.</p> : null}
      <p>{data.currentPeriod ? `Current period: ${new Date(data.currentPeriod.start).toLocaleDateString()} – ${new Date(data.currentPeriod.end).toLocaleDateString()}` : "Free plan has no paid billing period."}</p>
      <p className="meta">Policy {data.policyVersion}</p><div className="row"><Button onClick={() => setUpgrade(true)}>Upgrade</Button>{data.planKey !== "free" ? <><Button variant="secondary" onClick={() => void portal("downgrade")}>Downgrade plan</Button><Button variant="secondary" onClick={() => void portal("cancel")}>Cancel at period end</Button></> : null}{paymentFailed ? <Button variant="secondary" onClick={() => void portal("manage")}>Fix payment</Button> : null}</div></> : null}</section>
    {data ? <section className="card stack"><h2>Usage balances</h2>{data.balances.length ? data.balances.map((balance) => <div key={balance.resource} data-testid="balance-row"><strong>{balance.resource}</strong><span>{balance.remaining} remaining · {balance.consumed} used · {balance.reserved} pending</span><progress aria-label={`${balance.resource} usage`} max={balance.granted} value={Math.min(balance.granted, balance.consumed + balance.reserved)} /></div>) : <p>No metered usage in this period.</p>}<p>Maximum pages: {data.entitlements.maxPages}</p></section> : null}
    {data ? <UpgradeDialog currentPlan={data.planKey} open={upgrade} onClose={() => setUpgrade(false)} /> : null}
  </div></WorkspaceShell>;
}
