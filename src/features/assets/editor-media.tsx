"use client";

import { useTranslations } from "next-intl";
import { useEffect, useMemo, useState } from "react";
import type { CarouselDocument } from "../../domain/document";
import type { SlideRenderAsset } from "../../render/slide";
import { StockGallery } from "./gallery";
import { MediaPanel, type MediaAsset, type MediaSource } from "./media-panel";
import { curatedAssets } from "./curated";

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

// 素材标签会进到可访问名里（"Pexels image · stock"），所以必须跟着界面语言走。
// asMedia 不是组件、拿不到 hook，翻译函数从调用处传进来。
function asMedia(item: LibraryItem, t: (key: string) => string): MediaAsset | null {
  const source = sourceFor(item.kind);
  if (!source || !isSelectable(item)) return null;
  return {
    id: item.id,
    label: item.kind === "stock" ? t("labelStock") : item.kind === "ai_image" ? t("labelAiImage") : item.kind === "portrait" ? t("labelPortrait") : item.kind === "screenshot" ? t("labelScreenshot") : t("labelUpload"),
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
  const t = useTranslations("EditorMedia");
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
      if (!response.ok) { setMessage(body.error?.message ?? t("libraryUnavailable")); return; }
      const next = body.data?.items ?? [];
      const curated: LibraryItem[] = document.assetRefs.some((ref) => ref.id.startsWith("local-curated-"))
        ? curatedAssets.map((asset) => ({ id: asset.refId, kind: "stock", mime: "image/png", state: "ready", acceptedAt: new Date().toISOString(), previewUrl: asset.src }))
        : [];
      setItems([...curated, ...next]);
      onRenderAssetsChange(Object.fromEntries([...curated, ...next].filter(isSelectable).flatMap((item) => item.previewUrl ? [[item.id, { id: item.id, src: item.previewUrl, state: "ready" as const, alt: t("libraryAlt"), width: 1536, height: 1024 }]] : [])));
    } catch { setMessage(t("libraryUnavailable")); }
  }

  useEffect(() => { void load(); }, []);
  const assets = useMemo(() => items.map((item) => asMedia(item, t)).filter((item): item is MediaAsset => item !== null), [items, t]);

  async function request(path: string, body: Record<string, unknown>) {
    setBusy(true); setMessage("");
    try {
      const response = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const result = await json(response);
      if (!response.ok) throw new Error(result.error?.message ?? t("requestFailed"));
      setMessage(t("requestSubmitted"));
      setPrompt(""); setUrl(""); setSource(null);
      await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : t("requestFailed")); }
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
      if (!response.ok) throw new Error(result.error?.message ?? t("removeFailed"));
      setMessage(t("removed")); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : t("removeFailed")); }
    finally { setBusy(false); }
  }

  async function upload() {
    if (!file) { setMessage(t("chooseFirst")); return; }
    setBusy(true); setMessage("");
    try {
      const response = await fetch("/api/v1/assets/upload-intent", { method: "POST", headers: { "content-type": "application/json", "idempotency-key": `media-${crypto.randomUUID()}` }, body: JSON.stringify({ originalName: file.name, declaredMime: file.type, size: file.size, sha256: await sha256(file), purpose: "media", rightsConfirmation: true }) });
      const body = await json(response) as LibraryResponse & { data?: { assetId: string; bucket: string; objectKey: string; upload: { token: string } } };
      if (!response.ok || !body.data) throw new Error(body.error?.message ?? t("uploadStartFailed"));
      const { createBrowserSupabaseClient } = await import("../auth/client");
      const client = createBrowserSupabaseClient();
      const { error } = await client.storage.from(body.data.bucket).uploadToSignedUrl(body.data.objectKey, body.data.upload.token, file, { contentType: file.type });
      if (error) throw new Error(t("uploadFailed"));
      const complete = await fetch(`/api/v1/assets/${encodeURIComponent(body.data.assetId)}/complete`, { method: "POST", headers: { "content-type": "application/json" } });
      if (!complete.ok) throw new Error(t("uploadCheckFailed"));
      setMessage(t("uploadSubmitted")); setFile(null); setSource(null); await load();
    } catch (error) { setMessage(error instanceof Error ? error.message : t("uploadFailed")); }
    finally { setBusy(false); }
  }

  function addEmoji(emoji: string) {
    const id = `local-emoji-${emoji.codePointAt(0)?.toString(16) ?? "image"}`;
    const src = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128"><text x="64" y="92" text-anchor="middle" font-size="96">${emoji}</text></svg>`)}`;
    onRenderAssetsChange({ [id]: { id, src, state: "ready", alt: emoji } });
    onDocumentChange({ ...document, assetRefs: document.assetRefs.some((asset) => asset.id === id) ? document.assetRefs : [...document.assetRefs, { id, kind: "generated", mimeType: "image/svg+xml", rightsStatus: "verified" }] });
    setSource(null); setMessage(t("emojiAdded"));
  }

  const emojiAssets = source === "emoji" ? ["✨", "💡", "📈"].map((emoji) => ({ id: `local-emoji-${emoji.codePointAt(0)?.toString(16)}`, label: emoji, source: "emoji" as const, assetRef: { id: `local-emoji-${emoji.codePointAt(0)?.toString(16)}`, kind: "generated" as const, mimeType: "image/svg+xml", rightsStatus: "verified" as const } })) : [];
  return <div className="stack" style={{ gap: 12 }}>
    <MediaPanel assets={[...assets, ...emojiAssets]} document={document} onDocumentChange={onDocumentChange} onRequestSource={setSource} selectedSlideId={selectedSlideId} />
    <button onClick={() => void load()} type="button">{t("refresh")}</button>
    {source === "stock" ? <StockGallery onImport={() => { setMessage(t("imported")); void load(); }} /> : null}
    {source === "screenshot" ? <form onSubmit={(event) => { event.preventDefault(); void request("/api/v1/assets/screenshot", { publicUrl: url }); }}><label>{t("publicUrl")}<input aria-label={t("screenshotUrl")} onChange={(event) => setUrl(event.target.value)} required type="url" value={url} /></label><button disabled={busy} type="submit">{t("capture")}</button></form> : null}
    {source === "generated" || source === "portrait" ? <form onSubmit={(event) => { event.preventDefault(); void request("/api/v1/assets/generate", { kind: source === "portrait" ? "portrait" : "ai_image", prompt, ...(source === "portrait" ? { referenceAssetId } : {}) }); }}><label>{t("imagePrompt")}<textarea aria-label={t("imagePrompt")} maxLength={1000} onChange={(event) => setPrompt(event.target.value)} required value={prompt} /></label>{source === "portrait" ? <label>{t("referenceImage")}<select aria-label={t("referenceImageLabel")} onChange={(event) => setReferenceAssetId(event.target.value)} required value={referenceAssetId}><option value="">{t("chooseImage")}</option>{assets.filter((asset) => asset.assetRef.mimeType !== "image/svg+xml").map((asset) => <option key={asset.id} value={asset.id}>{asset.label}</option>)}</select></label> : null}<button disabled={busy || source === "portrait" && !referenceAssetId} type="submit">{source === "portrait" ? t("generatePortrait") : t("generateImage")}</button></form> : null}
    {source === "upload" ? <div><label>{t("imageFile")}<input accept="image/png,image/jpeg,image/webp" aria-label={t("imageFile")} onChange={(event) => setFile(event.target.files?.[0] ?? null)} type="file" /></label><button disabled={busy} onClick={() => void upload()} type="button">{t("uploadImage")}</button></div> : null}
    {source === "emoji" ? <div aria-label={t("emojiMedia")}>{["✨", "💡", "📈"].map((emoji) => <button key={emoji} onClick={() => addEmoji(emoji)} type="button">{t("addEmoji", { emoji })}</button>)}</div> : null}
    {items.some((item) => (item.kind === "ai_image" || item.kind === "portrait") && item.state === "ready" && item.acceptedAt === null) ? <div aria-label={t("candidates")}>{items.filter((item) => (item.kind === "ai_image" || item.kind === "portrait") && item.state === "ready" && item.acceptedAt === null).map((item) => <div key={item.id}><span>{item.kind === "portrait" ? t("portraitCandidate") : t("imageCandidate")}</span><button disabled={busy} onClick={() => void accept(item)} type="button">{t("accept")}</button><button disabled={busy} onClick={() => void remove(item)} type="button">{t("discard")}</button></div>)}</div> : null}
    {message ? <p role="status">{message}</p> : null}
  </div>;
}
