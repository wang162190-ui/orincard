import { createHash, randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseToolResult, type ToolId, type ToolResult } from "../../domain/tools";

export type ToolOutputContent =
  | { readonly kind: "text"; readonly markdown: string }
  | { readonly kind: "image"; readonly bytes: Uint8Array; readonly mime: "image/png" | "image/jpeg"; readonly width: number; readonly height: number }
  | { readonly kind: "video"; readonly bytes: Uint8Array; readonly mime: "video/mp4"; readonly durationSeconds: number };

export interface PersistToolOutputInput {
  readonly ownerId: string;
  readonly jobId: string;
  readonly tool: ToolId;
  readonly content: ToolOutputContent;
  readonly contextProjectId?: string;
  readonly contextRevision?: number;
  readonly expiresAt: Date;
}

export interface PersistedToolOutput {
  readonly id: string;
  readonly jobId: string;
  readonly tool: ToolId;
  readonly result: ToolResult;
  readonly expiresAt: string;
}

export class ToolOutputError extends Error {
  constructor(readonly code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "OUTPUT_EXPIRED" | "NOT_READY" | "SERVICE_UNAVAILABLE", message: string, readonly status: number, readonly retryable = false) {
    super(message);
    this.name = "ToolOutputError";
  }
}

function extension(mime: "image/png" | "image/jpeg" | "video/mp4") {
  return mime === "image/png" ? "png" : mime === "image/jpeg" ? "jpg" : "mp4";
}

export async function persistToolOutput(client: SupabaseClient, input: PersistToolOutputInput, createId: () => string = randomUUID): Promise<PersistedToolOutput> {
  const expectedKind = input.tool === "caption" || input.tool === "linkedin-post" || input.tool === "post-ideas" ? "text"
    : input.tool === "carousel-to-video" ? "video" : "image";
  if (!Number.isFinite(input.expiresAt.getTime()) || input.expiresAt.getTime() <= Date.now() || Boolean(input.contextProjectId) !== Boolean(input.contextRevision) || input.content.kind !== expectedKind) throw new ToolOutputError("INVALID_REQUEST", "Tool output metadata is invalid.", 400);
  const outputId = createId();
  const assetId = input.content.kind === "text" ? null : createId();
  const result = parseToolResult(input.content.kind === "text"
    ? input.content
    : input.content.kind === "image"
      ? { kind: "image", assetId, width: input.content.width, height: input.content.height }
      : { kind: "video", outputId, durationSeconds: input.content.durationSeconds });
  let objectKey: string | null = null;
  if (input.content.kind !== "text") {
    objectKey = `${input.ownerId}/${input.jobId}/${outputId}/result.${extension(input.content.mime)}`;
    const { error } = await client.storage.from("exports").upload(objectKey, input.content.bytes, { contentType: input.content.mime, upsert: false });
    if (error) throw new ToolOutputError("SERVICE_UNAVAILABLE", "Tool output storage is temporarily unavailable.", 503, true);
  }
  const binary = input.content.kind === "text" ? null : input.content;
  const { error } = await client.rpc("server_register_tool_output", {
    p_id: outputId, p_owner_id: input.ownerId, p_job_id: input.jobId, p_tool: input.tool, p_result: result,
    p_context_project_id: input.contextProjectId ?? null, p_context_revision: input.contextRevision ?? null,
    p_expires_at: input.expiresAt.toISOString(), p_asset_id: assetId, p_object_key: objectKey,
    p_mime: binary?.mime ?? null, p_bytes: binary?.bytes.byteLength ?? null,
    p_sha256: binary ? createHash("sha256").update(binary.bytes).digest("hex") : null,
    p_width: binary?.kind === "image" ? binary.width : null, p_height: binary?.kind === "image" ? binary.height : null,
    p_duration_ms: binary?.kind === "video" ? Math.round(binary.durationSeconds * 1_000) : null,
  });
  if (error) {
    if (objectKey) await client.storage.from("exports").remove([objectKey]);
    throw new ToolOutputError("SERVICE_UNAVAILABLE", "Tool output registration failed.", 503, true);
  }
  return { id: outputId, jobId: input.jobId, tool: input.tool, result, expiresAt: input.expiresAt.toISOString() };
}

export interface ToolOutputDownloadStore {
  authorize(ownerId: string, outputId: string, jobId: string, now: Date): Promise<{ readonly bucket: "exports"; readonly objectKey: string; readonly mime: string; readonly expiresAt: string }>;
}

export function createSupabaseToolOutputDownloadStore(client: SupabaseClient): ToolOutputDownloadStore {
  return { async authorize(ownerId, outputId, jobId, now) {
    const { data, error } = await client.from("tool_outputs")
      .select("id,state,expires_at,result,asset_id,assets!inner(bucket,object_key,mime,purpose,state)")
      .eq("id", outputId).eq("owner_id", ownerId).eq("job_id", jobId).maybeSingle();
    if (error) throw new ToolOutputError("SERVICE_UNAVAILABLE", "Tool output download is temporarily unavailable.", 503, true);
    if (!data || data.state === "deleted") throw new ToolOutputError("NOT_FOUND", "Tool output not found.", 404);
    if (data.state === "expired" || new Date(data.expires_at).getTime() <= now.getTime()) throw new ToolOutputError("OUTPUT_EXPIRED", "This tool output has expired.", 410);
    if (data.state !== "ready" || !data.asset_id) throw new ToolOutputError("NOT_READY", "This tool output has no downloadable file.", 409);
    const asset = Array.isArray(data.assets) ? data.assets[0] : data.assets;
    if (!asset || asset.bucket !== "exports" || asset.purpose !== "tool_output" || asset.state !== "ready") throw new ToolOutputError("NOT_FOUND", "Tool output not found.", 404);
    return { bucket: "exports", objectKey: asset.object_key, mime: asset.mime, expiresAt: data.expires_at };
  } };
}

export function toolOutputErrorResponse(error: unknown, requestId: string) {
  const safe = error instanceof ToolOutputError ? error : new ToolOutputError("SERVICE_UNAVAILABLE", "Tool output download is temporarily unavailable.", 503, true);
  return Response.json({ error: { code: safe.code, message: safe.message, retryable: safe.retryable }, requestId }, { status: safe.status, headers: { "Cache-Control": "private, no-store" } });
}
