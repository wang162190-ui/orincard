import { createHmac, randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MAX_SLIDE_COUNT,
  MIN_SLIDE_COUNT,
  parseCarouselDocument,
  type CarouselDocument,
  type Platform,
} from "../domain/document";
import { themes, type ThemeId } from "../render/templates";
import { AIServiceError, type StructuredAI, type StructuredOutputRequest } from "./ai";
import type { AppEnvironment } from "./environment";
import { buildGenerationPrompt, buildSchemaRepairPrompt } from "./prompts";
import type { SourceRecord } from "./sources";

// 语言从自由文本收成枚举：自由文本框里写什么都行（"中文"/"zh"/"Chinese, please"），
// 模型对每种写法的反应不一样，导出字体也没法据此判断。枚举之后才谈得上按语言验收。
export const GENERATION_LANGUAGES = ["en", "zh-Hans"] as const;
export type GenerationLanguage = (typeof GENERATION_LANGUAGES)[number];

export function isGenerationLanguage(value: unknown): value is GenerationLanguage {
  return typeof value === "string" && (GENERATION_LANGUAGES as readonly string[]).includes(value);
}

export interface GenerationOptions {
  readonly language: GenerationLanguage;
  readonly format: string;
  readonly pageCount: number;
  readonly instructions: string;
  readonly templateId: ThemeId;
  readonly platform: Platform;
}

export const generationJsonSchema: Record<string, unknown> = {
  type: "object",
  additionalProperties: false,
  required: ["title", "caption", "slides"],
  properties: {
    title: { type: "string", minLength: 1 },
    caption: { type: "string" },
    slides: {
      type: "array",
      minItems: MIN_SLIDE_COUNT,
      maxItems: MAX_SLIDE_COUNT,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["role", "eyebrow", "title", "body", "cta"],
        properties: {
          role: { type: "string", enum: ["intro", "content", "outro"] },
          eyebrow: { type: ["string", "null"] },
          title: { type: "string", minLength: 1 },
          body: { type: "string", minLength: 1 },
          cta: { type: ["string", "null"] },
        },
      },
    },
  },
};

const generatedOutputSchema = z
  .object({
    title: z.string().trim().min(1),
    caption: z.string(),
    slides: z
      .array(
        z
          .object({
            role: z.enum(["intro", "content", "outro"]),
            eyebrow: z.string().nullable(),
            title: z.string().trim().min(1),
            body: z.string().trim().min(1),
            cta: z.string().nullable(),
          })
          .strict(),
      )
      .min(MIN_SLIDE_COUNT)
      .max(MAX_SLIDE_COUNT),
  })
  .strict();

type GeneratedOutput = z.infer<typeof generatedOutputSchema>;

export class GenerationError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "CONFIRMATION_REQUIRED"
      | "NOT_FOUND"
      | "VERSION_CONFLICT"
      | "IDEMPOTENCY_CONFLICT"
      | "QUOTA_EXCEEDED"
      | "BUDGET_EXCEEDED"
      | "PROVIDER_FAILED"
      | "SERVICE_UNAVAILABLE",
    message: string,
    readonly retryable: boolean,
    readonly status = code === "INVALID_REQUEST" ? 400 : 502,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

export interface RegenerationCandidate {
  readonly candidateJobId: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly document: CarouselDocument;
}

type RegenerationMode = "replace" | "save_copy";

interface RegenerationBeginInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly options: GenerationOptions;
  readonly environment: AppEnvironment;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

type RegenerationBeginResult =
  | { readonly outcome: "accepted"; readonly candidateJobId: string }
  | { readonly outcome: "replay"; readonly candidate: RegenerationCandidate }
  | {
      readonly outcome:
        | "not_found"
        | "stale"
        | "idempotency_conflict"
        | "quota_exceeded"
        | "budget_exceeded";
    };

interface RegenerationConfirmInput {
  readonly ownerId: string;
  readonly projectId: string;
  readonly candidateJobId: string;
  readonly expectedRevision: number;
  readonly mode: RegenerationMode;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

type RegenerationConfirmResult =
  | {
      readonly outcome: "confirmed" | "replay";
      readonly projectId: string;
      readonly revision: number;
    }
  | {
      readonly outcome: "not_found" | "stale" | "idempotency_conflict";
    };

export interface RegenerationStore {
  begin(input: RegenerationBeginInput): Promise<RegenerationBeginResult>;
  complete(input: { readonly candidate: RegenerationCandidate }): Promise<void>;
  confirm(input: RegenerationConfirmInput): Promise<RegenerationConfirmResult>;
}

interface RegenerationRpcClient {
  rpc(name: string, parameters: Readonly<Record<string, unknown>>): PromiseLike<{
    readonly data: unknown;
    readonly error: unknown;
  }>;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_KEY_PATTERN = /^[\x21-\x7e]{8,200}$/;

function regenerationUnavailable(): GenerationError {
  return new GenerationError(
    "SERVICE_UNAVAILABLE",
    "The required atomic regeneration RPC is unavailable. Your project was not changed.",
    true,
    503,
  );
}

function regenerationRpcRow(value: unknown): Record<string, unknown> {
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== "object" || row === null) throw regenerationUnavailable();
  return row as Record<string, unknown>;
}

export function createSupabaseRegenerationStore(
  client: RegenerationRpcClient,
): RegenerationStore {
  async function rpc(name: string, parameters: Record<string, unknown>) {
    try {
      const { data, error } = await client.rpc(name, parameters);
      if (error) throw regenerationUnavailable();
      return regenerationRpcRow(data);
    } catch (error) {
      if (error instanceof GenerationError) throw error;
      throw regenerationUnavailable();
    }
  }
  return {
    async begin(input) {
      return (await rpc("server_begin_regeneration_candidate", {
        p_environment: input.environment,
        p_idempotency_key: input.idempotencyKey,
        p_options: input.options,
        p_owner_id: input.ownerId,
        p_project_id: input.projectId,
        p_project_revision: input.projectRevision,
        p_request_hash: input.requestHash,
      })) as unknown as RegenerationBeginResult;
    },
    async complete({ candidate }) {
      await rpc("server_complete_regeneration_candidate", {
        p_candidate: candidate,
        p_candidate_job_id: candidate.candidateJobId,
      });
    },
    async confirm(input) {
      return (await rpc("server_confirm_regeneration_candidate", {
        p_candidate_job_id: input.candidateJobId,
        p_expected_revision: input.expectedRevision,
        p_idempotency_key: input.idempotencyKey,
        p_mode: input.mode,
        p_owner_id: input.ownerId,
        p_project_id: input.projectId,
        p_request_hash: input.requestHash,
      })) as unknown as RegenerationConfirmResult;
    },
  };
}

function regenerationHash(secret: string, value: unknown): string {
  if (!secret) throw regenerationUnavailable();
  return createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
}

function requireRegenerationWrite(
  projectId: string,
  idempotencyKey: string,
): void {
  if (!UUID_PATTERN.test(projectId) || !OPERATION_KEY_PATTERN.test(idempotencyKey)) {
    throw new GenerationError(
      "INVALID_REQUEST",
      "Regeneration request identifiers are invalid.",
      false,
      400,
    );
  }
}

function storedCandidate(
  candidate: RegenerationCandidate,
  projectId: string,
  projectRevision: number,
): RegenerationCandidate {
  try {
    if (
      !UUID_PATTERN.test(candidate.candidateJobId) ||
      candidate.projectId !== projectId ||
      candidate.projectRevision !== projectRevision
    ) {
      throw new Error("candidate identity mismatch");
    }
    return { ...candidate, document: parseCarouselDocument(candidate.document) };
  } catch {
    throw regenerationUnavailable();
  }
}

function validateOptions(options: GenerationOptions): void {
  if (
    !Number.isInteger(options.pageCount) ||
    options.pageCount < MIN_SLIDE_COUNT ||
    options.pageCount > MAX_SLIDE_COUNT ||
    !isGenerationLanguage(options.language) ||
    !options.format.trim() ||
    options.instructions.length > 2_000 ||
    !themes[options.templateId]
  ) {
    throw new GenerationError(
      "INVALID_REQUEST",
      "Generation options are invalid.",
      false,
    );
  }
}

function parseOutput(value: unknown, pageCount: number): GeneratedOutput | null {
  const parsed = generatedOutputSchema.safeParse(value);
  if (!parsed.success || parsed.data.slides.length !== pageCount) {
    return null;
  }
  const roles = parsed.data.slides.map((slide) => slide.role);
  if (
    roles[0] !== "intro" ||
    roles.at(-1) !== "outro" ||
    roles.slice(1, -1).some((role) => role !== "content")
  ) {
    return null;
  }
  return parsed.data;
}

function toDocument(
  output: GeneratedOutput,
  source: SourceRecord,
  options: GenerationOptions,
  createId: () => string,
): CarouselDocument {
  const theme = themes[options.templateId];
  const reference = source.segments[0];
  return parseCarouselDocument({
    schemaVersion: 1,
    title: output.title,
    platform: options.platform,
    templateId: theme.templateId,
    templateVersion: theme.templateVersion,
    theme: structuredClone(theme.settings),
    brandSnapshot: null,
    slides: output.slides.map((slide) => ({
      id: createId(),
      revision: 1,
      role: slide.role,
      mode: "text",
      layoutId:
        slide.role === "intro"
          ? "intro-centered"
          : slide.role === "outro"
            ? "outro-cta"
            : "statement",
      eyebrow: slide.eyebrow,
      title: slide.title,
      bodyBlocks: [
        {
          kind: "paragraph",
          text: slide.body,
          emphasisRanges: [],
          sourceRefs: reference
            ? [
                {
                  sourceId: source.id,
                  segmentId: reference.segmentId,
                  kind: "paraphrase",
                },
              ]
            : undefined,
        },
      ],
      cta: slide.cta,
      assetSlots: [],
      counterVisible: slide.role === "content",
      overrides: {},
    })),
    caption: output.caption,
    assetRefs: [],
  });
}

export async function generateCarouselDocument(input: {
  readonly ai: StructuredAI;
  readonly source: SourceRecord;
  readonly options: GenerationOptions;
  readonly createId?: () => string;
  /**
   * 供应商回报实测用量时逐次回调。修复重试会回调两次，但两次共用同一个 attempt_key，
   * 调用方必须合并后只结算一次（见 src/server/cost-settlement.ts）。
   */
  readonly onMeasurement?: StructuredOutputRequest["onMeasurement"];
}): Promise<CarouselDocument> {
  validateOptions(input.options);
  const prompt = buildGenerationPrompt(input.source, input.options);
  let first: unknown;
  try {
    first = await input.ai.generateStructured({
      ...prompt,
      schemaName: "orincard_carousel",
      schema: generationJsonSchema,
      onMeasurement: input.onMeasurement,
    });
  } catch (error) {
    if (!(error instanceof AIServiceError) || !error.schemaRepairable) {
      throw new GenerationError(
        "PROVIDER_FAILED",
        "AI generation is temporarily unavailable.",
        true,
      );
    }
    first = null;
  }

  const valid = parseOutput(first, input.options.pageCount);
  if (valid) {
    return toDocument(valid, input.source, input.options, input.createId ?? randomUUID);
  }

  const repair = buildSchemaRepairPrompt(input.source, input.options, first);
  try {
    const repaired = await input.ai.generateStructured({
      ...repair,
      schemaName: "orincard_carousel",
      schema: generationJsonSchema,
      onMeasurement: input.onMeasurement,
    });
    const validRepair = parseOutput(repaired, input.options.pageCount);
    if (validRepair) {
      return toDocument(
        validRepair,
        input.source,
        input.options,
        input.createId ?? randomUUID,
      );
    }
  } catch {
    // The single schema-repair attempt is intentionally bounded.
  }
  throw new GenerationError(
    "PROVIDER_FAILED",
    "AI returned an invalid carousel after one repair attempt.",
    true,
  );
}

export async function createRegenerationCandidate(input: {
  readonly ownerId: string;
  readonly projectId: string;
  readonly projectRevision: number;
  readonly document: CarouselDocument;
  readonly options: GenerationOptions;
  readonly confirmed: boolean;
  readonly idempotencyKey: string;
  readonly hashSecret: string;
  readonly environment?: AppEnvironment;
  readonly generate: (input: {
    readonly document: CarouselDocument;
    readonly options: GenerationOptions;
  }) => Promise<CarouselDocument>;
  readonly store: RegenerationStore;
  /**
   * 拿到候选任务 ID 时立即回调，早于供应商调用。供应商失败时本函数会抛错、拿不到返回值，
   * 但那次调用的 token 已经烧掉了——调用方需要这个 ID 才能在失败路径上结算。
   */
  readonly onCandidateJob?: (candidateJobId: string) => void;
}): Promise<RegenerationCandidate> {
  requireRegenerationWrite(input.projectId, input.idempotencyKey);
  if (!input.confirmed) {
    throw new GenerationError(
      "CONFIRMATION_REQUIRED",
      "Confirm before generating a replacement candidate.",
      false,
      400,
    );
  }
  if (!Number.isSafeInteger(input.projectRevision) || input.projectRevision < 1) {
    throw new GenerationError(
      "INVALID_REQUEST",
      "Project revision is invalid.",
      false,
      400,
    );
  }
  validateOptions(input.options);
  const requestHash = regenerationHash(input.hashSecret, {
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    options: input.options,
  });
  const begun = await input.store.begin({
    ownerId: input.ownerId,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    options: input.options,
    environment: input.environment ?? "development",
    idempotencyKey: input.idempotencyKey,
    requestHash,
  });
  if (begun.outcome === "replay") {
    return storedCandidate(begun.candidate, input.projectId, input.projectRevision);
  }
  if (begun.outcome === "not_found") {
    throw new GenerationError("NOT_FOUND", "Project not found.", false, 404);
  }
  if (begun.outcome === "stale") {
    throw new GenerationError(
      "VERSION_CONFLICT",
      "The project changed before regeneration started.",
      false,
      409,
    );
  }
  if (begun.outcome === "idempotency_conflict") {
    throw new GenerationError("IDEMPOTENCY_CONFLICT", "Operation key conflict.", false, 409);
  }
  if (begun.outcome === "quota_exceeded" || begun.outcome === "budget_exceeded") {
    throw new GenerationError(
      begun.outcome === "quota_exceeded" ? "QUOTA_EXCEEDED" : "BUDGET_EXCEEDED",
      "Regeneration is not currently available for this account.",
      false,
      429,
    );
  }
  if (begun.outcome !== "accepted" || !UUID_PATTERN.test(begun.candidateJobId)) {
    throw regenerationUnavailable();
  }
  input.onCandidateJob?.(begun.candidateJobId);

  const candidate: RegenerationCandidate = {
    candidateJobId: begun.candidateJobId,
    projectId: input.projectId,
    projectRevision: input.projectRevision,
    document: parseCarouselDocument(
      await input.generate({
        document: structuredClone(input.document),
        options: input.options,
      }),
    ),
  };
  await input.store.complete({ candidate });
  return candidate;
}

export async function confirmRegenerationCandidate(input: {
  readonly ownerId: string;
  readonly projectId: string;
  readonly candidateJobId: string;
  readonly expectedRevision: number;
  readonly mode: RegenerationMode;
  readonly confirmed: boolean;
  readonly idempotencyKey: string;
  readonly hashSecret: string;
  readonly store: RegenerationStore;
}) {
  requireRegenerationWrite(input.projectId, input.idempotencyKey);
  if (!input.confirmed) {
    throw new GenerationError(
      "CONFIRMATION_REQUIRED",
      "Confirm before replacing the project or saving a copy.",
      false,
      400,
    );
  }
  if (
    !UUID_PATTERN.test(input.candidateJobId) ||
    !Number.isSafeInteger(input.expectedRevision) ||
    input.expectedRevision < 1 ||
    (input.mode !== "replace" && input.mode !== "save_copy")
  ) {
    throw new GenerationError(
      "INVALID_REQUEST",
      "Regeneration confirmation is invalid.",
      false,
      400,
    );
  }
  const result = await input.store.confirm({
    ownerId: input.ownerId,
    projectId: input.projectId,
    candidateJobId: input.candidateJobId,
    expectedRevision: input.expectedRevision,
    mode: input.mode,
    idempotencyKey: input.idempotencyKey,
    requestHash: regenerationHash(input.hashSecret, {
      projectId: input.projectId,
      candidateJobId: input.candidateJobId,
      expectedRevision: input.expectedRevision,
      mode: input.mode,
    }),
  });
  if (result.outcome === "confirmed" || result.outcome === "replay") {
    if (
      !UUID_PATTERN.test(result.projectId) ||
      !Number.isSafeInteger(result.revision) ||
      result.revision < 1 ||
      (input.mode === "replace" && result.projectId !== input.projectId)
    ) {
      throw regenerationUnavailable();
    }
    return { projectId: result.projectId, revision: result.revision };
  }
  if (result.outcome === "not_found") {
    throw new GenerationError("NOT_FOUND", "Regeneration candidate not found.", false, 404);
  }
  if (result.outcome === "idempotency_conflict") {
    throw new GenerationError("IDEMPOTENCY_CONFLICT", "Operation key conflict.", false, 409);
  }
  if (result.outcome === "stale") {
    throw new GenerationError(
      "VERSION_CONFLICT",
      "The project changed. Review the current draft before confirming regeneration.",
      false,
      409,
    );
  }
  throw regenerationUnavailable();
}

export function generationErrorResponse(error: unknown, requestId: string): Response {
  const failure = error instanceof GenerationError ? error : regenerationUnavailable();
  return Response.json(
    {
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      requestId,
    },
    { status: failure.status, headers: { "Cache-Control": "private, no-store" } },
  );
}
