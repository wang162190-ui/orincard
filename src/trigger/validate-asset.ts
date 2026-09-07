import { task } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import {
  VALIDATE_ASSET_TASK_ID,
  inspectUploadedObject,
  type AssetValidationPayload,
  type UploadPurpose,
} from "../server/assets/upload";
import { createAdminSupabaseClient } from "../server/supabase";

export { VALIDATE_ASSET_TASK_ID };

const payloadSchema = z
  .object({
    assetId: z.string().uuid(),
    schemaVersion: z.literal(1),
    requestId: z.string().min(1).max(200),
  })
  .strict();

export function validateAssetTaskPayload(payload: unknown): AssetValidationPayload {
  const parsed = payloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("Asset validation payload must be reference-only.");
  }
  return parsed.data;
}

type ClaimedAsset = {
  id: string;
  purpose: UploadPurpose;
  bucket: string;
  object_key: string;
  mime: string;
  bytes: number;
  sha256: string;
};

export type AssetValidationResult = {
  readonly assetId: string;
  readonly state: "ready" | "failed" | "skipped";
};

async function finalize(
  client: SupabaseClient,
  assetId: string,
  parameters: Readonly<Record<string, unknown>>,
): Promise<void> {
  const { error } = await client.rpc("server_finalize_asset_validation", {
    p_asset_id: assetId,
    p_width: null,
    p_height: null,
    p_duration_ms: null,
    ...parameters,
  });
  if (error) throw new Error("Asset validation could not be finalized.");
}

export async function executeAssetValidation(
  assetId: string,
  client: SupabaseClient = createAdminSupabaseClient(),
): Promise<AssetValidationResult> {
  const { data, error } = await client.rpc("server_claim_asset_validation", {
    p_asset_id: assetId,
  });
  if (error) throw new Error("Asset validation could not be claimed.");
  const claimed = (Array.isArray(data) ? data[0] : data) as ClaimedAsset | undefined;
  // An empty claim is the normal outcome of a retried run or a second complete call: the
  // asset already left pending_upload, so re-reading and re-deciding it would race the
  // run that owns it.
  if (!claimed) return { assetId, state: "skipped" };

  const { data: blob, error: downloadError } = await client.storage
    .from(claimed.bucket)
    .download(claimed.object_key);
  if (downloadError || !blob) {
    await finalize(client, assetId, {
      p_ok: false,
      p_mime: null,
      p_bytes: null,
      p_sha256: null,
      p_error_code: "FILE_MISSING",
    });
    return { assetId, state: "failed" };
  }

  const outcome = inspectUploadedObject(
    {
      purpose: claimed.purpose,
      mime: claimed.mime,
      bytes: Number(claimed.bytes),
      sha256: claimed.sha256,
    },
    new Uint8Array(await blob.arrayBuffer()),
  );
  if (!outcome.ok) {
    // The finalization RPC refuses to rewrite a declared digest or size, so a file that
    // is not what the client announced has exactly one terminal state available here.
    await finalize(client, assetId, {
      p_ok: false,
      p_mime: null,
      p_bytes: null,
      p_sha256: null,
      p_error_code: outcome.code,
    });
    return { assetId, state: "failed" };
  }
  await finalize(client, assetId, {
    p_ok: true,
    p_mime: outcome.mime,
    p_bytes: outcome.bytes,
    p_sha256: outcome.sha256,
    p_error_code: null,
  });
  return { assetId, state: "ready" };
}

export const validateAssetTask = task({
  id: VALIDATE_ASSET_TASK_ID,
  maxDuration: 300,
  run: async (payload: unknown) => {
    const input = validateAssetTaskPayload(payload);
    return executeAssetValidation(input.assetId);
  },
});
