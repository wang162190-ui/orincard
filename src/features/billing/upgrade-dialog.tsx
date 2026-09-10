"use client";

import { useState } from "react";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui";

export function UpgradeDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  function join(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    setMessage("Waitlist registration is not open yet. Your email has not been submitted or stored.");
  }

  return <Dialog hidden={!open} labelledBy="upgrade-title">
    <DialogHeader><h2 id="upgrade-title">Join the waitlist</h2></DialogHeader>
    <DialogBody>
      <p>Paid plans are not open yet. Leave this dialog ready for the waitlist provider you choose later.</p>
      <form id="waitlist-form" onSubmit={join}>
        <label>Email address<input aria-label="Email address" autoComplete="email" name="email" onChange={(event) => { setEmail(event.target.value); setMessage(""); }} placeholder="you@example.com" required type="email" value={email} /></label>
      </form>
      {message ? <p role="status">{message}</p> : <p className="meta">No email is sent or stored while the waitlist provider is unconfigured.</p>}
    </DialogBody>
    <DialogFooter><Button variant="secondary" onClick={onClose}>Close</Button><Button form="waitlist-form" type="submit">Join waitlist</Button></DialogFooter>
  </Dialog>;
}
