"use client";

import { useEffect, useState } from "react";
import { Button, Panel, PanelBody, PanelHeader } from "@/components/ui";
import { DEFAULT_BRAND_SETTINGS, type BrandKit, type BrandSettings } from "@/server/brands";

type KitResponse = Readonly<{ data?: { kits?: readonly BrandKit[] }; error?: { message?: string } }>;

export function BrandEditor({ fetcher = fetch }: { readonly fetcher?: typeof fetch }) {
  const [kits, setKits] = useState<readonly BrandKit[]>([]);
  const [selected, setSelected] = useState<BrandKit | null>(null);
  const [name, setName] = useState("");
  const [settings, setSettings] = useState<BrandSettings>(DEFAULT_BRAND_SETTINGS);
  const [status, setStatus] = useState("Loading Brand Kits…");

  useEffect(() => {
    let active = true;
    fetcher("/api/v1/brand-kits", { cache: "no-store" }).then(async (response) => {
      const body = await response.json() as KitResponse;
      if (!response.ok) throw new Error(body.error?.message ?? "Brand Kits are unavailable.");
      if (!active) return;
      const next = body.data?.kits ?? [];
      setKits(next); setSelected(next[0] ?? null); setStatus(next.length ? "Select a Brand Kit to view its details." : "Create a Brand Kit to save your identity.");
    }).catch((error: unknown) => active && setStatus(error instanceof Error ? error.message : "Brand Kits are unavailable."));
    return () => { active = false; };
  }, [fetcher]);

  function choose(kit: BrandKit) { setSelected(kit); setName(kit.name); setSettings(kit.settings); setStatus("Editing a local draft. Saving existing kits will be enabled with revision handling."); }
  async function create() {
    setStatus("Creating Brand Kit…");
    const response = await fetcher("/api/v1/brand-kits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name || "Untitled Brand Kit", settings }) });
    const body = await response.json();
    if (!response.ok) return setStatus(body.error?.message ?? "Brand Kit could not be created.");
    const kit = body.data.kit as BrandKit;
    setKits((current) => [kit, ...current]); setSelected(kit); setName(kit.name); setSettings(kit.settings); setStatus("Brand Kit created.");
  }
  function update<K extends keyof BrandSettings>(key: K, value: BrandSettings[K]) { setSettings((current) => ({ ...current, [key]: value })); }

  return <div className="stack" style={{ gap: 20 }}>
    <div className="row" style={{ justifyContent: "space-between" }}><p className="meta">Brand Kits are private to your account. Applying one copies its settings to a project.</p><Button size="small" onClick={() => { setSelected(null); setName(""); setSettings(DEFAULT_BRAND_SETTINGS); setStatus("Enter your brand details, then create the kit."); }}>New Brand Kit</Button></div>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 0.4fr) minmax(0, 1fr)", gap: 20 }}>
      <nav aria-label="Brand Kits">{kits.length === 0 ? <p className="meta">No Brand Kits yet.</p> : <ul>{kits.map((kit) => <li key={kit.id}><button type="button" aria-current={selected?.id === kit.id ? "true" : undefined} onClick={() => choose(kit)}>{kit.name}</button></li>)}</ul>}</nav>
      <Panel><PanelHeader><h2 className="h3">{selected ? "Edit Brand Kit" : "New Brand Kit"}</h2></PanelHeader><PanelBody><div className="stack" style={{ gap: 14 }}>
        <label>Kit name<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
        <label>Display name<input value={settings.displayName ?? ""} maxLength={100} onChange={(event) => update("displayName", event.target.value || null)} /></label>
        <label>Website<input value={settings.website ?? ""} placeholder="https://example.com" onChange={(event) => update("website", event.target.value || null)} /></label>
        <label>Call to action<input value={settings.cta ?? ""} maxLength={18} onChange={(event) => update("cta", event.target.value || null)} /></label>
        <label>Colours (comma-separated hex values)<input value={settings.colors.join(", ")} onChange={(event) => update("colors", event.target.value.split(",").map((color) => color.trim()).filter(Boolean))} /></label>
        <label>Font pair<select value={settings.fontPairId} onChange={(event) => update("fontPairId", event.target.value)}><option value="serif-sans">Editorial serif + sans</option><option value="sans-serif">Grotesk sans + serif</option><option value="mono-sans">Monospace + sans</option></select></label>
        <label><input type="checkbox" checked={settings.counterDefaults.visible} onChange={(event) => update("counterDefaults", { ...settings.counterDefaults, visible: event.target.checked })} /> Show page numbers by default</label>
        <label>Page number format<select value={settings.counterDefaults.style} onChange={(event) => update("counterDefaults", { ...settings.counterDefaults, style: event.target.value as BrandSettings["counterDefaults"]["style"] })}><option value="fraction">01 / 06</option><option value="number">1</option><option value="none">Hidden</option></select></label>
        {selected ? <p className="meta">Changes remain in this editor until the revision-aware save route is available.</p> : <Button onClick={create}>Create Brand Kit</Button>}
      </div></PanelBody></Panel>
    </div>
    <p role="status">{status}</p>
  </div>;
}
