import { createHash, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { readServerEnvironment } from "@/server/environment";
import { assertTrustedWriteRequest } from "@/server/projects";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";
import { ACCOUNT_EXPORT_TASK_ID } from "@/trigger/dispatch";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";

async function owner() {
  const cookieStore = await cookies();
  const client = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
  return (await requireVerifiedUser(client)).id;
}

function responseError(requestId: string, status = 503) {
  return Response.json({ error: { code: status === 401 ? "AUTH_REQUIRED" : "SERVICE_UNAVAILABLE", message: status === 401 ? "Sign in to export account data." : "Account export is temporarily unavailable.", retryable: status !== 401 }, requestId }, { status, headers: { "Cache-Control": "private, no-store" } });
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    assertTrustedWriteRequest(request, readServerEnvironment(process.env).appUrl);
    let ownerId: string;
    try { ownerId = await owner(); } catch { return responseError(requestId, 401); }
    const key = request.headers.get("idempotency-key")?.trim() || randomUUID();
    if (key.length > 200) return Response.json({ error: { code: "INVALID_REQUEST", message: "Idempotency key is too long.", retryable: false }, requestId }, { status: 400 });
    const admin = createAdminSupabaseClient();
    const requestHash = createHash("sha256").update(`account-export:${ownerId}`).digest("hex");
    const { data: job, error } = await admin.from("jobs").upsert({ owner_id: ownerId, kind: "account_export", input_ref: { schemaVersion: 1 }, idempotency_key: key, request_hash: requestHash }, { onConflict: "owner_id,kind,idempotency_key", ignoreDuplicates: true }).select("id,state").maybeSingle();
    let record = job;
    if (!record && !error) {
      const existing = await admin.from("jobs").select("id,state").eq("owner_id", ownerId).eq("kind", "account_export").eq("idempotency_key", key).single();
      if (existing.error) throw existing.error;
      record = existing.data;
    }
    if (error || !record) throw error ?? new Error("job unavailable");
    if (record.state === "pending_dispatch") {
      const idempotencyKey = await idempotencyKeys.create(`account-export:${record.id}`, { scope: "global" });
      const run = await tasks.trigger(ACCOUNT_EXPORT_TASK_ID, { jobId: record.id, schemaVersion: 1, requestId }, { idempotencyKey });
      await admin.from("jobs").update({ state: "queued", provider_run_id: run.id, updated_at: new Date().toISOString() }).eq("id", record.id).eq("owner_id", ownerId).eq("state", "pending_dispatch");
    }
    return Response.json({ data: { jobId: record.id }, requestId }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return responseError(requestId);
  }
}

export async function GET(request: Request) {
  const requestId = randomUUID();
  try {
    let ownerId: string;
    try { ownerId = await owner(); } catch { return responseError(requestId, 401); }
    const jobId = new URL(request.url).searchParams.get("jobId");
    if (!jobId) return Response.json({ error: { code: "INVALID_REQUEST", message: "jobId is required.", retryable: false }, requestId }, { status: 400 });
    const admin = createAdminSupabaseClient();
    const result = await admin.from("jobs").select("id,state,progress,result_ref,error_code").eq("id", jobId).eq("owner_id", ownerId).eq("kind", "account_export").maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) return Response.json({ error: { code: "NOT_FOUND", message: "Account export was not found.", retryable: false }, requestId }, { status: 404 });
    let downloadUrl: string | null = null;
    const assetId = result.data.result_ref && typeof result.data.result_ref === "object" ? (result.data.result_ref as { assetId?: unknown }).assetId : null;
    if (result.data.state === "succeeded" && typeof assetId === "string") {
      const asset = await admin.from("assets").select("bucket,object_key").eq("id", assetId).eq("owner_id", ownerId).eq("purpose", "account_export").eq("state", "ready").maybeSingle();
      if (asset.error) throw asset.error;
      if (asset.data) {
        const signed = await admin.storage.from(asset.data.bucket).createSignedUrl(asset.data.object_key, 60);
        if (signed.error) throw signed.error;
        downloadUrl = signed.data.signedUrl;
      }
    }
    return Response.json({ data: { jobId: result.data.id, state: result.data.state, progress: result.data.progress, errorCode: result.data.error_code, downloadUrl }, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch {
    return responseError(requestId);
  }
}
