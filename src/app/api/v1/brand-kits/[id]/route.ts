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

// contracts/api.md 第 29 行声明了 PUT /brand-kits/:id，但这个入口一直不存在：
// 服务层 brandService.update 早已写好（expectedRevision、409 冲突、素材归属校验齐全），
// 缺的只是 HTTP 路由，所以 Brand Kit 建好之后**永远改不了**——编辑器里那句
// "Changes remain in this editor until the revision-aware save route is available." 就是这个洞。
export async function PUT(request: Request, context: { readonly params: Promise<{ readonly id: string }> }) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) throw new BrandServiceError("INVALID_REQUEST", "This write request did not come from the configured application origin.", 400);
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) throw new BrandServiceError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
    const { id } = await context.params;
    const input = body as Record<string, unknown>;
    const kit = await createBrandService(createSupabaseBrandStore(createAdminSupabaseClient())).update(await ownerId(), id, { expectedRevision: input.expectedRevision, name: input.name, settings: input.settings });
    return Response.json({ data: { kit, kitVersion: kit.revision }, requestId }, { headers: { "Cache-Control": "private, no-store" } });
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
