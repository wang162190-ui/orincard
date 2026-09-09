import type { SupabaseClient } from "@supabase/supabase-js";
import { parseCarouselDocument, type CarouselDocument } from "../../domain/document";
import { parseToolResult, type ToolId, type ToolRequest, type ToolResult } from "../../domain/tools";
import { TEXT_TOOL_NAMES, type TextToolCandidate, type TextToolRequest } from "./text-tools";

export function toTextWorkerRequest(request: ToolRequest): TextToolRequest {
  if (!TEXT_TOOL_NAMES.includes(request.tool as (typeof TEXT_TOOL_NAMES)[number])) throw new Error("NOT_A_TEXT_TOOL");
  const input = request.input as Record<string, unknown>;
  const context = request.context;
  return {
    tool: request.tool as TextToolRequest["tool"],
    input: typeof input.text === "string" ? input.text : typeof input.topic === "string" ? input.topic : "",
    contextProjectId: context?.projectId,
    contextRevision: context?.expectedRevision,
    selectedContext: [context?.fields.title ? "title" : null, context?.fields.caption ? "caption" : null, context?.fields.slideIds?.length ? "slides" : null].filter((value): value is "title" | "caption" | "slides" => value !== null),
    selectedSlideIds: context?.fields.slideIds,
  };
}

export function candidateMarkdown(candidate: TextToolCandidate): string {
  const payload = candidate.payload;
  if (candidate.tool === "caption") return [payload.text, ...(Array.isArray(payload.hashtags) ? [payload.hashtags.join(" ")] : [])].filter(Boolean).join("\n\n");
  if (candidate.tool === "linkedin-post") return [payload.hook, payload.body, payload.cta, ...(Array.isArray(payload.hashtags) ? [payload.hashtags.join(" ")] : [])].filter((value) => typeof value === "string" && value).join("\n\n");
  const ideas = Array.isArray(payload.ideas) ? payload.ideas : [];
  return ideas.map((idea, index) => {
    const value = idea as Record<string, unknown>;
    return `${index + 1}. ${String(value.title ?? "")}\n${String(value.angle ?? "")}`;
  }).join("\n\n");
}

export function readToolResult(resultRef: unknown): { readonly tool: ToolId; readonly result: ToolResult; readonly contextProjectId?: string; readonly contextRevision?: number } {
  if (!resultRef || typeof resultRef !== "object" || Array.isArray(resultRef)) throw new Error("RESULT_UNAVAILABLE");
  const ref = resultRef as Record<string, unknown>;
  if (ref.candidate && typeof ref.candidate === "object") {
    const candidate = ref.candidate as TextToolCandidate;
    if (!TEXT_TOOL_NAMES.includes(candidate.tool)) throw new Error("RESULT_UNAVAILABLE");
    return { tool: candidate.tool, result: { kind: "text", markdown: candidateMarkdown(candidate) }, contextProjectId: candidate.contextProjectId, contextRevision: candidate.contextRevision };
  }
  if (typeof ref.tool !== "string") throw new Error("RESULT_UNAVAILABLE");
  return { tool: ref.tool as ToolId, result: parseToolResult(ref.result), contextProjectId: typeof ref.contextProjectId === "string" ? ref.contextProjectId : undefined, contextRevision: typeof ref.contextRevision === "number" ? ref.contextRevision : undefined };
}

export function applyToolResultToDocument(documentValue: unknown, result: ToolResult, target: unknown): CarouselDocument {
  const document = structuredClone(parseCarouselDocument(documentValue));
  if (!target || typeof target !== "object" || Array.isArray(target)) throw new Error("INVALID_TARGET");
  const value = target as Record<string, unknown>;
  if (value.kind === "caption" && result.kind === "text") {
    document.caption = result.markdown;
    return parseCarouselDocument(document);
  }
  throw new Error("INVALID_TARGET");
}

export async function loadOwnedToolResult(client: SupabaseClient, ownerId: string, jobId: string) {
  const query = await client.from("jobs").select("id,project_id,state,result_ref").eq("id", jobId).eq("owner_id", ownerId).eq("kind", "tool").maybeSingle();
  if (query.error || !query.data || query.data.state !== "succeeded") throw new Error("RESULT_UNAVAILABLE");
  return readToolResult(query.data.result_ref);
}
