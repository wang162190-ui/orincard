"use client";

import { useTranslations } from "next-intl";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui";
import { WaitlistForm } from "./waitlist-form";

export function UpgradeDialog({ open, onClose }: { readonly open: boolean; readonly onClose: () => void }) {
  const t = useTranslations("Waitlist");

  // 提交逻辑全部搬到 WaitlistForm：这个对话框和定价页收的是同一份名单，
  // 两边各写一遍迟早会写歪成两种行为。
  return <Dialog hidden={!open} labelledBy="upgrade-title">
    <DialogHeader><h2 id="upgrade-title">{t("heading")}</h2></DialogHeader>
    <DialogBody><p>{t("lead")}</p><WaitlistForm source="billing" /></DialogBody>
    <DialogFooter><Button variant="secondary" onClick={onClose}>{t("close")}</Button></DialogFooter>
  </Dialog>;
}
