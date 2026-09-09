import type { SupabaseClient } from "@supabase/supabase-js";

export type DeletionScope = "project" | "account";

export class DeletionError extends Error {
  constructor(readonly code: "AUTH_REQUIRED" | "NOT_FOUND" | "SERVICE_UNAVAILABLE", message: string, readonly status: number) {
    super(message);
    this.name = "DeletionError";
  }
}

export interface DeletionRequest {
  readonly id: string;
  readonly ownerId: string;
  readonly scope: DeletionScope;
  readonly projectId: string | null;
}

export interface DeletionStore {
  requestProject(ownerId: string, projectId: string): Promise<string>;
  requestAccount(ownerId: string): Promise<string>;
  claim(requestId: string): Promise<DeletionRequest | null>;
  cleanup(request: DeletionRequest): Promise<void>;
  fail(requestId: string, code: string): Promise<void>;
}

interface AssetObject { readonly id: string; readonly bucket: string; readonly object_key: string }
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function dbError(message: string) {
  return Object.assign(new Error(message), { code: "DB_FAILED" });
}

export function createSupabaseDeletionStore(client: SupabaseClient): DeletionStore {
  return {
    async requestProject(ownerId, projectId) {
      const { data, error } = await client.rpc("server_request_project_deletion", { p_owner_id: ownerId, p_project_id: projectId });
      if (error || typeof data !== "string") throw error ?? dbError("Deletion request failed");
      return data;
    },
    async requestAccount(ownerId) {
      const { data, error } = await client.rpc("server_request_account_deletion", { p_owner_id: ownerId });
      if (error || typeof data !== "string") throw error ?? dbError("Deletion request failed");
      return data;
    },
    async claim(requestId) {
      const { data, error } = await client.from("deletion_requests")
        .update({ state: "running", error_code: null, updated_at: new Date().toISOString() })
        .eq("id", requestId).in("state", ["pending", "failed"])
        .select("id,owner_id,scope,project_id").maybeSingle();
      if (error) throw error;
      return data ? { id: data.id, ownerId: data.owner_id, scope: data.scope, projectId: data.project_id } : null;
    },
    async cleanup(request) {
      let assets: AssetObject[] = [];
      if (request.scope === "account") {
        const { data, error } = await client.from("assets").select("id,bucket,object_key").eq("owner_id", request.ownerId).not("state", "eq", "deleted");
        if (error) throw error;
        assets = (data ?? []) as AssetObject[];
      } else {
        const { data: refs, error: refsError } = await client.from("project_asset_refs").select("asset_id").eq("project_id", request.projectId!);
        if (refsError) throw refsError;
        const ids = [...new Set((refs ?? []).map((row) => row.asset_id as string))];
        if (ids.length) {
          const [{ data: activeProjectRefs, error: projectError }, { data: activeBrandRefs, error: brandError }] = await Promise.all([
            client.from("project_asset_refs").select("asset_id,projects!inner(state)").in("asset_id", ids).in("projects.state", ["draft", "archived"]),
            client.from("brand_asset_refs").select("asset_id,brand_kits!inner(state)").in("asset_id", ids).eq("brand_kits.state", "active"),
          ]);
          if (projectError || brandError) throw projectError ?? brandError;
          const live = new Set([...(activeProjectRefs ?? []), ...(activeBrandRefs ?? [])].map((row) => row.asset_id as string));
          const unused = ids.filter((id) => !live.has(id));
          if (unused.length) {
            const { data, error } = await client.from("assets").select("id,bucket,object_key").eq("owner_id", request.ownerId).in("id", unused).not("state", "eq", "deleted");
            if (error) throw error;
            assets = (data ?? []) as AssetObject[];
          }
        }
      }

      const grouped = new Map<string, AssetObject[]>();
      for (const asset of assets) grouped.set(asset.bucket, [...(grouped.get(asset.bucket) ?? []), asset]);
      for (const [bucket, objects] of grouped) {
        const { error } = await client.storage.from(bucket).remove(objects.map((asset) => asset.object_key));
        if (error) throw error;
      }
      if (assets.length) {
        const { error } = await client.from("assets").update({ state: "deleted", deleted_at: new Date().toISOString() }).eq("owner_id", request.ownerId).in("id", assets.map((asset) => asset.id));
        if (error) throw error;
      }

      const now = new Date().toISOString();
      if (request.scope === "project") {
        const { error } = await client.from("projects").update({ state: "deleted", updated_at: now }).eq("id", request.projectId!).eq("owner_id", request.ownerId).eq("state", "deleting");
        if (error) throw error;
      } else {
        const results = await Promise.all([
          client.from("projects").update({ state: "deleted", updated_at: now }).eq("owner_id", request.ownerId).eq("state", "deleting"),
          client.from("sources").update({ state: "deleted" }).eq("owner_id", request.ownerId).neq("state", "deleted"),
          client.from("brand_kits").update({ state: "deleted", deleted_at: now }).eq("owner_id", request.ownerId).neq("state", "deleted"),
        ]);
        const failed = results.find((result) => result.error);
        if (failed?.error) throw failed.error;
        const { error } = await client.from("profiles").update({ status: "deleted" }).eq("id", request.ownerId).eq("status", "deleting");
        if (error) throw error;
      }
      const { error } = await client.from("deletion_requests").update({ state: "completed", completed_at: now, updated_at: now }).eq("id", request.id).eq("owner_id", request.ownerId).eq("state", "running");
      if (error) throw error;
    },
    async fail(requestId, code) {
      const { error } = await client.from("deletion_requests").update({ state: "failed", error_code: code, updated_at: new Date().toISOString() }).eq("id", requestId).eq("state", "running");
      if (error) throw error;
    },
  };
}

export function createDeletionService(store: DeletionStore) {
  return {
    async requestProject(ownerId: string, projectId: string) {
      if (!UUID_PATTERN.test(projectId)) throw new DeletionError("NOT_FOUND", "Project not found.", 404);
      try { return await store.requestProject(ownerId, projectId); }
      catch (error) {
        if (typeof error === "object" && error && "code" in error && error.code === "42501") throw new DeletionError("NOT_FOUND", "Project not found.", 404);
        throw new DeletionError("SERVICE_UNAVAILABLE", "Deletion is temporarily unavailable.", 503);
      }
    },
    async requestAccount(ownerId: string) {
      try { return await store.requestAccount(ownerId); }
      catch { throw new DeletionError("SERVICE_UNAVAILABLE", "Deletion is temporarily unavailable.", 503); }
    },
  };
}

export async function runDeletionCleanup(store: DeletionStore, requestId: string) {
  const request = await store.claim(requestId);
  if (!request) return { requestId, state: "ignored" as const };
  try {
    await store.cleanup(request);
    return { requestId, state: "completed" as const };
  } catch (error) {
    await store.fail(requestId, "CLEANUP_FAILED");
    throw error;
  }
}

export function deletionErrorResponse(error: unknown, requestId: string) {
  const safe = error instanceof DeletionError ? error : new DeletionError("SERVICE_UNAVAILABLE", "Deletion is temporarily unavailable.", 503);
  return Response.json({ error: { code: safe.code, message: safe.message }, requestId }, { status: safe.status, headers: { "Cache-Control": "private, no-store" } });
}
