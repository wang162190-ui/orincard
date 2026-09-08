import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import { readServerEnvironment } from "@/server/environment";
import { createNodeDnsResolver, createNodeHttpConnector, createSafeFetcher } from "@/server/sources/safe-fetch";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";
import { SCREENSHOT_TASK_ID } from "@/trigger/dispatch";

function response(code: string, message: string, status: number, requestId: string) {
  return Response.json({ error: { code, message, retryable: status >= 500 }, requestId }, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) return response("INVALID_REQUEST", "This write request did not come from the configured application origin.", 400, requestId);
    const payload: unknown = await request.json();
    const publicUrl = typeof (payload as Record<string, unknown> | null)?.publicUrl === "string" ? (payload as Record<string, string>).publicUrl : "";
    if (!publicUrl || publicUrl.length > 2_000) return response("INVALID_REQUEST", "A public URL is required.", 400, requestId);
    const cookieStore = await cookies();
    const user = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
    let owner: { readonly id: string };
    try { owner = await requireVerifiedUser(user); } catch { return response("AUTH_REQUIRED", "Sign in before capturing a screenshot.", 401, requestId); }
    // This server-side preflight follows redirects with pinned DNS connections before an
    // asset row or a cloud task exists. The worker repeats the check for browser loads.
    const preflight = await createSafeFetcher({ resolve: createNodeDnsResolver(), connect: createNodeHttpConnector() })(publicUrl, { maxBytes: 2_000_000, timeoutMs: 15_000 });
    if (!preflight.ok) return response("SCREENSHOT_BLOCKED", "This URL cannot be safely captured.", 422, requestId);
    const admin = createAdminSupabaseClient();
    const assetId = randomUUID();
    const { error: insertError } = await admin.from("assets").insert({ id: assetId, owner_id: owner.id, kind: "screenshot", purpose: "media", bucket: "assets", object_key: `${owner.id}/${assetId}/pending.png`, mime: "image/png", bytes: 0, sha256: "0".repeat(64), rights: { publicUrl: preflight.url, capture: "isolated-browser" }, state: "pending_upload", library_retained: false });
    if (insertError) throw new Error("asset insert failed");
    const key = await idempotencyKeys.create(`screenshot:${assetId}`, { scope: "global" });
    await tasks.trigger(SCREENSHOT_TASK_ID, { assetId, schemaVersion: 1 }, { idempotencyKey: key });
    return Response.json({ data: { assetId, state: "validating" }, requestId }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch { return response("SERVICE_UNAVAILABLE", "Screenshot capture is temporarily unavailable.", 503, requestId); }
}
