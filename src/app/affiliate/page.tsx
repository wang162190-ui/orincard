"use client";

import { useState } from "react";
import Link from "next/link";
import { WorkspaceShell } from "@/components/workspace-shell";
import { Button } from "@/components/ui";

export default function AffiliatePage() {
  const [notice, setNotice] = useState("");
  async function apply(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault(); setNotice("Sending application…");
    const form = new FormData(event.currentTarget);
    const response = await fetch("/api/v1/affiliate/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ channel: form.get("channel"), audience: form.get("audience") }) });
    const body = await response.json();
    setNotice(response.ok ? "Application received. A referral link appears only after approval." : body.error?.message ?? "Application could not be sent.");
  }
  return <WorkspaceShell current="workspace" title="Affiliate"><div className="stack-lg"><header><p className="eyebrow">Affiliate program</p><h1>Share Orincard responsibly</h1><p className="lead">Apply to recommend Orincard to your audience. Applications are reviewed before any referral link is issued.</p></header><form className="card stack" onSubmit={(event) => void apply(event)}><label>Primary channel<input name="channel" required maxLength={120} /></label><label>Audience and promotion plan<textarea name="audience" required maxLength={1000} /></label><Button type="submit">Apply for review</Button>{notice ? <p role="status">{notice}</p> : null}</form><Link href="/affiliate/dashboard">View affiliate status</Link></div></WorkspaceShell>;
}
