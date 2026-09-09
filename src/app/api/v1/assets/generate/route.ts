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

function candidateStore(client: ReturnType<typeof createAdminSupabaseClient>, environment: ReturnType<typeof readServerEnvironment>): AiCandidateStore {
  return {
    async findReference(ownerId, assetId) {
      const { data, error } = await client.from("assets").select("id,bucket,object_key,mime").eq("id", assetId).eq("owner_id", ownerId).eq("state", "ready").maybeSingle();
      if (error) throw new Error("reference query failed");
      return data ? { id: data.id, bucket: data.bucket, objectKey: data.object_key, mime: data.mime } : null;
    },
    async createCandidate(input) {
      const value = input as { assetId: string; ownerId: string; kind: string; objectKey: string; rights: Record<string, unknown> };
      const { data, error } = await client.rpc("server_create_ai_asset_candidate", {
        p_asset_id: value.assetId, p_owner_id: value.ownerId, p_kind: value.kind,
        p_object_key: value.objectKey, p_rights: value.rights,
        p_environment: environment.appEnvironment, p_reserved_micro_usd: 25_000,
      });
      if (error || !data || typeof data !== "object") throw new Error("candidate asset transaction failed");
      const outcome = (data as { outcome?: unknown }).outcome;
      if (outcome !== "created" && outcome !== "quota_exceeded" && outcome !== "budget_exceeded") throw new Error("candidate asset transaction failed");
      return outcome;
    },
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
    const result = await createAiCandidateService({ store: candidateStore(createAdminSupabaseClient(), environment) }).submit(ownerId, body);
    try { await tasks.trigger(GENERATE_IMAGE_TASK_ID, { assetId: result.assetId, schemaVersion: 1 }); }
    catch { /* Candidate row is durable and can be retried by the worker reconciler. */ }
    return Response.json({ data: result, requestId }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return response(error instanceof AiAssetError ? error : new AiAssetError("SERVICE_UNAVAILABLE", "Image generation is temporarily unavailable.", 503, true), requestId);
  }
}
