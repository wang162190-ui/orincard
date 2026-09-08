import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { AssetLibraryError, createAssetLibraryService, createSupabaseAssetLibraryStore } from "@/server/assets/library";
import { readServerEnvironment } from "@/server/environment";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

function failure(error: unknown, requestId: string): Response {
  const detail = error instanceof AssetLibraryError ? error : new AssetLibraryError("SERVICE_UNAVAILABLE", "This candidate could not be accepted.", 503, true);
  return Response.json({ error: { code: detail.code, message: detail.message, retryable: detail.retryable }, requestId }, { status: detail.status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }) {
  const requestId = randomUUID();
  try {
    if (request.headers.get("origin") !== new URL(readServerEnvironment(process.env).appUrl).origin) throw new AssetLibraryError("INVALID_REQUEST", "This write request did not come from the configured application origin.", 400);
    const cookieStore = await cookies();
    const user = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
    let ownerId: string;
    try { ownerId = (await requireVerifiedUser(user)).id; } catch { throw new AssetLibraryError("AUTH_REQUIRED", "Sign in before accepting a candidate.", 401); }
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new AssetLibraryError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
    const { id } = await context.params;
    const item = await createAssetLibraryService({ store: createSupabaseAssetLibraryStore(createAdminSupabaseClient()) }).accept(ownerId, id, body as Record<string, unknown>);
    return Response.json({ data: { asset: item }, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return failure(error, requestId); }
}
