"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { Button, Panel, PanelBody, PanelHeader } from "@/components/ui";
import { DEFAULT_BRAND_SETTINGS, type BrandKit, type BrandProjectImpact, type BrandSettings } from "@/server/brands";
import { DeleteBrandDialog } from "./delete-dialog";

type KitResponse = Readonly<{ data?: { kits?: readonly BrandKit[] }; error?: { message?: string } }>;
type ImpactResponse = Readonly<{ data?: { kit?: BrandKit; affectedProjects?: readonly BrandProjectImpact[] }; error?: { message?: string } }>;

export function BrandEditor({ fetcher = fetch }: { readonly fetcher?: typeof fetch }) {
  const t = useTranslations("Brands");
  const [kits, setKits] = useState<readonly BrandKit[]>([]);
  const [selected, setSelected] = useState<BrandKit | null>(null);
  const [name, setName] = useState("");
  const [settings, setSettings] = useState<BrandSettings>(DEFAULT_BRAND_SETTINGS);
  const [status, setStatus] = useState(t("loading"));
  const [deleteImpact, setDeleteImpact] = useState<Readonly<{ kit: BrandKit; affectedProjects: readonly BrandProjectImpact[] }> | null>(null);

  useEffect(() => {
    let active = true;
    fetcher("/api/v1/brand-kits", { cache: "no-store" }).then(async (response) => {
      const body = await response.json() as KitResponse;
      if (!response.ok) throw new Error(body.error?.message ?? t("unavailable"));
      if (!active) return;
      const next = body.data?.kits ?? [];
      setKits(next); setSelected(next[0] ?? null); setStatus(next.length ? t("selectHint") : t("createHint"));
    }).catch((error: unknown) => active && setStatus(error instanceof Error ? error.message : t("unavailable")));
    return () => { active = false; };
  }, [fetcher, t]);

  function choose(kit: BrandKit) { setSelected(kit); setName(kit.name); setSettings(kit.settings); setStatus(t("editing")); }
  async function save() {
    if (!selected) return;
    setStatus(t("saving"));
    const response = await fetcher(`/api/v1/brand-kits/${selected.id}`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedRevision: selected.revision, name: name || selected.name, settings }) });
    const body = await response.json();
    if (!response.ok) return setStatus(body.error?.message ?? t("saveFailed"));
    const kit = body.data.kit as BrandKit;
    setKits((current) => current.map((item) => (item.id === kit.id ? kit : item)));
    setSelected(kit); setName(kit.name); setSettings(kit.settings); setStatus(t("saved"));
  }
  async function create() {
    setStatus(t("creating"));
    const response = await fetcher("/api/v1/brand-kits", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: name || t("untitled"), settings }) });
    const body = await response.json();
    if (!response.ok) return setStatus(body.error?.message ?? t("createFailed"));
    const kit = body.data.kit as BrandKit;
    setKits((current) => [kit, ...current]); setSelected(kit); setName(kit.name); setSettings(kit.settings); setStatus(t("created"));
  }
  async function startDelete() {
    if (!selected) return;
    setStatus(t("checkingImpact"));
    try {
      const response = await fetcher(`/api/v1/brand-kits/${selected.id}`, { cache: "no-store" });
      const body = await response.json() as ImpactResponse;
      if (!response.ok || !body.data?.kit || !body.data.affectedProjects) throw new Error(body.error?.message ?? t("impactUnavailable"));
      setDeleteImpact({ kit: body.data.kit, affectedProjects: body.data.affectedProjects });
      setStatus(t("reviewImpact"));
    } catch (error) { setStatus(error instanceof Error ? error.message : t("impactUnavailable")); }
  }
  function update<K extends keyof BrandSettings>(key: K, value: BrandSettings[K]) { setSettings((current) => ({ ...current, [key]: value })); }

  return <div className="stack" style={{ gap: 20 }}>
    <div className="row" style={{ justifyContent: "space-between" }}><p className="meta">{t("privacyNote")}</p><Button size="small" onClick={() => { setSelected(null); setName(""); setSettings(DEFAULT_BRAND_SETTINGS); setStatus(t("emptyHint")); }}>{t("newKit")}</Button></div>
    <div style={{ display: "grid", gridTemplateColumns: "minmax(180px, 0.4fr) minmax(0, 1fr)", gap: 20 }}>
      <nav aria-label={t("listLabel")}>{kits.length === 0 ? <p className="meta">{t("empty")}</p> : <ul>{kits.map((kit) => <li key={kit.id}><button type="button" aria-current={selected?.id === kit.id ? "true" : undefined} onClick={() => choose(kit)}>{kit.name}</button></li>)}</ul>}</nav>
      <Panel><PanelHeader><h2 className="h3">{selected ? t("editHeading") : t("newKit")}</h2></PanelHeader><PanelBody><div className="stack" style={{ gap: 14 }}>
        <label>{t("kitName")}<input value={name} maxLength={100} onChange={(event) => setName(event.target.value)} /></label>
        <label>{t("displayName")}<input value={settings.displayName ?? ""} maxLength={100} onChange={(event) => update("displayName", event.target.value || null)} /></label>
        <label>{t("website")}<input value={settings.website ?? ""} placeholder="https://example.com" onChange={(event) => update("website", event.target.value || null)} /></label>
        <label>{t("cta")}<input value={settings.cta ?? ""} maxLength={18} onChange={(event) => update("cta", event.target.value || null)} /></label>
        <label>{t("colors")}<input value={settings.colors.join(", ")} onChange={(event) => update("colors", event.target.value.split(",").map((color) => color.trim()).filter(Boolean))} /></label>
        <label>{t("fontPair")}<select value={settings.fontPairId} onChange={(event) => update("fontPairId", event.target.value)}><option value="serif-sans">{t("fontSerifSans")}</option><option value="sans-serif">{t("fontSansSerif")}</option><option value="mono-sans">{t("fontMonoSans")}</option></select></label>
        <label><input type="checkbox" checked={settings.counterDefaults.visible} onChange={(event) => update("counterDefaults", { ...settings.counterDefaults, visible: event.target.checked })} /> {t("showCounter")}</label>
        <label>{t("counterStyle")}<select value={settings.counterDefaults.style} onChange={(event) => update("counterDefaults", { ...settings.counterDefaults, style: event.target.value as BrandSettings["counterDefaults"]["style"] })}><option value="fraction">{t("counterFraction")}</option><option value="number">{t("counterNumber")}</option><option value="none">{t("counterHidden")}</option></select></label>
        {selected ? <><p className="meta">{t("applyNote")}</p><div className="row" style={{ gap: 10 }}><Button onClick={() => void save()}>{t("save")}</Button><Button variant="danger" onClick={() => void startDelete()}>{t("delete")}</Button></div></> : <Button onClick={create}>{t("create")}</Button>}
      </div></PanelBody></Panel>
    </div>
    <p role="status">{status}</p>
    {deleteImpact ? <DeleteBrandDialog kit={deleteImpact.kit} affectedProjects={deleteImpact.affectedProjects} fetcher={fetcher} onClose={() => setDeleteImpact(null)} onDeleted={() => {
      setKits((current) => current.filter((kit) => kit.id !== deleteImpact.kit.id));
      setSelected(null); setName(""); setSettings(DEFAULT_BRAND_SETTINGS); setDeleteImpact(null); setStatus(t("deleted"));
    }} /> : null}
  </div>;
}
