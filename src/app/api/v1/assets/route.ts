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
    const result = await service.list(await ownerId(), { kind: query.get("kind") ?? undefined, cursor: query.get("cursor") ?? undefined, limit: query.get("limit") ?? undefined });
    return Response.json({ data: result, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error, requestId); }
}
