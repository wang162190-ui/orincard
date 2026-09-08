import { createHash, randomUUID } from "node:crypto";

const API_URL = "https://api.pexels.com/v1";
const MAX_IMAGE_BYTES = 50 * 1024 * 1024;
const ORIENTATIONS = ["landscape", "portrait", "square"] as const;

export type PexelsOrientation = (typeof ORIENTATIONS)[number];

export type PexelsQuota = Readonly<{
  limit: number | null;
  remaining: number | null;
  resetsAt: string | null;
}>;

export type StockPhoto = Readonly<{
  providerId: string;
  title: string;
  previewUrl: string;
  sourceUrl: string;
  photographer: string;
  photographerUrl: string;
  width: number;
  height: number;
}>;

export class PexelsError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "UPSTREAM_UNAVAILABLE" | "QUOTA_EXCEEDED" | "UNSUPPORTED_FORMAT",
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "PexelsError";
  }
}

type PexelsResponse = Readonly<{ photos?: unknown; next_page?: unknown }>;
type PexelsPhoto = Readonly<Record<string, unknown>>;

export interface PexelsClient {
  search(input: { readonly query: string; readonly orientation?: PexelsOrientation; readonly page?: number }): Promise<{
    readonly items: readonly StockPhoto[];
    readonly nextPage: number | null;
    readonly quota: PexelsQuota;
  }>;
  getPhoto(providerId: string): Promise<{ readonly photo: StockPhoto; readonly originalUrl: string; readonly quota: PexelsQuota }>;
}

function quota(headers: Headers): PexelsQuota {
  const number = (name: string) => {
    const value = headers.get(name);
    return value !== null && /^\d+$/.test(value) ? Number(value) : null;
  };
  const reset = number("x-ratelimit-reset");
  return { limit: number("x-ratelimit-limit"), remaining: number("x-ratelimit-remaining"), resetsAt: reset === null ? null : new Date(reset * 1000).toISOString() };
}

function trustedPexelsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "images.pexels.com" || url.hostname === "www.pexels.com") ? url.toString() : null;
  } catch {
    return null;
  }
}

function photo(value: unknown): { readonly photo: StockPhoto; readonly originalUrl: string } | null {
  if (typeof value !== "object" || value === null) return null;
  const row = value as PexelsPhoto;
  const src = typeof row.src === "object" && row.src !== null ? row.src as Record<string, unknown> : null;
  const id = typeof row.id === "number" || typeof row.id === "string" ? String(row.id) : "";
  const previewUrl = trustedPexelsUrl(src?.medium ?? src?.small);
  const originalUrl = trustedPexelsUrl(src?.original);
  const sourceUrl = trustedPexelsUrl(row.url);
  const photographerUrl = trustedPexelsUrl(row.photographer_url);
  if (!/^\d+$/.test(id) || !previewUrl || !originalUrl || !sourceUrl || !photographerUrl || typeof row.photographer !== "string" || typeof row.width !== "number" || typeof row.height !== "number") return null;
  return { photo: { providerId: id, title: typeof row.alt === "string" ? row.alt : "Pexels photo", previewUrl, sourceUrl, photographer: row.photographer, photographerUrl, width: row.width, height: row.height }, originalUrl };
}

function error(response: Response): PexelsError {
  if (response.status === 401 || response.status === 403) return new PexelsError("UPSTREAM_UNAVAILABLE", "The stock image service is unavailable.", 503, true);
  if (response.status === 404) return new PexelsError("NOT_FOUND", "That Pexels photo is no longer available.", 404);
  if (response.status === 429) return new PexelsError("QUOTA_EXCEEDED", "The stock image quota is exhausted. Try again after it resets.", 429, true);
  return new PexelsError("UPSTREAM_UNAVAILABLE", "The stock image service is temporarily unavailable.", 503, true);
}

export function createPexelsClient(apiKey: string, request: typeof fetch = fetch): PexelsClient {
  if (!apiKey.trim()) throw new Error("PEXELS_API_KEY is required.");
  async function call(path: string) {
    let response: Response;
    try { response = await request(`${API_URL}${path}`, { headers: { Authorization: apiKey } }); }
    catch { throw new PexelsError("UPSTREAM_UNAVAILABLE", "The stock image service is temporarily unavailable.", 503, true); }
    if (!response.ok) throw error(response);
    return response;
  }
  return {
    async search(input) {
      if (!input.query.trim() || input.query.length > 160 || (input.orientation && !ORIENTATIONS.includes(input.orientation))) throw new PexelsError("INVALID_REQUEST", "Provide a short search query and supported orientation.", 400);
      const parameters = new URLSearchParams({ query: input.query.trim(), per_page: "20", page: String(input.page ?? 1) });
      if (input.orientation) parameters.set("orientation", input.orientation);
      const response = await call(`/search?${parameters}`);
      const data = await response.json() as PexelsResponse;
      const items = Array.isArray(data.photos) ? data.photos.map(photo).filter((value): value is NonNullable<typeof value> => value !== null).map((value) => value.photo) : [];
      const nextPage = typeof data.next_page === "string" ? Number(new URL(data.next_page).searchParams.get("page")) || null : null;
      return { items, nextPage, quota: quota(response.headers) };
    },
    async getPhoto(providerId) {
      if (!/^\d{1,20}$/.test(providerId)) throw new PexelsError("INVALID_REQUEST", "Select a photo returned by Pexels.", 400);
      const response = await call(`/photos/${providerId}`);
      const found = photo(await response.json());
      if (!found) throw new PexelsError("UPSTREAM_UNAVAILABLE", "Pexels returned an invalid photo record.", 503, true);
      return { ...found, quota: quota(response.headers) };
    },
  };
}

export interface StockAssetStore {
  upload(objectKey: string, bytes: Uint8Array, mime: string): Promise<void>;
  create(input: Readonly<Record<string, unknown>>): Promise<{ readonly id: string }>;
  remove(objectKey: string): Promise<void>;
}

export async function importPexelsPhoto(input: { readonly ownerId: string; readonly providerId: string; readonly licenseConfirmed: boolean; readonly client: PexelsClient; readonly store: StockAssetStore; readonly request?: typeof fetch; readonly createId?: () => string }) {
  if (!input.ownerId) throw new PexelsError("AUTH_REQUIRED", "Sign in before importing a stock image.", 401);
  if (!input.licenseConfirmed) throw new PexelsError("INVALID_REQUEST", "Confirm the Pexels license before importing this image.", 400);
  const resolved = await input.client.getPhoto(input.providerId);
  let download: Response;
  try { download = await (input.request ?? fetch)(resolved.originalUrl); }
  catch { throw new PexelsError("UPSTREAM_UNAVAILABLE", "The selected Pexels image could not be downloaded.", 503, true); }
  const mime = download.headers.get("content-type")?.split(";", 1)[0] ?? "";
  if (!download.ok) throw new PexelsError("UPSTREAM_UNAVAILABLE", "The selected Pexels image could not be downloaded.", 503, true);
  if (!['image/jpeg', 'image/png', 'image/webp'].includes(mime)) throw new PexelsError("UNSUPPORTED_FORMAT", "The selected Pexels image has an unsupported format.", 422);
  const bytes = new Uint8Array(await download.arrayBuffer());
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) throw new PexelsError("UNSUPPORTED_FORMAT", "The selected Pexels image is too large to import.", 422);
  const objectKey = `${input.ownerId}/${(input.createId ?? randomUUID)()}/pexels-${resolved.photo.providerId}.${mime.split('/')[1]}`;
  await input.store.upload(objectKey, bytes, mime);
  try {
    const asset = await input.store.create({ owner_id: input.ownerId, kind: 'stock', purpose: 'media', bucket: 'assets', object_key: objectKey, mime, bytes: bytes.byteLength, sha256: createHash('sha256').update(bytes).digest('hex'), width: resolved.photo.width, height: resolved.photo.height, state: 'ready', library_retained: true, rights: { provider: 'pexels', providerId: resolved.photo.providerId, sourceUrl: resolved.photo.sourceUrl, photographer: resolved.photo.photographer, photographerUrl: resolved.photo.photographerUrl, license: 'Pexels License', licenseConfirmedAt: new Date().toISOString() } });
    return { assetId: asset.id, photo: resolved.photo, quota: resolved.quota };
  } catch (cause) {
    await input.store.remove(objectKey).catch(() => undefined);
    throw cause;
  }
}
