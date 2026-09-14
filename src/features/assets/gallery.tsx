"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";

type Result = { readonly providerId: string; readonly title: string; readonly previewUrl: string; readonly sourceUrl: string; readonly photographer: string; readonly photographerUrl: string };

export function StockGallery({ onImport }: { readonly onImport?: (assetId: string) => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly Result[]>([]);
  const [message, setMessage] = useState("");
  const t = useTranslations("Gallery");
  async function search(event: React.FormEvent) {
    event.preventDefault(); setMessage("");
    const response = await fetch(`/api/v1/assets/search?query=${encodeURIComponent(query)}`);
    const body = await response.json();
    if (!response.ok) return setMessage(body.error?.message ?? t("searchFailed"));
    setItems(body.data.items);
  }
  async function select(providerId: string) {
    setMessage("");
    const response = await fetch("/api/v1/assets/import-stock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId, licenseConfirmed: true }) });
    const body = await response.json();
    if (!response.ok) return setMessage(body.error?.message ?? t("importFailed"));
    onImport?.(body.data.assetId); setMessage(t("imported"));
  }
  return <section aria-label={t("label")}><form onSubmit={search}><label>{t("search")}<input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={160} required /></label><button type="submit">{t("submit")}</button></form><p><a href="https://www.pexels.com" target="_blank" rel="noreferrer">{t("attribution")}</a></p><div>{items.map((item) => <article key={item.providerId}><img src={item.previewUrl} alt={item.title} /><p>{item.title}</p><p>{t("photoBy")} <a href={item.photographerUrl} target="_blank" rel="noreferrer">{item.photographer}</a> {t("onPexels")} <a href={item.sourceUrl} target="_blank" rel="noreferrer">Pexels</a></p><button type="button" onClick={() => select(item.providerId)}>{t("import")}</button></article>)}</div><p role="status">{message}</p></section>;
}
