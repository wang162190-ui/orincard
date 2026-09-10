"use client";

import { useState } from "react";
import type { PlanKey } from "@/domain/entitlements";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui";

export function UpgradeDialog({ currentPlan, open, onClose }: { readonly currentPlan: PlanKey; readonly open: boolean; readonly onClose: () => void }) {
  const [planKey, setPlanKey] = useState<"pro" | "creator">(currentPlan === "creator" ? "creator" : "pro");
  const [interval, setInterval] = useState<"month" | "year">("month");
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function checkout() {
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/v1/billing/checkout", { method: "POST", headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() }, body: JSON.stringify({ planKey, interval }) });
      const body = await response.json();
      if (!response.ok || typeof body.data?.url !== "string") throw new Error(body.error?.message ?? "Checkout is unavailable.");
      window.location.assign(body.data.url);
    } catch (error) { setMessage(error instanceof Error ? error.message : "Checkout is unavailable."); setBusy(false); }
  }

  return <Dialog hidden={!open} labelledBy="upgrade-title">
    <DialogHeader><h2 id="upgrade-title">Choose a plan</h2></DialogHeader>
    <DialogBody>
      <fieldset><legend>Plan</legend><label><input checked={planKey === "pro"} name="plan" onChange={() => setPlanKey("pro")} type="radio" /> Pro</label> <label><input checked={planKey === "creator"} name="plan" onChange={() => setPlanKey("creator")} type="radio" /> Creator</label></fieldset>
      <label>Billing interval<select aria-label="Billing interval" value={interval} onChange={(event) => setInterval(event.target.value as "month" | "year")}><option value="month">Monthly</option><option value="year">Yearly</option></select></label>
      {message ? <p role="alert">{message}</p> : null}
    </DialogBody>
    <DialogFooter><Button variant="secondary" onClick={onClose}>Close</Button><Button disabled={busy} onClick={() => void checkout()}>{busy ? "Opening…" : "Continue to secure checkout"}</Button></DialogFooter>
  </Dialog>;
}
