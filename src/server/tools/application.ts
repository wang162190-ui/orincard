import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { parseCarouselDocument, type CarouselDocument } from "../../domain/document";
import { parseToolResult, type ToolId, type ToolRequest, type ToolResult } from "../../domain/tools";
import { TEXT_TOOL_NAMES, type TextToolCandidate, type TextToolRequest } from "./text-tools";
// Type-only: the visual tool module pulls Chromium and ffmpeg behind it, so the API route
// that adapts a request must never load it.
import type { VisualToolName } from "./visual-tools";

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

// data-model.md: 独立工具产物默认保留 7 天。
export const TOOL_OUTPUT_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

export const VISUAL_TOOL_IDS = ["quote-card", "infographic", "portrait", "carousel-to-video"] as const satisfies readonly VisualToolName[];

export type VisualWorkerRequest = {
  readonly tool: VisualToolName;
  readonly input: Readonly<Record<string, unknown>>;
  readonly contextProjectId?: string;
  readonly contextRevision?: number;
};

// These mirror the candidate schemas in visual-tools.ts so a request the public route accepts
// can never widen past what the worker will parse; the route answers 400 instead of the worker
// failing a queued job later.
const visualInputSchemas = {
  "quote-card": z.object({ quote: z.string().trim().min(1).max(2_000), attribution: z.string().trim().max(200).optional(), attributionConfirmed: z.boolean() }).strict(),
  infographic: z.object({ content: z.string().trim().min(1).max(20_000), title: z.string().trim().min(1).max(200).optional(), instructions: z.string().trim().max(1_000).optional() }).strict(),
  portrait: z.object({ prompt: z.string().trim().min(1).max(2_000), referenceAssetId: z.string().uuid() }).strict(),
  "carousel-to-video": z.object({ slideAssetIds: z.array(z.string().uuid()).min(1).max(12), secondsPerSlide: z.number().int().min(1).max(15), audioAssetId: z.string().uuid().optional() }).strict(),
} as const satisfies Record<VisualToolName, z.ZodType>;

const visualRequestSchema = z.object({
  tool: z.enum(VISUAL_TOOL_IDS),
  input: z.record(z.string(), z.unknown()),
  contextProjectId: z.string().uuid().optional(),
  contextRevision: z.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if (Boolean(value.contextProjectId) !== Boolean(value.contextRevision)) {
    context.addIssue({ code: "custom", message: "Project ID and revision must be provided together." });
  }
});

export function parseVisualWorkerRequest(value: unknown): VisualWorkerRequest {
  const envelope = visualRequestSchema.parse(value);
  return { ...envelope, input: visualInputSchemas[envelope.tool].parse(envelope.input) as Readonly<Record<string, unknown>> };
}

function visualInput(request: ToolRequest): Record<string, unknown> {
  const input = request.input as Record<string, unknown>;
  if (request.tool === "quote-card") return { quote: input.quote, ...(input.attribution ? { attribution: input.attribution } : {}), attributionConfirmed: input.attributionConfirmed };
  if (request.tool === "infographic") return { content: input.content, ...(input.title ? { title: input.title } : {}), ...(input.instructions ? { instructions: input.instructions } : {}) };
  if (request.tool === "portrait") return { prompt: input.prompt, referenceAssetId: input.referenceAssetId };
  // Slides come either from the direct input or from the slides the user explicitly selected.
  return {
    slideAssetIds: input.slideAssetIds ?? request.context?.fields.slideIds,
    secondsPerSlide: input.secondsPerSlide,
    ...(input.audioAssetId ? { audioAssetId: input.audioAssetId } : {}),
  };
}

export function toVisualWorkerRequest(request: ToolRequest): VisualWorkerRequest {
  if (!VISUAL_TOOL_IDS.includes(request.tool as VisualToolName)) throw new Error("NOT_A_VISUAL_TOOL");
  const context = request.context;
  return parseVisualWorkerRequest({
    tool: request.tool,
    input: visualInput(request),
    ...(context ? { contextProjectId: context.projectId, contextRevision: context.expectedRevision } : {}),
  });
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
