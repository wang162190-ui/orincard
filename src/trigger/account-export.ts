import { task } from "@trigger.dev/sdk";
import { z } from "zod";
import { buildAccountDataPackage } from "../server/account-export";
import { createAdminSupabaseClient } from "../server/supabase";
import { ACCOUNT_EXPORT_TASK_ID } from "./dispatch";

const payloadSchema = z.object({ jobId: z.string().uuid(), schemaVersion: z.literal(1), requestId: z.string().min(1).max(200) }).strict();

export async function executeAccountExportJob(jobId: string) {
  const client = createAdminSupabaseClient();
  const jobResult = await client.from("jobs").select("id,owner_id,state,cancel_requested_at").eq("id", jobId).eq("kind", "account_export").maybeSingle();
  if (jobResult.error || !jobResult.data) throw new Error("ACCOUNT_EXPORT_JOB_NOT_FOUND");
  const job = jobResult.data;
  if (job.cancel_requested_at || !["pending_dispatch", "queued"].includes(job.state)) throw new Error("ACCOUNT_EXPORT_JOB_UNAVAILABLE");
  const now = new Date().toISOString();
  const claimed = await client.from("jobs").update({ state: "running", stage: "package", progress: 10, heartbeat_at: now, updated_at: now }).eq("id", job.id).eq("owner_id", job.owner_id).eq("state", job.state).is("cancel_requested_at", null).select("id").maybeSingle();
  if (claimed.error || !claimed.data) throw new Error("ACCOUNT_EXPORT_CLAIM_LOST");
  let objectKey: string | undefined;
  let assetId: string | undefined;
  try {
    const packaged = await buildAccountDataPackage(client, job.owner_id, now);
    objectKey = `${job.owner_id}/${job.id}/orincard-account-data.zip`;
    const upload = await client.storage.from("exports").upload(objectKey, packaged.bytes, { contentType: "application/zip", upsert: false });
    if (upload.error) throw new Error("ACCOUNT_EXPORT_UPLOAD_FAILED");
    const asset = await client.from("assets").insert({ owner_id: job.owner_id, kind: "derived", purpose: "account_export", bucket: "exports", object_key: objectKey, mime: "application/zip", bytes: packaged.bytes.byteLength, sha256: packaged.sha256, rights: { scope: "account-owned-data", generatedAt: now }, state: "ready" }).select("id").single();
    if (asset.error || !asset.data) throw new Error("ACCOUNT_EXPORT_ASSET_FAILED");
    assetId = asset.data.id;
    const finishedAt = new Date().toISOString();
    const updated = await client.from("jobs").update({ state: "succeeded", stage: "upload", progress: 100, result_ref: { assetId: asset.data.id, counts: packaged.counts }, finished_at: finishedAt, updated_at: finishedAt }).eq("id", job.id).eq("owner_id", job.owner_id).eq("state", "running").select("id").maybeSingle();
    if (updated.error || !updated.data) throw new Error("ACCOUNT_EXPORT_WRITEBACK_FAILED");
    return { jobId: job.id, assetId: asset.data.id };
  } catch (error) {
    if (objectKey) await client.storage.from("exports").remove([objectKey]);
    if (assetId) await client.from("assets").delete().eq("id", assetId).eq("owner_id", job.owner_id).eq("purpose", "account_export");
    const finishedAt = new Date().toISOString();
    await client.from("jobs").update({ state: "failed", error_code: error instanceof Error ? error.message : "ACCOUNT_EXPORT_FAILED", finished_at: finishedAt, updated_at: finishedAt }).eq("id", job.id).eq("owner_id", job.owner_id).eq("state", "running");
    throw error;
  }
}

export const accountExportTask = task({
  id: ACCOUNT_EXPORT_TASK_ID,
  maxDuration: 300,
  run: async (payload: unknown) => executeAccountExportJob(payloadSchema.parse(payload).jobId),
});
