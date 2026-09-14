import { setDefaultResultOrder } from "node:dns";
import { task } from "@trigger.dev/sdk";
import { AiAssetError, createApiMartImageProvider, generatedMetadata, type AiImageKind } from "../server/assets/ai-image";
import { createAdminSupabaseClient } from "../server/supabase";

export const GENERATE_IMAGE_TASK_ID = "orincard-generate-image";

export function validateImageGenerationPayload(payload: unknown): { readonly assetId: string; readonly schemaVersion: 1 } {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) throw new Error("Invalid image generation payload");
  const value = payload as Record<string, unknown>;
  if (Object.keys(value).sort().join(",") !== "assetId,schemaVersion" || typeof value.assetId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value.assetId) || value.schemaVersion !== 1) throw new Error("Invalid image generation payload");
  return { assetId: value.assetId, schemaVersion: 1 };
}

export async function executeImageGeneration(assetId: string, provider = createApiMartImageProvider(process.env.APIMART_API_KEY?.trim() ?? "")) {
  setDefaultResultOrder("ipv4first");
  const client = createAdminSupabaseClient();
  const { data: asset } = await client.from("assets").select("id,owner_id,kind,rights,state").eq("id", assetId).in("kind", ["ai_image", "portrait"]).eq("state", "pending_upload").maybeSingle();
  if (!asset) return { assetId, state: "skipped" as const };
  const rights = asset.rights as Record<string, unknown>;
  const prompt = typeof rights.prompt === "string" ? rights.prompt : "";
  const referenceAssetId = typeof rights.referenceAssetId === "string" ? rights.referenceAssetId : null;
  let referenceMime: string | undefined;
  // actualMicroUsd 传 null 表示「供应商没回报成本」，由 SQL 按预留全额保守入账并记为
  // unmeasured_reserved。这里**不再**用 $0.025 之类的常数补位——编出来的数字落库之后和实测
  // 成本长得一样，没人分得出来。见 supabase/migrations/20260912020000_asset_cost_source.sql。
  const finalizeBudget = async (succeeded: boolean, providerOperationId: string | null, actualMicroUsd: number | null) => {
    const { error } = await client.rpc("server_finalize_ai_asset_candidate", { p_asset_id: asset.id, p_owner_id: asset.owner_id, p_succeeded: succeeded, p_provider_operation_id: providerOperationId, p_actual_micro_usd: actualMicroUsd });
    if (error) throw new Error("image budget finalization failed");
  };
  const fail = async (code: string) => {
    await client.from("assets").update({ state: "failed", error_code: code }).eq("id", asset.id).eq("owner_id", asset.owner_id).eq("state", "pending_upload");
    await finalizeBudget(false, null, 0);
    return { assetId, state: "failed" as const };
  };
  try {
    let reference: Uint8Array | undefined;
    if (asset.kind === "portrait") {
      if (!referenceAssetId) return fail("REFERENCE_UNAVAILABLE");
      const { data: source } = await client.from("assets").select("bucket,object_key,mime,state,owner_id").eq("id", referenceAssetId).eq("owner_id", asset.owner_id).eq("state", "ready").maybeSingle();
      if (!source || source.bucket !== "assets" || !["image/png", "image/jpeg", "image/webp"].includes(source.mime)) return fail("REFERENCE_UNAVAILABLE");
      const { data, error } = await client.storage.from(source.bucket).download(source.object_key);
      if (error || !data) return fail("REFERENCE_UNAVAILABLE");
      reference = new Uint8Array(await data.arrayBuffer());
      referenceMime = source.mime;
    }
    console.info("[image-generation] provider request started", { assetId: asset.id, provider: "apimart" });
    const image = await provider.generate({ kind: asset.kind as AiImageKind, prompt, reference, referenceMime });
    console.info("[image-generation] provider request completed", { assetId: asset.id, provider: "apimart", providerOperationId: image.providerOperationId });
    const metadata = generatedMetadata(image.bytes);
    const objectKey = `${asset.owner_id}/${asset.id}/generated.png`;
    const { error: uploadError } = await client.storage.from("assets").upload(objectKey, image.bytes, { contentType: image.mime, upsert: false });
    if (uploadError) return fail("ASSET_UPLOAD_FAILED");
    const { error: updateError } = await client.from("assets").update({ object_key: objectKey, mime: image.mime, ...metadata, state: "ready", error_code: null }).eq("id", asset.id).eq("owner_id", asset.owner_id).eq("state", "pending_upload");
    if (updateError) { await client.storage.from("assets").remove([objectKey]); return fail("ASSET_UPLOAD_FAILED"); }
    await finalizeBudget(
      true,
      image.providerOperationId,
      image.providerCostUsd === null ? null : Math.max(0, Math.round(image.providerCostUsd * 1_000_000)),
    );
    return { assetId, state: "ready" as const };
  } catch (error) {
    console.error("[image-generation] provider request failed", { assetId: asset.id, error: error instanceof Error ? error.name : "UnknownError" });
    return fail(error instanceof AiAssetError && error.internalCode ? error.internalCode : "PROVIDER_FAILED");
  }
}

export const generateImageTask = task({ id: GENERATE_IMAGE_TASK_ID, maxDuration: 300, run: async (payload: unknown) => executeImageGeneration(validateImageGenerationPayload(payload).assetId) });
