import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CarouselDocument } from "../../domain/document";
import type { StructuredAI } from "../ai";

export const TEXT_TOOL_NAMES = ["caption", "linkedInPost", "postIdeas"] as const;
export type TextToolName = (typeof TEXT_TOOL_NAMES)[number];
export const TEXT_CONTEXT_FIELDS = ["title", "caption", "slides"] as const;
export type TextContextField = (typeof TEXT_CONTEXT_FIELDS)[number];

export type TextToolRequest = {
  readonly tool: TextToolName;
  readonly input: string;
  readonly contextProjectId?: string;
  readonly contextRevision?: number;
  readonly selectedContext: readonly TextContextField[];
};

export type TextToolCandidate = {
  readonly schemaVersion: 1;
  readonly resultId: string;
  readonly jobId: string;
  readonly tool: TextToolName;
  readonly state: "candidate";
  readonly contextProjectId?: string;
  readonly contextRevision?: number;
  readonly payload: Readonly<Record<string, unknown>>;
};

const requestSchema = z.object({
  tool: z.enum(TEXT_TOOL_NAMES),
  input: z.string().max(5_000).default(""),
  contextProjectId: z.string().uuid().optional(),
  contextRevision: z.number().int().positive().optional(),
  selectedContext: z.array(z.enum(TEXT_CONTEXT_FIELDS)).max(TEXT_CONTEXT_FIELDS.length).default([]),
}).strict().superRefine((value, context) => {
  if (Boolean(value.contextProjectId) !== Boolean(value.contextRevision)) {
    context.addIssue({ code: "custom", message: "Project ID and revision must be provided together." });
  }
  if (!value.contextProjectId && value.selectedContext.length > 0) {
    context.addIssue({ code: "custom", message: "Selected context requires a project." });
  }
});

const captionSchema = z.object({ text: z.string().min(1).max(3_000), hashtags: z.array(z.string().regex(/^#[^\s#]+$/)).max(10) }).strict();
const linkedInPostSchema = z.object({ hook: z.string().min(1).max(500), body: z.string().min(1).max(5_000), cta: z.string().max(500), hashtags: z.array(z.string().regex(/^#[^\s#]+$/)).max(10) }).strict();
const postIdeasSchema = z.object({ ideas: z.array(z.object({ title: z.string().min(1).max(200), angle: z.string().min(1).max(500) }).strict()).min(3).max(10) }).strict();

const OUTPUTS = {
  caption: captionSchema,
  linkedInPost: linkedInPostSchema,
  postIdeas: postIdeasSchema,
} as const;

const JSON_SCHEMAS: Record<TextToolName, Record<string, unknown>> = {
  caption: { type: "object", additionalProperties: false, required: ["text", "hashtags"], properties: { text: { type: "string" }, hashtags: { type: "array", maxItems: 10, items: { type: "string", pattern: "^#[^\\s#]+$" } } } },
  linkedInPost: { type: "object", additionalProperties: false, required: ["hook", "body", "cta", "hashtags"], properties: { hook: { type: "string" }, body: { type: "string" }, cta: { type: "string" }, hashtags: { type: "array", maxItems: 10, items: { type: "string", pattern: "^#[^\\s#]+$" } } } },
  postIdeas: { type: "object", additionalProperties: false, required: ["ideas"], properties: { ideas: { type: "array", minItems: 3, maxItems: 10, items: { type: "object", additionalProperties: false, required: ["title", "angle"], properties: { title: { type: "string" }, angle: { type: "string" } } } } } },
};

export function parseTextToolRequest(value: unknown): TextToolRequest {
  const parsed = requestSchema.parse(value);
  return { ...parsed, input: parsed.input.trim(), selectedContext: [...new Set(parsed.selectedContext)] };
}

export function selectProjectContext(document: CarouselDocument, selected: readonly TextContextField[]) {
  const context: Record<string, unknown> = {};
  if (selected.includes("title")) context.title = document.title;
  if (selected.includes("caption")) context.caption = document.caption;
  if (selected.includes("slides")) {
    context.slides = document.slides.map((slide) => ({
      title: slide.title,
      body: slide.bodyBlocks.map((block) => block.kind === "bullets" ? block.items.join("\n") : block.text).join("\n"),
    }));
  }
  return context;
}

export async function generateTextToolCandidate(input: {
  readonly ai: StructuredAI;
  readonly jobId: string;
  readonly request: TextToolRequest;
  readonly selectedProjectContext?: Readonly<Record<string, unknown>>;
  readonly createId?: () => string;
}): Promise<TextToolCandidate> {
  const request = parseTextToolRequest(input.request);
  const output = await input.ai.generateStructured({
    instructions: "Create the requested social content. Do not claim it was published, invent account mentions, or present unsupported claims as facts. Return only the requested JSON shape.",
    input: JSON.stringify({ tool: request.tool, brief: request.input || "Create a useful general professional content draft.", selectedProjectContext: input.selectedProjectContext ?? {} }),
    schemaName: `orincard_${request.tool}`,
    schema: JSON_SCHEMAS[request.tool],
  });
  const parsed = OUTPUTS[request.tool].safeParse(output);
  if (!parsed.success) throw new Error("TEXT_TOOL_INVALID_OUTPUT");
  return {
    schemaVersion: 1,
    resultId: (input.createId ?? randomUUID)(),
    jobId: input.jobId,
    tool: request.tool,
    state: "candidate",
    contextProjectId: request.contextProjectId,
    contextRevision: request.contextRevision,
    payload: parsed.data,
  };
}
