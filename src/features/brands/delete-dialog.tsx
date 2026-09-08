"use client";

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
      setMessage(body.error?.message ?? "Brand Kit could not be deleted.");
    } catch { setMessage("Brand Kit could not be deleted."); }
    finally { setPending(false); }
  }

  return <Dialog labelledBy="delete-brand-kit-title">
    <DialogHeader><h2 id="delete-brand-kit-title">Delete {kit.name}?</h2></DialogHeader>
    <DialogBody>
      <p>This removes the Brand Kit. Existing project snapshots and shared library assets remain available.</p>
      {currentProjects.length > 0 ? <><p>{currentProjects.length} project{currentProjects.length === 1 ? "" : "s"} will no longer have this active Brand Kit:</p><ul>{currentProjects.map((project) => <li key={project.id}>{project.title}</li>)}</ul></> : <p>No active projects are linked to this Brand Kit.</p>}
      <label><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I reviewed the affected projects and want to delete this Brand Kit.</label>
      {message ? <p role="alert">{message}</p> : null}
    </DialogBody>
    <DialogFooter><Button variant="secondary" disabled={pending} onClick={onClose}>Cancel</Button><Button variant="danger" disabled={!confirmed || pending} onClick={() => void remove()}>Delete Brand Kit</Button></DialogFooter>
  </Dialog>;
}
