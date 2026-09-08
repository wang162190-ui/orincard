"use client";

import { useEffect, useMemo, useState } from "react";
import type { CarouselDocument } from "../../domain/document";
import type { SlideRenderAsset } from "../../render/slide";
import { StockGallery } from "./gallery";
import { MediaPanel, type MediaAsset, type MediaSource } from "./media-panel";

type LibraryItem = Readonly<{
  id: string; kind: "upload" | "stock" | "screenshot" | "ai_image" | "portrait" | "audio" | "derived";
  mime: string; state: string; acceptedAt: string | null; previewUrl: string | null;
}>;

type LibraryResponse = Readonly<{ data?: { items?: readonly LibraryItem[] }; error?: { message?: string } }>;

function sourceFor(kind: LibraryItem["kind"]): MediaSource | null {
  if (kind === "upload") return "upload";
  if (kind === "stock") return "stock";
  if (kind === "screenshot") return "screenshot";
  if (kind === "ai_image") return "generated";
  if (kind === "portrait") return "portrait";
  return null;
}

function isSelectable(item: LibraryItem): boolean {
  return item.state === "ready" && (item.kind !== "ai_image" && item.kind !== "portrait" || item.acceptedAt !== null);
}

function asMedia(item: LibraryItem): MediaAsset | null {
  const source = sourceFor(item.kind);
  if (!source || !isSelectable(item)) return null;
  return {
    id: item.id,
    label: item.kind === "stock" ? "Pexels image" : item.kind === "ai_image" ? "AI image" : item.kind === "portrait" ? "Portrait" : item.kind === "screenshot" ? "Screenshot" : "Upload",
    source,
    previewUrl: item.previewUrl ?? undefined,
    assetRef: { id: item.id, kind: item.kind === "upload" ? "upload" : item.kind === "screenshot" ? "screenshot" : item.kind === "stock" ? "library" : "generated", mimeType: item.mime, rightsStatus: item.kind === "upload" ? "user_asserted" : "verified" },
  };
}

async function json(response: Response): Promise<LibraryResponse> {
  return response.json().catch(() => ({}));
}

async function sha256(file: File): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest("SHA-256", await file.arrayBuffer()));
  return Array.from(bytes).map((value) => value.toString(16).padStart(2, "0")).join("");
}

export function EditorMedia({ document, selectedSlideId, onDocumentChange, onRenderAssetsChange }: {
  readonly document: CarouselDocument;
  readonly selectedSlideId: string;
  readonly onDocumentChange: (document: CarouselDocument) => void;
  readonly onRenderAssetsChange: (assets: Readonly<Record<string, SlideRenderAsset>>) => void;
}) {
  const [items, setItems] = useState<readonly LibraryItem[]>([]);
  const [source, setSource] = useState<MediaSource | null>(null);
  const [prompt, setPrompt] = useState("");
  const [referenceAssetId, setReferenceAssetId] = useState("");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);

  async function load() {
    try {
      const response = await fetch("/api/v1/assets?limit=50", { cache: "no-store" });
      const body = await json(response);
      if (!response.ok) { setMessage(body.error?.message ?? "Your media library is unavailable."); return; }
      const next = body.data?.items ?? [];
      setItems(next);
      onRenderAssetsChange(Object.fromEntries(next.filter(isSelectable).flatMap((item) => item.previewUrl ? [[item.id, { id: item.id, src: item.previewUrl, state: "ready" as const, alt: "Library media" }]] : [])));
    } catch { setMessage("Your media library is unavailable."); }
  }

  useEffect(() => { void load(); }, []);
  const assets = useMemo(() => items.map(asMedia).filter((item): item is MediaAsset => item !== null), [items]);

  async function request(path: string, body: Record<string, unknown>) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await json(response);
      if (!response.ok) throw new Error(result.error?.message ?? "The media request failed.");
      setMessage("Request submitted. The item will appear when it is ready.");
      setPrompt(""); setUrl(""); setSource(null);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The media request failed."); }
    finally { setBusy(false); }
  }

  async function accept(item: LibraryItem) {
    await request(`/api/v1/assets/${encodeURIComponent(item.id)}/accept`, { rightsConfirmation: true, keepInLibrary: true });
  }

  async function remove(item: LibraryItem) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(`/api/v1/assets/${encodeURIComponent(item.id)}`, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedState: item.state }) });
      const result = await json(response);
      if (!response.ok) throw new Error(result.error?.message ?? "This media item could not be removed.");
      setMessage("Removed from your media library."); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "This media item could not be removed."); }
    finally { setBusy(false); }
  }

  async function upload() {
    if (!file) { setMessage("Choose an image first."); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/v1/assets/upload-intent", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `media-${crypto.randomUUID()}` }, body: JSON.stringify({ originalName: file.name, declaredMime: file.type, size: file.size, sha256: await sha256(file), purpose: "media", rightsConfirmation: true }) });
      const body = await json(response) as LibraryResponse & { data?: { assetId: string; bucket: string; objectKey: string; upload: { token: string } } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? "Upload could not start.");
      const { createBrowserSupabaseClient } = await import("../auth/client");
      const client = createBrowserSupabaseClient();
      const { error } = await client.storage.from(body.data.bucket).uploadToSignedUrl(body.data.objectKey, body.data.upload.token, file, { contentType: file.type });
      if (error) throw new Error("The image could not be uploaded.");
      const complete = await fetch(`/api/v1/assets/${encodeURIComponent(body.data.assetId)}/complete`, { method: "POST", headers: { "content-type": "application/json" } });
      if (!complete.ok) throw new Error("The upload could not be checked.");
      setMessage("Upload submitted. It will appear after validation."); setFile(null); setSource(null); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : "The image could not be uploaded."); }
    finally { setBusy(false); }
  }

  function addEmoji(emoji: string) {
    const id = `local-emoji-${emoji.codePointAt(0)?.toString(16) ?? "image"}`;
    const src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><text x="64" y="92" text-anchor="middle" font-size="96">${emoji}</text></svg>`)}`;
    onRenderAssetsChange({ [id]: { id, src, state: "ready", alt: emoji } });
    onDocumentChange({ ...document, assetRefs: document.assetRefs.some((asset) => asset.id === id) ? document.assetRefs : [...document.assetRefs, { id, kind: "generated", mimeType: "image/svg+xml", rightsStatus: "verified" }] });
    setSource(null); setMessage("Choose the emoji from Available media.");
  }

  const emojiAssets = source === "emoji" ? ["✨", "💡", "📈"].map((emoji) => ({ id: `local-emoji-${emoji.codePointAt(0)?.toString(16)}`, label: emoji, source: "emoji" as const, assetRef: { id: `local-emoji-${emoji.codePointAt(0)?.toString(16)}`, kind: "generated" as const, mimeType: "image/svg+xml", rightsStatus: "verified" as const } })) : [];
  return <div className="stack" style={{ gap: 12 }}>
    <MediaPanel assets={[...assets, ...emojiAssets]} document={document} onDocumentChange={onDocumentChange} onRequestSource={setSource} selectedSlideId={selectedSlideId} />
    <button onClick={() => void load()} type="button">Refresh media library</button>
    {source === "stock" ? <StockGallery onImport={() => { setMessage("Imported to your library."); void load(); }} /> : null}
    {source === "screenshot" ? <form onSubmit={(event) => { event.preventDefault(); void request("/api/v1/assets/screenshot", { publicUrl: url }); }}><label>Public URL<input aria-label="Screenshot URL" onChange={(event) => setUrl(event.target.value)} required type="url" value={url} /></label><button disabled={busy} type="submit">Capture screenshot</button></form> : null}
    {source === "generated" || source === "portrait" ? <form onSubmit={(event) => { event.preventDefault(); void request("/api/v1/assets/generate", { kind: source === "portrait" ? "portrait" : "ai_image", prompt, ...(source === "portrait" ? { referenceAssetId } : {}) }); }}><label>Image prompt<textarea aria-label="Image prompt" maxLength={1000} onChange={(event) => setPrompt(event.target.value)} required value={prompt} /></label>{source === "portrait" ? <label>Reference image<select aria-label="Portrait reference image" onChange={(event) => setReferenceAssetId(event.target.value)} required value={referenceAssetId}><option value="">Choose an image</option>{assets.filter((asset) => asset.assetRef.mimeType !== "image/svg+xml").map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>)}</select></label> : null}<button disabled={busy || source === "portrait" && !referenceAssetId} type="submit">Generate {source === "portrait" ? "portrait" : "image"}</button></form> : null}
    {source === "upload" ? <div><label>Image file<input accept="image/png,image/jpeg,image/webp" aria-label="Image file" onChange={(event) => setFile(event.target.files?.[0] ?? null)} type="file" /></label><button disabled={busy} onClick={() => void upload()} type="button">Upload image</button></div> : null}
    {source === "emoji" ? <div aria-label="Emoji media">{["✨", "💡", "📈"].map((emoji) => <button key={emoji} onClick={() => addEmoji(emoji)} type="button">Add {emoji}</button>)}</div> : null}
    {items.some((item) => (item.kind === "ai_image" || item.kind === "portrait") && item.state === "ready" && item.acceptedAt === null) ? <div aria-label="Image candidates">{items.filter((item) => (item.kind === "ai_image" || item.kind === "portrait") && item.state === "ready" && item.acceptedAt === null).map((item) => <div key={item.id}><span>{item.kind === "portrait" ? "Portrait candidate" : "AI image candidate"}</span><button disabled={busy} onClick={() => void accept(item)} type="button">Accept candidate</button><button disabled={busy} onClick={() => void remove(item)} type="button">Discard candidate</button></div>)}</div> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
