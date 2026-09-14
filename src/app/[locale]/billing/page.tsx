"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { Entitlements, PlanKey } from "@/domain/entitlements";
import { WorkspaceShell } from "@/components/workspace-shell";
import { Button } from "@/components/ui";
import { UpgradeDialog } from "@/features/billing/upgrade-dialog";

type BillingData = { planKey: PlanKey; policyVersion: string; status: string; currentPeriod: { start: string; end: string } | null; cancelAtPeriodEnd: boolean; entitlements: Entitlements; balances: readonly { resource: string; granted: number; reserved: number; consumed: number; remaining: number; periodStart: string; periodEnd: string }[] };

export default function BillingPage() {
  const t = useTranslations("Billing");
  const [data, setData] = useState<BillingData | null>(null);
  const [notice, setNotice] = useState(t("loading"));
  const [upgrade, setUpgrade] = useState(false);
  useEffect(() => { void fetch("/api/v1/billing", { cache: "no-store" }).then(async (response) => { const body = await response.json(); if (!response.ok) throw new Error(body.error?.message ?? t("unavailable")); setData(body.data); setNotice(""); }).catch((error) => setNotice(error instanceof Error ? error.message : t("unavailable"))); }, [t]);

  async function portal(action: "cancel" | "downgrade" | "manage") {
    setNotice(t("openingPortal", { action }));
    try {
      const response = await fetch("/api/v1/billing/portal", { method: "POST", headers: { "Idempotency-Key": crypto.randomUUID() } });
      const body = await response.json();
      if (!response.ok || typeof body.data?.url !== "string") throw new Error(body.error?.message ?? t("portalUnavailable"));
      window.location.assign(body.data.url);
    } catch (error) { setNotice(error instanceof Error ? error.message : t("portalUnavailable")); }
  }

  const paymentFailed = data && ["incomplete", "past_due", "unpaid"].includes(data.status);
  return <WorkspaceShell current="workspace" title={t("shellTitle")}><div className="stack-lg"><section className="card stack"><h1>{t("heading")}</h1>{notice ? <p role="status">{notice}</p> : null}
    {data ? <><p><strong>{data.planKey.toUpperCase()}</strong> · {data.status.replaceAll("_", " ")}</p>{paymentFailed ? <p role="alert">{t("paymentFailed")}</p> : null}{data.cancelAtPeriodEnd ? <p role="status">{t("cancelScheduled")}</p> : null}
      <p>{data.currentPeriod ? t("currentPeriod", { start: new Date(data.currentPeriod.start).toLocaleDateString(), end: new Date(data.currentPeriod.end).toLocaleDateString() }) : t("noPaidPeriod")}</p>
      <p className="meta">{t("policy", { version: data.policyVersion })}</p><div className="row"><Button onClick={() => setUpgrade(true)}>{t("joinWaitlist")}</Button>{data.planKey !== "free" ? <><Button variant="secondary" onClick={() => void portal("downgrade")}>{t("downgrade")}</Button><Button variant="secondary" onClick={() => void portal("cancel")}>{t("cancelAtPeriodEnd")}</Button></> : null}{paymentFailed ? <Button variant="secondary" onClick={() => void portal("manage")}>{t("fixPayment")}</Button> : null}</div></> : null}</section>
    {data ? <section className="card stack"><h2>{t("balancesHeading")}</h2>{data.balances.length ? data.balances.map((balance) => <div key={balance.resource} data-testid="balance-row"><strong>{balance.resource}</strong><span>{t("balanceSummary", { remaining: balance.remaining, consumed: balance.consumed, reserved: balance.reserved })}</span><progress aria-label={t("balanceUsage", { resource: balance.resource })} max={balance.granted} value={Math.min(balance.granted, balance.consumed + balance.reserved)} /></div>) : <p>{t("noUsage")}</p>}<p>{t("maxPages", { count: data.entitlements.maxPages })}</p></section> : null}
    {data ? <UpgradeDialog open={upgrade} onClose={() => setUpgrade(false)} /> : null}
  </div></WorkspaceShell>;
}
