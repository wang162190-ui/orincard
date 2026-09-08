"use client";

import { useState } from "react";

type Result = { readonly providerId: string; readonly title: string; readonly previewUrl: string; readonly sourceUrl: string; readonly photographer: string; readonly photographerUrl: string };

export function StockGallery({ onImport }: { readonly onImport?: (assetId: string) => void }) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<readonly Result[]>([]);
  const [message, setMessage] = useState("");
  async function search(event: React.FormEvent) {
    event.preventDefault(); setMessage("");
    const response = await fetch(`/api/v1/assets/search?query=${encodeURIComponent(query)}`);
    const body = await response.json();
    if (!response.ok) return setMessage(body.error?.message ?? "Search failed.");
    setItems(body.data.items);
  }
  async function select(providerId: string) {
    setMessage("");
    const response = await fetch("/api/v1/assets/import-stock", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ providerId, licenseConfirmed: true }) });
    const body = await response.json();
    if (!response.ok) return setMessage(body.error?.message ?? "Import failed.");
    onImport?.(body.data.assetId); setMessage("Imported to your library.");
  }
  return <section aria-label="Pexels stock gallery"><form onSubmit={search}><label>Search Pexels<input value={query} onChange={(event) => setQuery(event.target.value)} maxLength={160} required /></label><button type="submit">Search</button></form><p><a href="https://www.pexels.com" target="_blank" rel="noreferrer">Photos provided by Pexels</a></p><div>{items.map((item) => <article key={item.providerId}><img src={item.previewUrl} alt={item.title} /><p>{item.title}</p><p>Photo by <a href={item.photographerUrl} target="_blank" rel="noreferrer">{item.photographer}</a> on <a href={item.sourceUrl} target="_blank" rel="noreferrer">Pexels</a></p><button type="button" onClick={() => select(item.providerId)}>Import with Pexels license</button></article>)}</div><p role="status">{message}</p></section>;
}
