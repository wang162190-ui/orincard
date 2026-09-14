"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Button, Dialog, DialogBody, DialogFooter, DialogHeader } from "@/components/ui";
import type { BrandKit, BrandProjectImpact } from "@/server/brands";

type DeleteResponse = Readonly<{ error?: { message?: string; affectedProjects?: readonly BrandProjectImpact[] } }>;

export function DeleteBrandDialog({ kit, affectedProjects, onClose, onDeleted, fetcher = fetch }: {
  readonly kit: BrandKit;
  readonly affectedProjects: readonly BrandProjectImpact[];
  readonly onClose: () => void;
  readonly onDeleted: () => void;
  readonly fetcher?: typeof fetch;
}) {
  const t = useTranslations("BrandKits");
  const [confirmed, setConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [currentProjects, setCurrentProjects] = useState(affectedProjects);

  async function remove() {
    setPending(true); setMessage(null);
    try {
      const response = await fetcher(`/api/v1/brand-kits/${kit.id}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: kit.revision, expectedProjectIds: currentProjects.map((project) => project.id) }) });
      if (response.ok) { onDeleted(); return; }
      const body = await response.json() as DeleteResponse;
      if (body.error?.affectedProjects) setCurrentProjects(body.error.affectedProjects);
      setConfirmed(false);
      setMessage(body.error?.message ?? t("deleteFailed"));
    } catch { setMessage(t("deleteFailed")); }
    finally { setPending(false); }
  }

  return <Dialog labelledBy="delete-brand-kit-title">
    <DialogHeader><h2 id="delete-brand-kit-title">{t("deleteTitle", { name: kit.name })}</h2></DialogHeader>
    <DialogBody>
      <p>{t("deleteLead")}</p>
      {currentProjects.length > 0 ? <><p>{t("deleteAffected", { count: currentProjects.length })}</p><ul>{currentProjects.map((project) => <li key={project.id}>{project.title}</li>)}</ul></> : <p>{t("deleteNoProjects")}</p>}
      <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> {t("deleteConfirm")}</label>
      {message ? <p role="alert">{message}</p> : null}
    </DialogBody>
    <DialogFooter><Button variant="secondary" disabled={pending} onClick={onClose}>{t("deleteCancel")}</Button><Button variant="danger" disabled={!confirmed || pending} onClick={() => void remove()}>{t("deleteSubmit")}</Button></DialogFooter>
  </Dialog>;
}
