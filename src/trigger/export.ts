import { task } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { renderDeck, BASIC_EXPORT_FORMATS, type BasicExportFormat } from "../render/render-deck";
import type { SlideRenderAsset } from "../render/slide";
import {
  BASIC_RENDERER_VERSION,
  packageBasicExport,
} from "../server/export-package";
import type { JobDispatchPayload } from "../server/jobs";
import { createAdminSupabaseClient } from "../server/supabase";

const payloadSchema = z
  .object({
    jobId: z.string().uuid(),
    schemaVersion: z.literal(1),
    requestId: z.string().min(1).max(200),
  })
  .strict();

export function validateExportTaskPayload(payload: unknown): JobDispatchPayload {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Export task payload must be reference-only.");
  }
  return parsed.data;
}

const inputRefSchema = z
  .object({
    projectVersionId: z.string().uuid(),
    format: z.enum(BASIC_EXPORT_FORMATS),
    rendererVersion: z.literal(BASIC_RENDERER_VERSION),
  })
  .strict();

type ExportJobRow = {
  id: string;
  owner_id: string;
  project_id: string;
  input_ref: unknown;
  state: string;
  cancel_requested_at: string | null;
};

async function failJob(client: SupabaseClient, jobId: string, code: string) {
  await client
    .from("jobs")
    .update({
      state: "failed",
      stage: "upload",
      error_code: code,
      finished_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    })
    .eq("id", jobId)
    .eq("state", "running");
}

async function loadRenderAssets(
  client: SupabaseClient,
  ownerId: string,
  document: { readonly assetRefs: readonly { readonly id: string; readonly kind: string; readonly rightsStatus: string }[] },
): Promise<Readonly<Record<string, SlideRenderAsset>>> {
  if (document.assetRefs.length === 0) return {};
  if (document.assetRefs.some((asset) => asset.rightsStatus === "restricted")) {
    throw new Error("ASSET_NOT_EXPORTABLE");
  }
  const ids = document.assetRefs.map((asset) => asset.id);
  const { data, error } = await client
    .from("assets")
    .select("id,kind,bucket,object_key,mime,width,height,state,accepted_at")
    .eq("owner_id", ownerId)
    .in("id", ids);
  if (error || !data || data.length !== ids.length) {
    throw new Error("ASSET_NOT_EXPORTABLE");
  }
  const output: Record<string, SlideRenderAsset> = {};
  for (const row of data) {
    const declared = document.assetRefs.find((asset) => asset.id === row.id);
    if (
      row.state !== "ready" ||
      (declared?.kind === "generated" && !row.accepted_at)
    ) {
      throw new Error("ASSET_NOT_EXPORTABLE");
    }
    const { data: blob, error: downloadError } = await client.storage
      .from(row.bucket)
      .download(row.object_key);
    if (downloadError || !blob) throw new Error("ASSET_NOT_EXPORTABLE");
    const bytes = Buffer.from(await blob.arrayBuffer());
    output[row.id] = {
      id: row.id,
      src: `data:${row.mime};base64,${bytes.toString("base64")}`,
      state: "ready",
      alt: "",
      width: row.width ?? undefined,
      height: row.height ?? undefined,
    };
  }
  return output;
}

export async function executePersistentExportJob(
  jobId: string,
  client: SupabaseClient = createAdminSupabaseClient(),
): Promise<{ readonly exportId: string; readonly assetId: string }> {
  const { data: rawJob, error: jobError } = await client
    .from("jobs")
    .select("id,owner_id,project_id,input_ref,state,cancel_requested_at")
    .eq("id", jobId)
    .eq("kind", "export")
    .maybeSingle();
  if (jobError || !rawJob) throw new Error("Export job not found.");
  const job = rawJob as ExportJobRow;
  if (job.cancel_requested_at || !["pending_dispatch", "queued"].includes(job.state)) {
    throw new Error("Export job cannot be claimed.");
  }
  const inputRef = inputRefSchema.parse(job.input_ref);
  const now = new Date().toISOString();
  const { data: claimed, error: claimError } = await client
    .from("jobs")
    .update({ state: "running", stage: "render", progress: 10, heartbeat_at: now, updated_at: now })
    .eq("id", job.id)
    .eq("state", job.state)
    .is("cancel_requested_at", null)
    .select("id")
    .maybeSingle();
  if (claimError || !claimed) throw new Error("Export job claim lost.");

  let uploadedKey: string | undefined;
  try {
    const [{ data: version, error: versionError }, { data: project, error: projectError }] = await Promise.all([
      client
        .from("project_versions")
        .select("id,project_id,owner_id,revision,document")
        .eq("id", inputRef.projectVersionId)
        .eq("project_id", job.project_id)
        .eq("owner_id", job.owner_id)
        .maybeSingle(),
      client
        .from("projects")
        .select("id,state")
        .eq("id", job.project_id)
        .eq("owner_id", job.owner_id)
        .in("state", ["draft", "archived"])
        .maybeSingle(),
    ]);
    if (versionError || projectError || !version || !project) {
      throw new Error("PROJECT_VERSION_UNAVAILABLE");
    }
    const document = version.document as {
      readonly assetRefs: readonly { readonly id: string; readonly kind: string; readonly rightsStatus: string }[];
    };
    const assets = await loadRenderAssets(client, job.owner_id, document);
    const rendered = await renderDeck({
      document: version.document,
      assets,
      formats: [inputRef.format as BasicExportFormat],
    });
    const output = rendered.outputs[0];
    if (!output || rendered.failures.length > 0) throw new Error("RENDER_FAILED");
    const packaged = await packageBasicExport({
      ...output,
      rendererVersion: inputRef.rendererVersion,
    });
    uploadedKey = `${job.owner_id}/${job.id}/${version.id}/${packaged.filename}`;
    const { error: uploadError } = await client.storage
      .from("exports")
      .upload(uploadedKey, packaged.bytes, {
        contentType: packaged.mime,
        upsert: false,
      });
    if (uploadError) throw new Error("UPLOAD_FAILED");
    const { data: asset, error: assetError } = await client
      .from("assets")
      .insert({
        owner_id: job.owner_id,
        kind: "derived",
        purpose: "export",
        bucket: "exports",
        object_key: uploadedKey,
        mime: packaged.mime,
        bytes: packaged.bytes.byteLength,
        sha256: packaged.sha256,
        rights: { projectVersionId: version.id, rendererVersion: inputRef.rendererVersion },
        state: "ready",
      })
      .select("id")
      .single();
    if (assetError || !asset) throw new Error("UPLOAD_FAILED");
    const finishedAt = new Date().toISOString();
    const resultRef = {
      exportId: job.id,
      assetId: asset.id,
      projectVersionId: version.id,
      revision: version.revision,
      format: inputRef.format,
      filename: packaged.filename,
      manifest: packaged.manifest,
    };
    const { error: finishError } = await client
      .from("jobs")
      .update({
        state: "succeeded",
        stage: "upload",
        progress: 100,
        result_ref: resultRef,
        error_code: null,
        finished_at: finishedAt,
        heartbeat_at: finishedAt,
        updated_at: finishedAt,
      })
      .eq("id", job.id)
      .eq("state", "running")
      .is("cancel_requested_at", null);
    if (finishError) throw new Error("UPLOAD_FAILED");
    return { exportId: job.id, assetId: asset.id };
  } catch (error) {
    if (uploadedKey) await client.storage.from("exports").remove([uploadedKey]);
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message)
      ? error.message
      : "PROVIDER_FAILED";
    await failJob(client, job.id, code);
    throw error;
  }
}

export const basicExportTask = task({
  id: "orincard-basic-export",
  maxDuration: 300,
  run: async (payload: unknown) => {
    const input = validateExportTaskPayload(payload);
    return executePersistentExportJob(input.jobId);
  },
});
