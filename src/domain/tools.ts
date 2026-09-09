import { z } from "zod";

export const TOOL_IDS = [
  "caption",
  "linkedin-post",
  "post-ideas",
  "quote-card",
  "infographic",
  "portrait",
  "carousel-to-video",
] as const;

export type ToolId = (typeof TOOL_IDS)[number];
export type ToolResultType = "text" | "image" | "video";

const uuid = z.string().uuid();
const shortText = z.string().trim().min(1).max(2_000);
const longText = z.string().trim().min(1).max(20_000);

export const toolContextSelectionSchema = z.object({
  projectId: uuid,
  expectedRevision: z.number().int().positive(),
  fields: z.object({
    title: z.boolean().optional(),
    caption: z.boolean().optional(),
    slideIds: z.array(uuid).max(12).optional(),
    assetIds: z.array(uuid).max(24).optional(),
    brandSnapshot: z.boolean().optional(),
  }).strict().refine((fields) =>
    fields.title === true || fields.caption === true || fields.brandSnapshot === true ||
    (fields.slideIds?.length ?? 0) > 0 || (fields.assetIds?.length ?? 0) > 0,
  { message: "Select at least one project context field." }),
}).strict();

export type ToolContextSelection = z.infer<typeof toolContextSelectionSchema>;

const instructions = z.string().trim().max(1_000).optional();
const inputSchemas = {
  caption: z.object({ text: longText.optional(), instructions }).strict(),
  "linkedin-post": z.object({ text: longText.optional(), instructions }).strict(),
  "post-ideas": z.object({ topic: shortText.optional(), count: z.number().int().min(1).max(10).default(5), instructions }).strict(),
  "quote-card": z.object({ quote: shortText, attribution: z.string().trim().max(200).optional(), attributionConfirmed: z.boolean() }).strict(),
  infographic: z.object({ content: longText, title: z.string().trim().max(200).optional(), instructions }).strict(),
  portrait: z.object({ prompt: shortText, referenceAssetId: uuid }).strict(),
  "carousel-to-video": z.object({ slideAssetIds: z.array(uuid).min(1).max(12).optional(), secondsPerSlide: z.number().min(1).max(30).default(4), audioAssetId: uuid.optional() }).strict(),
} as const satisfies Record<ToolId, z.ZodType>;

export type ToolInputById = {
  [K in ToolId]: z.infer<(typeof inputSchemas)[K]>;
};

export interface ToolRequest<K extends ToolId = ToolId> {
  readonly tool: K;
  readonly input: ToolInputById[K];
  readonly context?: ToolContextSelection;
}

function requiresContent(tool: ToolId, input: Record<string, unknown>, context: ToolContextSelection | undefined) {
  if ((tool === "caption" || tool === "linkedin-post") && !input.text && !context) return false;
  if (tool === "post-ideas" && !input.topic && !context) return false;
  if (tool === "carousel-to-video" && !Array.isArray(input.slideAssetIds) && !context?.fields.slideIds?.length) return false;
  return true;
}

export function parseToolRequest<K extends ToolId>(tool: K, value: unknown): ToolRequest<K> {
  if (!TOOL_IDS.includes(tool)) throw new Error("Unknown tool.");
  const envelope = z.object({ input: z.unknown(), context: toolContextSelectionSchema.optional() }).strict().parse(value);
  const parsedInput = inputSchemas[tool].parse(envelope.input) as ToolInputById[K];
  if (!requiresContent(tool, parsedInput as Record<string, unknown>, envelope.context)) {
    throw new Error(tool === "carousel-to-video" ? "Select at least one slide." : "Provide input or explicitly selected project context.");
  }
  return { tool, input: parsedInput, ...(envelope.context ? { context: envelope.context } : {}) };
}

export const toolResultSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("text"), markdown: z.string().max(50_000) }).strict(),
  z.object({ kind: z.literal("image"), assetId: uuid, width: z.number().int().positive(), height: z.number().int().positive() }).strict(),
  z.object({ kind: z.literal("video"), outputId: uuid, durationSeconds: z.number().positive() }).strict(),
]);

export type ToolResult = z.infer<typeof toolResultSchema>;

export function parseToolResult(value: unknown): ToolResult {
  return toolResultSchema.parse(value);
}
