import { z } from "zod";
import { DomainError } from "./errors";

/**
 * 发货画幅。**这是唯一真相**——校验、UI 选项、视觉矩阵都从这里派生，
 * 不要在别处再手写一份平台清单（以前有五处手写的，漂移过）。
 *
 * 加画幅要连带改 `public.platform_preset` 枚举（见
 * `supabase/migrations/20260915010000_platform_presets_square_presentation.sql`），
 * 否则 UI 能选、写库被拒。
 */
export const platformPresets = {
  linkedin: { width: 1080, height: 1350 },
  instagram: { width: 1080, height: 1350 },
  tiktok: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
  presentation: { width: 1920, height: 1080 },
} as const;

/** 发货画幅的键。UI 选项、校验、视觉矩阵都遍历它，不要另抄一份。 */
export const platformKeys = Object.keys(platformPresets) as readonly Platform[];

export function isPlatformKey(value: unknown): value is Platform {
  return typeof value === "string" && value in platformPresets;
}

export const DEFAULT_SLIDE_COUNT = 6;
export const MIN_SLIDE_COUNT = 4;
export const MAX_SLIDE_COUNT = 12;

const localOrUuidSchema = z.string().refine(
  (value) => value.startsWith("local-") || z.uuid().safeParse(value).success,
  "ID must be a UUID or use the local- prefix",
);

const sourceRefSchema = z
  .object({
    sourceId: localOrUuidSchema,
    segmentId: localOrUuidSchema,
    page: z.number().int().positive().nullable().optional(),
    timeStart: z.number().nonnegative().nullable().optional(),
    timeEnd: z.number().nonnegative().nullable().optional(),
    kind: z.enum(["quote", "paraphrase"]),
  })
  .strict()
  .superRefine((reference, context) => {
    const hasStart = typeof reference.timeStart === "number";
    const hasEnd = typeof reference.timeEnd === "number";

    if (hasStart !== hasEnd) {
      context.addIssue({
        code: "custom",
        message: "timeStart and timeEnd must be provided together",
        path: [hasStart ? "timeEnd" : "timeStart"],
      });
    }

    if (hasStart && hasEnd && reference.timeEnd! < reference.timeStart!) {
      context.addIssue({
        code: "custom",
        message: "timeEnd must not precede timeStart",
        path: ["timeEnd"],
      });
    }
  });

const emphasisRangeSchema = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().positive(),
  })
  .strict()
  .refine((range) => range.end > range.start, {
    message: "Emphasis range must not be empty",
    path: ["end"],
  });

const paragraphBlockSchema = z
  .object({
    kind: z.literal("paragraph"),
    text: z.string(),
    emphasisRanges: z.array(emphasisRangeSchema).default([]),
    sourceRefs: z.array(sourceRefSchema).optional(),
  })
  .strict()
  .superRefine((block, context) => {
    const codePointLength = Array.from(block.text).length;
    block.emphasisRanges.forEach((range, index) => {
      if (range.end > codePointLength) {
        context.addIssue({
          code: "custom",
          message: "Emphasis range exceeds text length",
          path: ["emphasisRanges", index, "end"],
        });
      }
    });
  });

const bulletBlockSchema = z
  .object({
    kind: z.literal("bullets"),
    items: z.array(z.string().min(1)).min(1),
    sourceRefs: z.array(sourceRefSchema).optional(),
  })
  .strict();

const quoteBlockSchema = z
  .object({
    kind: z.literal("quote"),
    text: z.string().min(1),
    attribution: z.string().nullable().optional(),
    sourceRefs: z.array(sourceRefSchema).min(1),
  })
  .strict();

const textBlockSchema = z.discriminatedUnion("kind", [
  paragraphBlockSchema,
  bulletBlockSchema,
  quoteBlockSchema,
]);

const cropSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    width: z.number().positive().max(1),
    height: z.number().positive().max(1),
  })
  .strict()
  .superRefine((crop, context) => {
    if (crop.x + crop.width > 1) {
      context.addIssue({
        code: "custom",
        message: "Crop exceeds the horizontal asset boundary",
        path: ["width"],
      });
    }
    if (crop.y + crop.height > 1) {
      context.addIssue({
        code: "custom",
        message: "Crop exceeds the vertical asset boundary",
        path: ["height"],
      });
    }
  });

const assetSlotSchema = z
  .object({
    slotId: z.string().min(1),
    assetId: localOrUuidSchema,
    fit: z.enum(["cover", "contain"]),
    crop: cropSchema,
    opacity: z.number().min(0).max(1),
    alt: z.string(),
  })
  .strict();

const backgroundSchema = z
  .object({
    kind: z.enum(["solid", "gradient"]),
    value: z.string().min(1),
    shape: z.string().nullable().optional(),
    texture: z.string().nullable().optional(),
    /**
     * Generative vector drawing behind the text (src/render/motifs.ts). Free-form for the same
     * reason as `texture` and `bulletIcon`: a deck saved against a motif set this build does not
     * have renders without one rather than failing validation.
     */
    motif: z.string().nullable().optional(),
    opacity: z.number().min(0).max(1),
  })
  .strict();

const themeSettingsSchema = z
  .object({
    paletteId: z.string().min(1).optional(),
    colors: z.array(z.string().min(1)).min(1).optional(),
    fontPairId: z.string().min(1),
    textScale: z.number().positive(),
    spacing: z.enum(["compact", "comfortable", "spacious"]),
    alignment: z.enum(["left", "center", "right"]),
    background: backgroundSchema,
    arrow: z.enum(["none", "line", "filled"]),
    radius: z.number().nonnegative(),
    counterStyle: z.enum(["none", "number", "fraction"]),
    /**
     * Name of a vendored icon (src/assets/generated/tabler-icons.ts) to use as the bullet marker
     * and the numbered-point mark. Optional and free-form on purpose: the renderer falls back to
     * the plain marker for a name it does not know, so a theme saved against a newer icon set
     * still renders rather than failing document validation.
     */
    bulletIcon: z.string().min(1).nullable().optional(),
  })
  .strict()
  .refine((theme) => theme.paletteId || theme.colors, {
    message: "A theme needs a paletteId or explicit colors",
  });

const brandSnapshotSchema = z
  .object({
    kitId: localOrUuidSchema,
    kitVersion: z.number().int().positive(),
    name: z.string().min(1),
    displayName: z.string().nullable(),
    website: z.url().nullable(),
    cta: z.string().nullable(),
    colors: z.array(z.string().min(1)),
    fontPairId: z.string().min(1),
    logoAssetId: localOrUuidSchema.nullable(),
    headshotAssetId: localOrUuidSchema.nullable(),
    counterDefaults: z
      .object({
        visible: z.boolean(),
        style: z.enum(["none", "number", "fraction"]),
      })
      .strict(),
  })
  .strict();

const assetReferenceSchema = z
  .object({
    id: localOrUuidSchema,
    kind: z.enum(["upload", "library", "generated", "screenshot"]),
    mimeType: z.string().min(1),
    rightsStatus: z.enum(["verified", "user_asserted", "restricted"]),
  })
  .strict();

const slideSchema = z
  .object({
    id: localOrUuidSchema,
    revision: z.number().int().positive(),
    role: z.enum(["intro", "content", "outro"]),
    mode: z.enum(["text", "text_image", "image", "screenshot"]),
    layoutId: z.string().min(1),
    eyebrow: z.string().nullable(),
    title: z.string().nullable(),
    bodyBlocks: z.array(textBlockSchema),
    cta: z.string().nullable(),
    assetSlots: z.array(assetSlotSchema),
    counterVisible: z.boolean(),
    overrides: z.record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    ),
  })
  .strict();

export const carouselDocumentSchema = z
  .object({
    schemaVersion: z.literal(1),
    title: z.string().min(1),
    // 从 platformPresets 派生，加画幅时这里不需要再改一遍。
    platform: z.enum(platformKeys as [Platform, ...Platform[]]),
    templateId: z.string().min(1),
    templateVersion: z.number().int().positive(),
    theme: themeSettingsSchema,
    brandSnapshot: brandSnapshotSchema.nullable(),
    slides: z.array(slideSchema).min(MIN_SLIDE_COUNT).max(MAX_SLIDE_COUNT),
    caption: z.string(),
    assetRefs: z.array(assetReferenceSchema),
  })
  .strict()
  .superRefine((document, context) => {
    if (document.slides[0]?.role !== "intro") {
      context.addIssue({
        code: "custom",
        message: "The first slide must use the intro role",
        path: ["slides", 0, "role"],
      });
    }

    const lastIndex = document.slides.length - 1;
    if (document.slides[lastIndex]?.role !== "outro") {
      context.addIssue({
        code: "custom",
        message: "The final slide must use the outro role",
        path: ["slides", lastIndex, "role"],
      });
    }

    const slideIds = new Set<string>();
    document.slides.forEach((slide, index) => {
      if (slideIds.has(slide.id)) {
        context.addIssue({
          code: "custom",
          message: "Slide IDs must be unique",
          path: ["slides", index, "id"],
        });
      }
      slideIds.add(slide.id);
    });

    const assetIds = new Set(document.assetRefs.map((asset) => asset.id));
    document.slides.forEach((slide, slideIndex) => {
      slide.assetSlots.forEach((slot, slotIndex) => {
        if (!assetIds.has(slot.assetId)) {
          context.addIssue({
            code: "custom",
            message: "The asset slot references an undeclared asset",
            path: ["slides", slideIndex, "assetSlots", slotIndex, "assetId"],
          });
        }
      });
    });
  });

export type CarouselDocument = z.infer<typeof carouselDocumentSchema>;
export type Platform = keyof typeof platformPresets;

export function getPlatformDimensions(platform: Platform): {
  readonly width: number;
  readonly height: number;
} {
  return platformPresets[platform];
}

export function parseCarouselDocument(input: unknown): CarouselDocument {
  if (
    typeof input === "object" &&
    input !== null &&
    "schemaVersion" in input &&
    (input as { schemaVersion?: unknown }).schemaVersion !== 1
  ) {
    throw new DomainError(
      "DOCUMENT_VERSION_UNSUPPORTED",
      "This CarouselDocument schema version is not supported.",
      { schemaVersion: (input as { schemaVersion?: unknown }).schemaVersion },
    );
  }

  const result = carouselDocumentSchema.safeParse(input);
  if (!result.success) {
    throw new DomainError("DOCUMENT_INVALID", "CarouselDocument validation failed.", {
      issues: result.error.issues,
    });
  }

  return result.data;
}
