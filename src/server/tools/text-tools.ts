import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { CarouselDocument } from "../../domain/document";
import type { StructuredAI, StructuredOutputRequest } from "../ai";

export const TEXT_TOOL_NAMES = ["caption", "linkedin-post", "post-ideas"] as const;
export type TextToolName = (typeof TEXT_TOOL_NAMES)[number];
export const TEXT_CONTEXT_FIELDS = ["title", "caption", "slides"] as const;
export type TextContextField = (typeof TEXT_CONTEXT_FIELDS)[number];

export type TextToolRequest = {
  readonly tool: TextToolName;
  readonly input: string;
  /** post-ideas 要几条。缺省表示调用方没指定，沿用 3–10 的老区间。 */
  readonly count?: number;
  /** 用户对这次加工的额外要求。是**数据**不是指令，见 `generateTextToolCandidate`。 */
  readonly instructions?: string;
  readonly contextProjectId?: string;
  readonly contextRevision?: number;
  readonly selectedContext: readonly TextContextField[];
  readonly selectedSlideIds?: readonly string[];
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
  // 上界与 `src/domain/tools.ts` 的 `inputSchemas` 对齐。两者都 optional 而非 default：
  // 这次扩展之前入库的 input_ref 不带这两个键，不能因为加字段就变得不可解析。
  count: z.number().int().min(1).max(10).optional(),
  instructions: z.string().trim().max(1_000).optional(),
  contextProjectId: z.string().uuid().optional(),
  contextRevision: z.number().int().positive().optional(),
  selectedContext: z.array(z.enum(TEXT_CONTEXT_FIELDS)).max(TEXT_CONTEXT_FIELDS.length).default([]),
  selectedSlideIds: z.array(z.string().uuid()).max(12).optional(),
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
const ideaSchema = z.object({ title: z.string().min(1).max(200), angle: z.string().min(1).max(500) }).strict();
const ideaJsonSchema = { type: "object", additionalProperties: false, required: ["title", "angle"], properties: { title: { type: "string" }, angle: { type: "string" } } } as const;

/**
 * `count` 是**确数**，不是上界：计划写 `count: 3` 就必须回 3 条。
 *
 * 从前这两处都写死 3–10，于是调用方要 3 条、模型回 5 条，没人报错——目录里明明把
 * `count` 广告给了模型（`src/server/agent/prompts.ts` 的 `buildToolCatalog`），载荷却
 * 把它丢了。约束同时进 JSON Schema（让模型照着出）和 Zod（出格就判错），缺一不可：
 * 只约束前者等于信供应商守约。
 */
function postIdeasBounds(count?: number) {
  return { min: count ?? 3, max: count ?? 10 };
}

const OUTPUTS = {
  caption: captionSchema,
  "linkedin-post": linkedInPostSchema,
} as const;

const JSON_SCHEMAS: Record<Exclude<TextToolName, "post-ideas">, Record<string, unknown>> = {
  caption: { type: "object", additionalProperties: false, required: ["text", "hashtags"], properties: { text: { type: "string" }, hashtags: { type: "array", maxItems: 10, items: { type: "string", pattern: "^#[^\\s#]+$" } } } },
  "linkedin-post": { type: "object", additionalProperties: false, required: ["hook", "body", "cta", "hashtags"], properties: { hook: { type: "string" }, body: { type: "string" }, cta: { type: "string" }, hashtags: { type: "array", maxItems: 10, items: { type: "string", pattern: "^#[^\\s#]+$" } } } },
};

export function textToolOutputSchema(tool: TextToolName, count?: number): z.ZodType<Readonly<Record<string, unknown>>> {
  if (tool !== "post-ideas") return OUTPUTS[tool];
  const { min, max } = postIdeasBounds(count);
  return z.object({ ideas: z.array(ideaSchema).min(min).max(max) }).strict();
}

export function textToolJsonSchema(tool: TextToolName, count?: number): Record<string, unknown> {
  if (tool !== "post-ideas") return JSON_SCHEMAS[tool];
  const { min, max } = postIdeasBounds(count);
  return { type: "object", additionalProperties: false, required: ["ideas"], properties: { ideas: { type: "array", minItems: min, maxItems: max, items: ideaJsonSchema } } };
}

export function parseTextToolRequest(value: unknown): TextToolRequest {
  const parsed = requestSchema.parse(value);
  return { ...parsed, input: parsed.input.trim(), selectedContext: [...new Set(parsed.selectedContext)] };
}

export function selectProjectContext(document: CarouselDocument, selected: readonly TextContextField[], selectedSlideIds?: readonly string[]) {
  const context: Record<string, unknown> = {};
  if (selected.includes("title")) context.title = document.title;
  if (selected.includes("caption")) context.caption = document.caption;
  if (selected.includes("slides")) {
    const ids = selectedSlideIds ? new Set(selectedSlideIds) : null;
    context.slides = document.slides.filter((slide) => !ids || ids.has(slide.id)).map((slide) => ({
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
  readonly onMeasurement?: StructuredOutputRequest["onMeasurement"];
}): Promise<TextToolCandidate> {
  const request = parseTextToolRequest(input.request);
  const output = await input.ai.generateStructured({
    instructions: "Create the requested social content. Do not claim it was published, invent account mentions, or present unsupported claims as facts. Return only the requested JSON shape.",
    // `userInstructions` 和 `brief` 一样是不可信数据键，绝不能并进上面的 `instructions`
    // 系统字段——用户写的加工要求是素材，不是能改写角色设定的指令。
    input: JSON.stringify({
      tool: request.tool,
      brief: request.input || "Create a useful general professional content draft.",
      userInstructions: request.instructions,
      requestedCount: request.count,
      selectedProjectContext: input.selectedProjectContext ?? {},
    }),
    schemaName: `orincard_${request.tool}`,
    schema: textToolJsonSchema(request.tool, request.count),
    onMeasurement: input.onMeasurement,
  });
  const parsed = textToolOutputSchema(request.tool, request.count).safeParse(output);
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
