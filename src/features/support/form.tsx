"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

type DiagnosticType = "project" | "job" | "export";

export function SupportForm() {
  const [category, setCategory] = useState("account");
  const [message, setMessage] = useState("");
  const [diagnostics, setDiagnostics] = useState<Record<DiagnosticType, { selected: boolean; id: string }>>({ project: { selected: false, id: "" }, job: { selected: false, id: "" }, export: { selected: false, id: "" } });
  const [notice, setNotice] = useState("Diagnostic IDs are not attached unless you select them.");

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const diagnosticRefs = (Object.entries(diagnostics) as [DiagnosticType, { selected: boolean; id: string }][]).filter(([, value]) => value.selected).map(([type, value]) => ({ type, id: value.id }));
    const response = await fetch("/api/v1/support", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ category, message, diagnosticRefs }) });
    const body = await response.json();
    setNotice(response.ok ? `Support request received: ${body.data.ticketId}` : body.error?.message ?? "Could not send support request.");
  }

  return <form className="card stack-lg" onSubmit={(event) => void submit(event)}>
    <label>Category<select value={category} onChange={(event) => setCategory(event.target.value)}><option value="account">Account</option><option value="billing">Billing</option><option value="export">Export</option><option value="copyright">Copyright</option><option value="other">Other</option></select></label>
    <label>Message<textarea required minLength={10} maxLength={5000} value={message} onChange={(event) => setMessage(event.target.value)} /></label>
    <fieldset className="stack"><legend>Optional diagnostic IDs</legend>{(["project", "job", "export"] as const).map((type) => <div key={type}><label><input type="checkbox" checked={diagnostics[type].selected} onChange={(event) => setDiagnostics({ ...diagnostics, [type]: { ...diagnostics[type], selected: event.target.checked } })} /> Attach {type} ID</label><input aria-label={`${type} ID`} disabled={!diagnostics[type].selected} value={diagnostics[type].id} onChange={(event) => setDiagnostics({ ...diagnostics, [type]: { ...diagnostics[type], id: event.target.value } })} /></div>)}</fieldset>
    <Button type="submit">Send to support</Button><p role="status" className="meta">{notice}</p>
  </form>;
}
