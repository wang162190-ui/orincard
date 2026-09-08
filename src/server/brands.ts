import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const COLOUR_PATTERN = /^#[0-9a-f]{6}$/i;

export type CounterStyle = "none" | "number" | "fraction";

export type BrandSettings = Readonly<{
  displayName: string | null;
  website: string | null;
  cta: string | null;
  colors: readonly string[];
  fontPairId: string;
  logoAssetId: string | null;
  headshotAssetId: string | null;
  counterDefaults: Readonly<{ visible: boolean; style: CounterStyle }>;
}>;

export type BrandKit = Readonly<{
  id: string;
  name: string;
  settings: BrandSettings;
  revision: number;
  updatedAt: string;
}>;

export class BrandServiceError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "VERSION_CONFLICT" | "ASSET_NOT_AVAILABLE" | "SERVICE_UNAVAILABLE",
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "BrandServiceError";
  }
}

type BrandRow = Readonly<{ id: string; name: string; settings: unknown; revision: number; updated_at: string }>;

export interface BrandStore {
  list(ownerId: string, limit: number): Promise<readonly BrandRow[]>;
  create(input: Readonly<{ ownerId: string; name: string; settings: BrandSettings }>): Promise<BrandRow>;
  update(input: Readonly<{ ownerId: string; brandKitId: string; expectedRevision: number; name: string; settings: BrandSettings }>): Promise<BrandRow | null>;
  availableAssetIds(ownerId: string, assetIds: readonly string[]): Promise<readonly string[]>;
}

export const DEFAULT_BRAND_SETTINGS: BrandSettings = {
  displayName: null,
  website: null,
  cta: null,
  colors: ["#171717", "#F7F3EB", "#E85D3F"],
  fontPairId: "serif-sans",
  logoAssetId: null,
  headshotAssetId: null,
  counterDefaults: { visible: true, style: "fraction" },
};

function nullableText(value: unknown, field: string, maximum: number): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || value.trim().length > maximum) {
    throw new BrandServiceError("INVALID_REQUEST", `${field} is invalid.`, 422);
  }
  return value.trim();
}

function website(value: unknown): string | null {
  const result = nullableText(value, "Website", 300);
  if (result === null) return null;
  try {
    const parsed = new URL(result);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    return parsed.toString();
  } catch {
    throw new BrandServiceError("INVALID_REQUEST", "Website must be a valid URL.", 422);
  }
}

function assetId(value: unknown, field: string): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new BrandServiceError("INVALID_REQUEST", `${field} must be a valid asset ID.`, 422);
  }
  return value;
}

export function parseBrandSettings(value: unknown): BrandSettings {
  if (value === undefined) return DEFAULT_BRAND_SETTINGS;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrandServiceError("INVALID_REQUEST", "Brand settings must be an object.", 422);
  }
  const input = value as Record<string, unknown>;
  const colors = input.colors === undefined ? DEFAULT_BRAND_SETTINGS.colors : input.colors;
  if (!Array.isArray(colors) || colors.length < 1 || colors.length > 8 || colors.some((color) => typeof color !== "string" || !COLOUR_PATTERN.test(color))) {
    throw new BrandServiceError("INVALID_REQUEST", "Provide one to eight hex colours.", 422);
  }
  const fontPairId = input.fontPairId === undefined ? DEFAULT_BRAND_SETTINGS.fontPairId : input.fontPairId;
  if (typeof fontPairId !== "string" || !/^[a-z0-9-]{1,64}$/i.test(fontPairId)) {
    throw new BrandServiceError("INVALID_REQUEST", "Font selection is invalid.", 422);
  }
  const counter = input.counterDefaults === undefined ? DEFAULT_BRAND_SETTINGS.counterDefaults : input.counterDefaults;
  if (typeof counter !== "object" || counter === null || Array.isArray(counter) || typeof (counter as Record<string, unknown>).visible !== "boolean" || !["none", "number", "fraction"].includes(String((counter as Record<string, unknown>).style))) {
    throw new BrandServiceError("INVALID_REQUEST", "Counter defaults are invalid.", 422);
  }
  return {
    displayName: nullableText(input.displayName, "Display name", 100),
    website: website(input.website),
    cta: nullableText(input.cta, "Call to action", 18),
    colors: colors.map((color) => (color as string).toUpperCase()),
    fontPairId,
    logoAssetId: assetId(input.logoAssetId, "Logo"),
    headshotAssetId: assetId(input.headshotAssetId, "Headshot"),
    counterDefaults: { visible: (counter as Record<string, unknown>).visible as boolean, style: (counter as Record<string, unknown>).style as CounterStyle },
  };
}

function name(value: unknown): string {
  if (typeof value !== "string" || value.trim().length < 1 || value.trim().length > 100) {
    throw new BrandServiceError("INVALID_REQUEST", "Brand Kit name must be between 1 and 100 characters.", 422);
  }
  return value.trim();
}

function brandFromRow(row: BrandRow): BrandKit {
  return { id: row.id, name: row.name, settings: parseBrandSettings(row.settings), revision: Number(row.revision), updatedAt: row.updated_at };
}

async function assertOwnedAssets(store: BrandStore, ownerId: string, settings: BrandSettings): Promise<void> {
  const requested = [settings.logoAssetId, settings.headshotAssetId].filter((id): id is string => id !== null);
  if (requested.length === 0) return;
  const available = new Set(await store.availableAssetIds(ownerId, requested));
  if (requested.some((id) => !available.has(id))) {
    throw new BrandServiceError("ASSET_NOT_AVAILABLE", "Choose a ready asset from your own library.", 422);
  }
}

export function createBrandService(store: BrandStore) {
  return {
    async list(ownerId: string, limit?: unknown): Promise<readonly BrandKit[]> {
      const requested = Number(limit ?? 20);
      const safeLimit = Number.isSafeInteger(requested) ? Math.max(1, Math.min(50, requested)) : 20;
      try { return (await store.list(ownerId, safeLimit)).map(brandFromRow); }
      catch (error) { if (error instanceof BrandServiceError) throw error; throw new BrandServiceError("SERVICE_UNAVAILABLE", "Brand Kits are temporarily unavailable.", 503, true); }
    },
    async create(ownerId: string, input: Readonly<{ name?: unknown; settings?: unknown }>): Promise<BrandKit> {
      const settings = parseBrandSettings(input.settings);
      await assertOwnedAssets(store, ownerId, settings);
      try { return brandFromRow(await store.create({ ownerId, name: name(input.name), settings })); }
      catch (error) { if (error instanceof BrandServiceError) throw error; throw new BrandServiceError("SERVICE_UNAVAILABLE", "Brand Kit could not be created.", 503, true); }
    },
    async update(ownerId: string, brandKitId: string, input: Readonly<{ expectedRevision: unknown; name: unknown; settings: unknown }>): Promise<BrandKit> {
      if (!UUID_PATTERN.test(brandKitId)) throw new BrandServiceError("NOT_FOUND", "Brand Kit not found.", 404);
      if (!Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) throw new BrandServiceError("INVALID_REQUEST", "expectedRevision must be a positive integer.", 422);
      const settings = parseBrandSettings(input.settings);
      await assertOwnedAssets(store, ownerId, settings);
      try {
        const result = await store.update({ ownerId, brandKitId, expectedRevision: Number(input.expectedRevision), name: name(input.name), settings });
        if (!result) throw new BrandServiceError("VERSION_CONFLICT", "This Brand Kit changed in another tab. Reload it before saving.", 409);
        return brandFromRow(result);
      } catch (error) { if (error instanceof BrandServiceError) throw error; throw new BrandServiceError("SERVICE_UNAVAILABLE", "Brand Kit could not be saved.", 503, true); }
    },
  };
}

export function createSupabaseBrandStore(client: SupabaseClient): BrandStore {
  return {
    async list(ownerId, limit) {
      const { data, error } = await client.from("brand_kits").select("id,name,settings,revision,updated_at").eq("owner_id", ownerId).eq("state", "active").order("updated_at", { ascending: false }).order("id", { ascending: false }).limit(limit);
      if (error) throw error;
      return (data ?? []) as BrandRow[];
    },
    async create(input) {
      const { data, error } = await client.from("brand_kits").insert({ owner_id: input.ownerId, name: input.name, settings: input.settings }).select("id,name,settings,revision,updated_at").single();
      if (error || !data) throw error ?? new Error("Brand Kit insert failed");
      return data as BrandRow;
    },
    async update(input) {
      const { data, error } = await client.from("brand_kits").update({ name: input.name, settings: input.settings, revision: input.expectedRevision + 1, updated_at: new Date().toISOString() }).eq("owner_id", input.ownerId).eq("id", input.brandKitId).eq("state", "active").eq("revision", input.expectedRevision).select("id,name,settings,revision,updated_at").maybeSingle();
      if (error) throw error;
      return data as BrandRow | null;
    },
    async availableAssetIds(ownerId, assetIds) {
      const { data, error } = await client.from("assets").select("id,kind,accepted_at").eq("owner_id", ownerId).in("id", assetIds).eq("state", "ready");
      if (error) throw error;
      return (data ?? []).filter((asset) => !["ai_image", "portrait"].includes(String(asset.kind)) || asset.accepted_at !== null).map((asset) => asset.id as string);
    },
  };
}
