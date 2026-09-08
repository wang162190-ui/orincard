import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { AssetLibraryError, createAssetLibraryService, createSupabaseAssetLibraryStore } from "@/server/assets/library";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

function failure(error: unknown, requestId: string): Response {
  const detail = error instanceof AssetLibraryError ? error : new AssetLibraryError("SERVICE_UNAVAILABLE", "Assets are temporarily unavailable.", 503, true);
  return Response.json({ error: { code: detail.code, message: detail.message, retryable: detail.retryable, references: detail.references }, requestId }, { status: detail.status, headers: { "Cache-Control": "private, no-store" } });
}

async function ownerId(): Promise<string> {
  const store = await cookies();
  const client = createServerSupabaseClient({ getAll: () => store.getAll(), set: (name, value, options) => store.set(name, value, options) });
  try { return (await requireVerifiedUser(client)).id; }
  catch { throw new AssetLibraryError("AUTH_REQUIRED", "Sign in to access assets.", 401); }
}

export async function GET(request: Request) {
  const requestId = randomUUID();
  try {
    const query = new URL(request.url).searchParams;
    const service = createAssetLibraryService({ store: createSupabaseAssetLibraryStore(createAdminSupabaseClient()) });
    const owner = await ownerId();
    const result = await service.list(owner, { kind: query.get("kind") ?? undefined, cursor: query.get("cursor") ?? undefined, limit: query.get("limit") ?? undefined });
    // Object keys stay private. The editor needs a short-lived thumbnail to render an
    // owned library item, so mint it only after the owner-scoped library query succeeds.
    const admin = createAdminSupabaseClient();
    const ids = result.items.map((item) => item.id);
    const { data: objects, error } = ids.length
      ? await admin.from("assets").select("id,bucket,object_key").eq("owner_id", owner).in("id", ids)
      : { data: [], error: null };
    if (error) throw error;
    const previews = new Map(await Promise.all((objects ?? []).map(async (item) => {
      const { data } = await admin.storage.from(item.bucket).createSignedUrl(item.object_key, 300);
      return [item.id, data?.signedUrl ?? null] as const;
    })));
    return Response.json({ data: { ...result, items: result.items.map((item) => ({ ...item, previewUrl: previews.get(item.id) ?? null })) }, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error, requestId); }
}
