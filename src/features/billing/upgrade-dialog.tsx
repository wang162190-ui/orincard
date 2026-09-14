"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui";

export function UpgradeDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const t = useTranslations("Waitlist");
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");

  function join(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    setMessage(t("notOpen"));
  }

  return <Dialog hidden={!open} labelledBy="upgrade-title">
    <DialogHeader><h2 id="upgrade-title">{t("heading")}</h2></DialogHeader>
    <DialogBody>
      <p>{t("lead")}</p>
      <form id="waitlist-form" onSubmit={join}>
        <label>{t("email")}<input aria-label={t("email")} autoComplete="email" name="email" onChange={(event) => { setEmail(event.target.value); setMessage(""); }} placeholder="you@example.com" required type="email" value={email} /></label>
      </form>
      {message ? <p role="status">{message}</p> : <p className="meta">{t("idle")}</p>}
    </DialogBody>
    <DialogFooter><Button variant="secondary" onClick={onClose}>{t("close")}</Button><Button form="waitlist-form" type="submit">{t("submit")}</Button></DialogFooter>
  </Dialog>;
}
