import type { SupabaseClient } from "@supabase/supabase-js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ASSET_STATES = ["pending_upload", "validating", "ready", "failed", "deleting", "deleted"] as const;
const ASSET_KINDS = ["upload", "stock", "screenshot", "ai_image", "portrait", "audio", "derived"] as const;

type AssetState = (typeof ASSET_STATES)[number];
type AssetKind = (typeof ASSET_KINDS)[number];
type AssetRow = Readonly<{ id: string; kind: AssetKind; purpose: string; mime: string; bytes: number; width: number | null; height: number | null; rights: unknown; accepted_at: string | null; library_retained: boolean; state: AssetState; error_code: string | null; created_at: string; bucket?: string; object_key?: string }>;
type Reference = Readonly<{ type: "project" | "brand"; id: string; name: string; slotKey: string }>;

export type AssetLibraryItem = Readonly<{ id: string; kind: AssetKind; purpose: string; mime: string; bytes: number; width: number | null; height: number | null; rights: unknown; acceptedAt: string | null; libraryRetained: boolean; state: AssetState; errorCode: string | null; createdAt: string }>;

export class AssetLibraryError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "ASSET_IN_USE" | "SERVICE_UNAVAILABLE",
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly references: readonly Reference[] = [],
  ) {
    super(message);
    this.name = "AssetLibraryError";
  }
}

export interface AssetLibraryStore {
  list(input: Readonly<{ ownerId: string; kind: AssetKind | null; before: string | null; limit: number }>): Promise<readonly AssetRow[]>;
  find(ownerId: string, assetId: string): Promise<AssetRow | null>;
  accept(input: Readonly<{ ownerId: string; assetId: string; keepInLibrary: boolean; acceptedAt: string }>): Promise<AssetRow | null>;
  references(ownerId: string, assetId: string): Promise<readonly Reference[]>;
  delete(input: Readonly<{ ownerId: string; assetId: string; expectedState: AssetState }>): Promise<AssetRow | null>;
  removeObject(asset: AssetRow): Promise<void>;
}

function asset(row: AssetRow): AssetLibraryItem {
  return { id: row.id, kind: row.kind, purpose: row.purpose, mime: row.mime, bytes: Number(row.bytes), width: row.width, height: row.height, rights: row.rights, acceptedAt: row.accepted_at, libraryRetained: row.library_retained, state: row.state, errorCode: row.error_code, createdAt: row.created_at };
}

function assetId(value: string): void {
  if (!UUID_PATTERN.test(value)) throw new AssetLibraryError("NOT_FOUND", "Asset not found.", 404);
}

function kind(value: unknown): AssetKind | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !ASSET_KINDS.includes(value as AssetKind)) throw new AssetLibraryError("INVALID_REQUEST", "Asset kind is invalid.", 422);
  return value as AssetKind;
}

function state(value: unknown): AssetState {
  if (typeof value !== "string" || !ASSET_STATES.includes(value as AssetState)) throw new AssetLibraryError("INVALID_REQUEST", "expectedState is invalid.", 422);
  return value as AssetState;
}

function limit(value: unknown): number {
  const requested = Number(value ?? 30);
  return Number.isSafeInteger(requested) ? Math.max(1, Math.min(50, requested)) : 30;
}

function cursor(value: unknown): string | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) throw new AssetLibraryError("INVALID_REQUEST", "cursor is invalid.", 422);
  return value;
}

export function createAssetLibraryService(input: Readonly<{ store: AssetLibraryStore; now?: () => Date }>) {
  const now = input.now ?? (() => new Date());
  return {
    async list(ownerId: string, query: Readonly<{ kind?: unknown; cursor?: unknown; limit?: unknown }>): Promise<Readonly<{ items: readonly AssetLibraryItem[]; nextCursor: string | null }>> {
      try {
        const results = await input.store.list({ ownerId, kind: kind(query.kind), before: cursor(query.cursor), limit: limit(query.limit) + 1 });
        const requested = limit(query.limit);
        const page = results.slice(0, requested);
        return { items: page.map(asset), nextCursor: results.length > requested ? page.at(-1)?.created_at ?? null : null };
      } catch (error) {
        if (error instanceof AssetLibraryError) throw error;
        throw new AssetLibraryError("SERVICE_UNAVAILABLE", "Assets are temporarily unavailable.", 503, true);
      }
    },
    async accept(ownerId: string, id: string, body: Readonly<{ rightsConfirmation?: unknown; keepInLibrary?: unknown }>): Promise<AssetLibraryItem> {
      assetId(id);
      if (body.rightsConfirmation !== true || typeof body.keepInLibrary !== "boolean") throw new AssetLibraryError("INVALID_REQUEST", "Confirm rights and choose whether to keep this asset in your library.", 422);
      try {
        const current = await input.store.find(ownerId, id);
        if (!current) throw new AssetLibraryError("NOT_FOUND", "Asset not found.", 404);
        if (current.kind !== "ai_image" && current.kind !== "portrait") throw new AssetLibraryError("INVALID_REQUEST", "Only AI candidate assets need acceptance.", 422);
        if (current.state !== "ready") throw new AssetLibraryError("INVALID_REQUEST", "This candidate is not ready to accept.", 422);
        if (current.accepted_at !== null) return asset(current);
        const accepted = await input.store.accept({ ownerId, assetId: id, keepInLibrary: body.keepInLibrary, acceptedAt: now().toISOString() });
        if (!accepted) throw new AssetLibraryError("NOT_FOUND", "Asset not found.", 404);
        return asset(accepted);
      } catch (error) {
        if (error instanceof AssetLibraryError) throw error;
        throw new AssetLibraryError("SERVICE_UNAVAILABLE", "This candidate could not be accepted.", 503, true);
      }
    },
    async remove(ownerId: string, id: string, body: Readonly<{ expectedState?: unknown }>): Promise<void> {
      assetId(id);
      const expectedState = state(body.expectedState);
      try {
        const current = await input.store.find(ownerId, id);
        if (!current) throw new AssetLibraryError("NOT_FOUND", "Asset not found.", 404);
        const references = await input.store.references(ownerId, id);
        if (references.length > 0) throw new AssetLibraryError("ASSET_IN_USE", "This asset is still used by a project or Brand Kit.", 409, false, references);
        const deleted = await input.store.delete({ ownerId, assetId: id, expectedState });
        if (!deleted) throw new AssetLibraryError("INVALID_REQUEST", "This asset changed before it could be deleted. Reload and try again.", 409);
        // Metadata deletion is authoritative. A failed best-effort object cleanup is
        // harmless: the private object is no longer addressable through this API.
        await input.store.removeObject(deleted).catch(() => undefined);
      } catch (error) {
        if (error instanceof AssetLibraryError) throw error;
        throw new AssetLibraryError("SERVICE_UNAVAILABLE", "This asset could not be deleted.", 503, true);
      }
    },
  };
}

export function createSupabaseAssetLibraryStore(client: SupabaseClient): AssetLibraryStore {
  return {
    async list(input) {
      let query = client.from("assets").select("id,kind,purpose,mime,bytes,width,height,rights,accepted_at,library_retained,state,error_code,created_at").eq("owner_id", input.ownerId).neq("state", "deleted").order("created_at", { ascending: false }).order("id", { ascending: false }).limit(input.limit);
      if (input.kind) query = query.eq("kind", input.kind);
      if (input.before) query = query.lt("created_at", input.before);
      const { data, error } = await query;
      if (error) throw error;
      return (data ?? []) as AssetRow[];
    },
    async find(ownerId, id) {
      const { data, error } = await client.from("assets").select("id,kind,purpose,mime,bytes,width,height,rights,accepted_at,library_retained,state,error_code,created_at").eq("owner_id", ownerId).eq("id", id).neq("state", "deleted").maybeSingle();
      if (error) throw error;
      return data as AssetRow | null;
    },
    async accept(input) {
      const { data, error } = await client.from("assets").update({ accepted_at: input.acceptedAt, library_retained: input.keepInLibrary, updated_at: input.acceptedAt }).eq("owner_id", input.ownerId).eq("id", input.assetId).eq("state", "ready").is("accepted_at", null).in("kind", ["ai_image", "portrait"]).select("id,kind,purpose,mime,bytes,width,height,rights,accepted_at,library_retained,state,error_code,created_at").maybeSingle();
      if (error) throw error;
      return data as AssetRow | null;
    },
    async references(ownerId, assetId) {
      const [projects, brands] = await Promise.all([
        client.from("project_asset_refs").select("slot_key,projects!inner(id,title,owner_id,state)").eq("asset_id", assetId).eq("projects.owner_id", ownerId).in("projects.state", ["draft", "archived"]),
        client.from("brand_asset_refs").select("slot_key,brand_kits!inner(id,name,owner_id,state)").eq("asset_id", assetId).eq("brand_kits.owner_id", ownerId).eq("brand_kits.state", "active"),
      ]);
      if (projects.error) throw projects.error;
      if (brands.error) throw brands.error;
      const projectRefs = (projects.data ?? []).flatMap((row) => {
        const project = row.projects as unknown as { id: string; title: string } | null;
        return project ? [{ type: "project" as const, id: project.id, name: project.title, slotKey: row.slot_key as string }] : [];
      });
      const brandRefs = (brands.data ?? []).flatMap((row) => {
        const brand = row.brand_kits as unknown as { id: string; name: string } | null;
        return brand ? [{ type: "brand" as const, id: brand.id, name: brand.name, slotKey: row.slot_key as string }] : [];
      });
      return [...projectRefs, ...brandRefs];
    },
    async delete(input) {
      const { data, error } = await client.from("assets").update({ state: "deleted", updated_at: new Date().toISOString() }).eq("owner_id", input.ownerId).eq("id", input.assetId).eq("state", input.expectedState).select("id,kind,purpose,mime,bytes,width,height,rights,accepted_at,library_retained,state,error_code,created_at,bucket,object_key").maybeSingle();
      if (error) throw error;
      return data as AssetRow | null;
    },
    async removeObject(asset) {
      if (!asset.bucket || !asset.object_key) return;
      const { error } = await client.storage.from(asset.bucket).remove([asset.object_key]);
      if (error) throw error;
    },
  };
}
