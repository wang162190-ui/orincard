"use client";
import { useLocale, useTranslations } from "next-intl";
import { WorkspacePage } from "@/components/workspace-page";
import { curatedAssets, curatedLabel, type CuratedAsset } from "@/features/assets/curated";
import { StockGallery } from "@/features/assets/gallery";
import { useState } from "react";

export default function AssetsPage() {
  const t = useTranslations("Assets");
  const locale = useLocale();
  const [tab, setTab] = useState<"curated" | "mine" | "search">("curated");
  const [selected, setSelected] = useState<CuratedAsset | null>(null);
  return <WorkspacePage title={t("title")}><div className="stack-lg"><header><p className="eyebrow">{t("eyebrow")}</p><h1>{t("heading")}</h1><p className="lead">{t("lead")}</p></header><div className="row wrap" role="tablist">{([["curated", t("curated")], ["mine", t("mine")], ["search", t("search")]] as const).map(([id, label]) => <button key={id} role="tab" aria-selected={tab === id} onClick={() => setTab(id)}>{label}</button>)}</div>{tab === "curated" ? <div className="asset-grid">{curatedAssets.map((asset) => <button className="asset-tile" key={asset.id} onClick={() => setSelected(asset)}><img src={asset.src} alt={curatedLabel(asset.alt, locale)} width={asset.width} height={asset.height} loading="lazy" /><p>{curatedLabel(asset.title, locale)}</p><span className="meta">{t("original")}</span></button>)}</div> : tab === "mine" ? <div className="card"><p>{t("mineHint")}</p><a className="btn btn-primary" href="/editor">{t("openEditor")}</a></div> : <StockGallery />}{selected ? <dialog open className="asset-lightbox" onClick={() => setSelected(null)}><img src={selected.src} alt={curatedLabel(selected.alt, locale)} width={selected.width} height={selected.height} /><p>{curatedLabel(selected.title, locale)}</p><button onClick={() => setSelected(null)}>{t("close")}</button></dialog> : null}</div></WorkspacePage>;
}
