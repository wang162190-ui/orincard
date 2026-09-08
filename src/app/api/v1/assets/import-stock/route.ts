import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { createPexelsClient, importPexelsPhoto, PexelsError } from "@/server/assets/pexels";
import { readServerEnvironment } from "@/server/environment";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

async function input(request: Request): Promise<{ readonly providerId: string; readonly licenseConfirmed: boolean }> {
  try {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new Error();
    const value = body as Record<string, unknown>;
    return { providerId: typeof value.providerId === "string" ? value.providerId : "", licenseConfirmed: value.licenseConfirmed === true };
  } catch { throw new PexelsError("INVALID_REQUEST", "Request body must be valid JSON.", 400); }
}

export async function POST(request: Request) {
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) throw new PexelsError("INVALID_REQUEST", "This write request did not come from the configured application origin.", 400);
    const cookieStore = await cookies();
    const userClient = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
    let owner: { readonly id: string };
    try { owner = await requireVerifiedUser(userClient); }
    catch { throw new PexelsError("AUTH_REQUIRED", "Sign in before importing a stock image.", 401); }
    const admin = createAdminSupabaseClient();
    const result = await importPexelsPhoto({
      ownerId: owner.id,
      ...await input(request),
      client: createPexelsClient(process.env.PEXELS_API_KEY?.trim() ?? ""),
      store: {
        async upload(objectKey, bytes, mime) { const { error } = await admin.storage.from("assets").upload(objectKey, bytes, { contentType: mime, upsert: false }); if (error) throw new Error("storage upload failed"); },
        async create(asset) { const { data, error } = await admin.from("assets").insert(asset).select("id").single(); if (error || !data) throw new Error("asset insert failed"); return data; },
        async remove(objectKey) { await admin.storage.from("assets").remove([objectKey]); },
      },
    });
    return Response.json({ data: result, requestId: randomUUID() }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    const failure = error instanceof PexelsError ? error : new PexelsError("UPSTREAM_UNAVAILABLE", "The stock image service is temporarily unavailable.", 503, true);
    return Response.json({ error: { code: failure.code, message: failure.message, retryable: failure.retryable }, requestId: randomUUID() }, { status: failure.status, headers: { "Cache-Control": "private, no-store" } });
  }
}
