import { randomUUID } from "node:crypto";
import { chromium } from "playwright";
import { z } from "zod";
import type { AiImageProvider } from "../assets/ai-image";
import { renderMp4, type RenderedMp4, type VideoExportOptions } from "../../render/video";
import type { RenderedPage } from "../../render/render-deck";
import {
  infographicTemplate,
  quoteCardTemplate,
  TOOL_IMAGE_SIZES,
  type ToolImageDimensions,
} from "../../render/tool-templates";

export const VISUAL_TOOL_NAMES = ["quote-card", "infographic", "portrait", "carousel-to-video"] as const;
export type VisualToolName = (typeof VISUAL_TOOL_NAMES)[number];

type ImageArtifact = Readonly<{ kind: "image"; mime: "image/png"; bytes: Buffer; dimensions: ToolImageDimensions }>;
type VideoArtifact = Readonly<{ kind: "video"; mime: "video/mp4"; bytes: Buffer; width: number; height: number; durationSeconds: number; hasAudio: boolean }>;

export type VisualToolCandidate = Readonly<{
  schemaVersion: 1;
  resultId: string;
  jobId: string;
  tool: VisualToolName;
  state: "candidate";
  artifact: ImageArtifact | VideoArtifact;
  metadata: Readonly<Record<string, unknown>>;
}>;

export type ToolImageRenderer = (input: Readonly<{ html: string; width: number; height: number }>) => Promise<Buffer>;

const quoteSchema = z.object({ quote: z.string().trim().min(1).max(2_000), attribution: z.string().trim().max(200).optional(), attributionConfirmed: z.boolean() }).strict();
const infographicSchema = z.object({ content: z.string().trim().min(1).max(20_000), title: z.string().trim().min(1).max(200).default("Key ideas"), instructions: z.string().trim().max(1_000).optional() }).strict();
const portraitSchema = z.object({ prompt: z.string().trim().min(1).max(2_000), referenceAssetId: z.string().uuid() }).strict();
const videoSchema = z.object({ slideAssetIds: z.array(z.string().uuid()).min(1).max(12).optional(), secondsPerSlide: z.number().int().min(1).max(15).default(4), audioAssetId: z.string().uuid().optional() }).strict();

export async function renderToolImage(input: Readonly<{ html: string; width: number; height: number }>): Promise<Buffer> {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: input.width, height: input.height }, deviceScaleFactor: 1 });
    await page.setContent(input.html, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    return Buffer.from(await page.screenshot({ type: "png" }));
  } finally {
    await browser.close();
  }
}

function candidate(jobId: string, tool: VisualToolName, artifact: ImageArtifact | VideoArtifact, metadata: Readonly<Record<string, unknown>>, createId: () => string = () => randomUUID()): VisualToolCandidate {
  return { schemaVersion: 1, resultId: createId(), jobId, tool, state: "candidate", artifact, metadata };
}

export async function createQuoteCardCandidate(input: {
  readonly jobId: string;
  readonly request: unknown;
  readonly render?: ToolImageRenderer;
  readonly createId?: () => string;
}) {
  const request = quoteSchema.parse(input.request);
  const template = quoteCardTemplate(request);
  const bytes = await (input.render ?? renderToolImage)({ html: template.html, width: template.dimensions.width, height: template.dimensions.height });
  return candidate(input.jobId, "quote-card", { kind: "image", mime: "image/png", bytes, dimensions: template.dimensions }, {
    attribution: request.attributionConfirmed ? request.attribution ?? null : null,
    attributionConfirmed: request.attributionConfirmed,
  }, input.createId);
}

function infographicPoints(content: string): string[] {
  const points = content.split(/\n+|(?<=[.!?])\s+/).map((value) => value.replace(/^[-*•\d.)\s]+/, "").trim()).filter(Boolean).slice(0, 6);
  return points.length > 0 ? points : [content];
}

export async function createInfographicCandidate(input: {
  readonly jobId: string;
  readonly request: unknown;
  readonly render?: ToolImageRenderer;
  readonly createId?: () => string;
}) {
  const request = infographicSchema.parse(input.request);
  const points = infographicPoints(request.content);
  const template = infographicTemplate({ title: request.title, points });
  const bytes = await (input.render ?? renderToolImage)({ html: template.html, width: template.dimensions.width, height: template.dimensions.height });
  return candidate(input.jobId, "infographic", { kind: "image", mime: "image/png", bytes, dimensions: template.dimensions }, { pointCount: points.length }, input.createId);
}

export async function createPortraitCandidate(input: {
  readonly jobId: string;
  readonly request: unknown;
  readonly reference: Readonly<{ assetId: string; bytes: Uint8Array; mime: string }>;
  readonly provider: AiImageProvider;
  readonly createId?: () => string;
}) {
  const request = portraitSchema.parse(input.request);
  if (input.reference.assetId !== request.referenceAssetId || !["image/png", "image/jpeg", "image/webp"].includes(input.reference.mime)) throw new Error("PORTRAIT_REFERENCE_UNAVAILABLE");
  const generated = await input.provider.generate({ kind: "portrait", prompt: request.prompt, reference: input.reference.bytes, referenceMime: input.reference.mime });
  return candidate(input.jobId, "portrait", { kind: "image", mime: "image/png", bytes: Buffer.from(generated.bytes), dimensions: TOOL_IMAGE_SIZES["portrait-square"] }, {
    referenceAssetId: request.referenceAssetId,
    providerOperationId: generated.providerOperationId,
    providerCostUsd: generated.providerCostUsd,
    userAcceptedRequired: true,
  }, input.createId);
}

export async function createCarouselVideoCandidate(input: {
  readonly jobId: string;
  readonly request: unknown;
  readonly pages: readonly RenderedPage[];
  readonly width: number;
  readonly height: number;
  readonly audio?: Readonly<{ bytes: Buffer; extension: string }>;
  readonly render?: (value: Readonly<{ pages: readonly RenderedPage[]; width: number; height: number; options: VideoExportOptions; audio?: Readonly<{ bytes: Buffer; extension: string }> }>) => Promise<RenderedMp4>;
  readonly createId?: () => string;
}) {
  const request = videoSchema.parse(input.request);
  if (input.pages.length < 1 || input.pages.length > 12) throw new Error("VIDEO_SLIDES_UNAVAILABLE");
  if (request.slideAssetIds && (request.slideAssetIds.length !== input.pages.length || request.slideAssetIds.some((id, index) => id !== input.pages[index]?.slideId))) throw new Error("VIDEO_SLIDES_UNAVAILABLE");
  if (Boolean(input.audio) !== Boolean(request.audioAssetId)) throw new Error("VIDEO_AUDIO_UNAVAILABLE");
  const output = await (input.render ?? renderMp4)({ pages: input.pages, width: input.width, height: input.height, options: { secondsPerSlide: request.secondsPerSlide, audioAssetId: request.audioAssetId ?? null }, ...(input.audio ? { audio: input.audio } : {}) });
  return candidate(input.jobId, "carousel-to-video", { kind: "video", mime: "video/mp4", bytes: output.bytes, width: output.width, height: output.height, durationSeconds: output.durationSeconds, hasAudio: output.hasAudio }, { slideIds: input.pages.map((page) => page.slideId) }, input.createId);
}
