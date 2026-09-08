import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { BrandServiceError, createBrandService, createSupabaseBrandStore } from "@/server/brands";
import { readServerEnvironment } from "@/server/environment";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

function errorResponse(error: unknown, requestId: string): Response {
  const failure = error instanceof BrandServiceError ? error : new BrandServiceError("SERVICE_UNAVAILABLE", "Brand Kits are temporarily unavailable.", 503, true);
  return Response.json({ error: { code: failure.code, message: failure.message, retryable: failure.retryable, ...failure.details }, requestId }, { status: failure.status, headers: { "Cache-Control": "private, no-store" } });
}

async function ownerId(): Promise<string> {
  const store = await cookies();
  const client = createServerSupabaseClient({ getAll: () => store.getAll(), set: (name, value, options) => store.set(name, value, options) });
  try { return (await requireVerifiedUser(client)).id; }
  catch { throw new BrandServiceError("AUTH_REQUIRED", "Sign in to access Brand Kits.", 401); }
}

export async function GET(_request: Request, context: { readonly params: Promise<{ readonly id: string }> }) {
  const requestId = randomUUID();
  try {
    const { id } = await context.params;
    const impact = await createBrandService(createSupabaseBrandStore(createAdminSupabaseClient())).deleteImpact(await ownerId(), id);
    return Response.json({ data: impact, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error, requestId); }
}

export async function DELETE(request: Request, context: { readonly params: Promise<{ readonly id: string }> }) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) throw new BrandServiceError("INVALID_REQUEST", "This write request did not come from the configured application origin.", 400);
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BrandServiceError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
    const { id } = await context.params;
    const input = body as Record<string, unknown>;
    await createBrandService(createSupabaseBrandStore(createAdminSupabaseClient())).delete(await ownerId(), id, { expectedRevision: input.expectedRevision, expectedProjectIds: input.expectedProjectIds });
    return new Response(null, { status: 204, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return errorResponse(error, requestId); }
}
