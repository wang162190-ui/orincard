import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { tasks } from "@trigger.dev/sdk";
import { AiAssetError, createAiCandidateService, type AiCandidateStore } from "@/server/assets/ai-image";
import { readServerEnvironment } from "@/server/environment";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";
import { GENERATE_IMAGE_TASK_ID } from "@/trigger/generate-image";

function response(error: AiAssetError, requestId: string) {
  return Response.json({ error: { code: error.code, message: error.message, retryable: error.retryable }, requestId }, { status: error.status, headers: { "Cache-Control": "private, no-store" } });
}

function candidateStore(client: ReturnType<typeof createAdminSupabaseClient>): AiCandidateStore {
  return {
    async findReference(ownerId, assetId) {
      const { data, error } = await client.from("assets").select("id,bucket,object_key,mime").eq("id", assetId).eq("owner_id", ownerId).eq("state", "ready").maybeSingle();
      if (error) throw new Error("reference query failed");
      return data ? { id: data.id, bucket: data.bucket, objectKey: data.object_key, mime: data.mime } : null;
    },
    async reserve(ownerId) {
      // This is deliberately a read-only guard until the integration migration supplies
      // one atomic image reservation RPC. It prevents a request when the account has no
      // image balance, but cannot safely decrement a balance without that RPC.
      const now = new Date().toISOString();
      const { data, error } = await client.from("usage_accounts").select("granted,reserved,consumed").eq("owner_id", ownerId).eq("resource", "image").lte("period_start", now).gt("period_end", now).maybeSingle();
      if (error) throw new Error("image quota query failed");
      if (!data || Number(data.granted) - Number(data.reserved) - Number(data.consumed) < 1) return "quota_exceeded" as const;
      return "reserved" as const;
    },
    async release() {},
    async create(input) { const { data, error } = await client.from("assets").insert(input).select("id").single(); if (error || !data) throw new Error("candidate asset insert failed"); return data; },
  };
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) throw new AiAssetError("INVALID_REQUEST", "This write request did not come from the configured application origin.", 400);
    const cookieStore = await cookies();
    const user = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
    let ownerId: string;
    try { ownerId = (await requireVerifiedUser(user)).id; } catch { throw new AiAssetError("AUTH_REQUIRED", "Sign in before generating an image.", 401); }
    let body: unknown;
    try { body = await request.json(); } catch { throw new AiAssetError("INVALID_REQUEST", "Request body must be valid JSON.", 400); }
    const result = await createAiCandidateService({ store: candidateStore(createAdminSupabaseClient()) }).submit(ownerId, body);
    try { await tasks.trigger(GENERATE_IMAGE_TASK_ID, { assetId: result.assetId, schemaVersion: 1 }); }
    catch { /* Candidate row is durable and can be retried by the worker reconciler. */ }
    return Response.json({ data: result, requestId }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return response(error instanceof AiAssetError ? error : new AiAssetError("SERVICE_UNAVAILABLE", "Image generation is temporarily unavailable.", 503, true), requestId);
  }
}
