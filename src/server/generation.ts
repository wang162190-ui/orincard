import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MAX_SLIDE_COUNT,
  MIN_SLIDE_COUNT,
  parseCarouselDocument,
  type CarouselDocument,
  type Platform,
} from "../domain/document";
import { themes, type ThemeId } from "../render/templates";
import { AIServiceError, type StructuredAI } from "./ai";
import { buildGenerationPrompt, buildSchemaRepairPrompt } from "./prompts";
import type { SourceRecord } from "./sources";

export interface GenerationOptions {
  readonly language: string;
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
    readonly code: "INVALID_REQUEST" | "PROVIDER_FAILED",
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GenerationError";
  }
}

function validateOptions(options: GenerationOptions): void {
  if (
    !Number.isInteger(options.pageCount) ||
    options.pageCount < MIN_SLIDE_COUNT ||
    options.pageCount > MAX_SLIDE_COUNT ||
    !options.language.trim() ||
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
}): Promise<CarouselDocument> {
  validateOptions(input.options);
  const prompt = buildGenerationPrompt(input.source, input.options);
  let first: unknown;
  try {
    first = await input.ai.generateStructured({
      ...prompt,
      schemaName: "orincard_carousel",
      schema: generationJsonSchema,
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
