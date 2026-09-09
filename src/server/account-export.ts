import { createHash } from "node:crypto";
import JSZip from "jszip";
import type { SupabaseClient } from "@supabase/supabase-js";

export type AccountPreferences = {
  readonly language: string;
  readonly tone: string;
  readonly slideCount: number;
  readonly generationInstructions: string;
};

export const DEFAULT_ACCOUNT_PREFERENCES: AccountPreferences = {
  language: "English",
  tone: "professional",
  slideCount: 6,
  generationInstructions: "",
};

export interface AccountPreferencesStore {
  load(ownerId: string): Promise<unknown>;
  save(ownerId: string, preferences: AccountPreferences): Promise<void>;
}

export function createSupabaseAccountPreferencesStore(client: SupabaseClient): AccountPreferencesStore {
  return {
    async load(ownerId) {
      const { data, error } = await client.from("profiles").select("preferences").eq("id", ownerId).eq("status", "active").single();
      if (error) throw new Error("SETTINGS_UNAVAILABLE");
      return data.preferences;
    },
    async save(ownerId, preferences) {
      const { data, error } = await client.from("profiles").update({ preferences }).eq("id", ownerId).eq("status", "active").select("id").maybeSingle();
      if (error || !data) throw new Error("SETTINGS_UNAVAILABLE");
    },
  };
}

export async function loadAccountPreferences(store: AccountPreferencesStore, ownerId: string) {
  return safeStoredPreferences(await store.load(ownerId));
}

export async function saveAccountPreferences(store: AccountPreferencesStore, ownerId: string, value: unknown) {
  const preferences = parseAccountPreferences(value);
  await store.save(ownerId, preferences);
  return preferences;
}

export function parseAccountPreferences(value: unknown): AccountPreferences {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Preferences must be an object.");
  }
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some((key) => !["language", "tone", "slideCount", "generationInstructions"].includes(key)) ||
    typeof input.language !== "string" || input.language.trim().length < 2 || input.language.length > 50 ||
    typeof input.tone !== "string" || input.tone.trim().length < 2 || input.tone.length > 50 ||
    !Number.isInteger(input.slideCount) || Number(input.slideCount) < 2 || Number(input.slideCount) > 20 ||
    typeof input.generationInstructions !== "string" || input.generationInstructions.length > 2_000
  ) {
    throw new Error("Preferences are invalid.");
  }
  return {
    language: input.language.trim(),
    tone: input.tone.trim(),
    slideCount: Number(input.slideCount),
    generationInstructions: input.generationInstructions.trim(),
  };
}

function safeStoredPreferences(value: unknown): AccountPreferences {
  try {
    return parseAccountPreferences({ ...DEFAULT_ACCOUNT_PREFERENCES, ...(typeof value === "object" && value !== null && !Array.isArray(value) ? value : {}) });
  } catch {
    return DEFAULT_ACCOUNT_PREFERENCES;
  }
}

function withoutOwner<T extends Record<string, unknown>>(row: T) {
  const { owner_id: _ownerId, ...safe } = row;
  return safe;
}

async function ownedRows(
  client: SupabaseClient,
  table: string,
  columns: string,
  ownerId: string,
): Promise<Record<string, unknown>[]> {
  const { data, error } = await client.from(table).select(columns).eq("owner_id", ownerId);
  if (error) throw new Error(`ACCOUNT_EXPORT_READ_FAILED:${table}`);
  return (data ?? []).map((row) => withoutOwner(row as unknown as Record<string, unknown>));
}

export async function buildAccountDataPackage(client: SupabaseClient, ownerId: string, exportedAt: string) {
  const [profileResult, projects, versions, brands, sources, assets, exports] = await Promise.all([
    client.from("profiles").select("display_name,preferences,created_at,updated_at").eq("id", ownerId).eq("status", "active").maybeSingle(),
    ownedRows(client, "projects", "id,title,platform,document,revision,brand_kit_id,state,deleted_at,created_at,updated_at", ownerId),
    ownedRows(client, "project_versions", "id,project_id,revision,document,reason,created_at", ownerId),
    ownedRows(client, "brand_kits", "id,name,settings,revision,state,created_at,updated_at", ownerId),
    ownedRows(client, "sources", "id,project_id,kind,asset_id,metadata,segments,state,expires_at,created_at,updated_at", ownerId),
    ownedRows(client, "assets", "id,kind,purpose,mime,bytes,sha256,width,height,duration_ms,rights,accepted_at,library_retained,state,created_at,updated_at", ownerId),
    ownedRows(client, "exports", "id,project_id,project_version_id,job_id,format,options,renderer_version,manifest,asset_id,state,expires_at,created_at", ownerId),
  ]);
  if (profileResult.error || !profileResult.data) throw new Error("ACCOUNT_EXPORT_PROFILE_UNAVAILABLE");

  const data = {
    schemaVersion: 1,
    exportedAt,
    profile: {
      display_name: profileResult.data.display_name,
      preferences: safeStoredPreferences(profileResult.data.preferences),
      created_at: profileResult.data.created_at,
      updated_at: profileResult.data.updated_at,
    },
    projects,
    projectVersions: versions,
    brandKits: brands,
    sources,
    assets,
    exports,
  };
  const zip = new JSZip();
  zip.file("account.json", `${JSON.stringify(data, null, 2)}\n`);
  zip.file("README.txt", "Orincard account data export\nThe package contains account-owned records and metadata as of the export time.\n");
  const bytes = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return {
    bytes,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    counts: {
      projects: projects.length,
      projectVersions: versions.length,
      brandKits: brands.length,
      sources: sources.length,
      assets: assets.length,
      exports: exports.length,
    },
  };
}
