import { task } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import type { RenderedPage } from "../render/render-deck";
import { TOOL_IMAGE_SIZES } from "../render/tool-templates";
import { createApiMartImageProvider, generatedMetadata, type AiImageProvider } from "../server/assets/ai-image";
import { readServerEnvironment, type AppEnvironment } from "../server/environment";
import { createAdminSupabaseClient } from "../server/supabase";
import { parseVisualWorkerRequest, TOOL_OUTPUT_LIFETIME_MS, type VisualWorkerRequest } from "../server/tools/application";
import { persistToolOutput, type PersistToolOutputInput, type PersistedToolOutput, type ToolOutputContent } from "../server/tools/outputs";
import {
  createCarouselVideoCandidate,
  createInfographicCandidate,
  createPortraitCandidate,
  createQuoteCardCandidate,
  type ToolImageRenderer,
  type VisualToolCandidate,
} from "../server/tools/visual-tools";
import { VISUAL_TOOL_TASK_ID } from "./dispatch";

export { VISUAL_TOOL_TASK_ID };

const payloadSchema = z.object({ jobId: z.string().uuid(), schemaVersion: z.literal(1), requestId: z.string().min(1).max(200) }).strict();

// A portrait is the only visual tool that spends provider money, so it reserves image quota and
// cost before the request and settles the real cost afterwards, exactly like an AI asset candidate.
const PORTRAIT_RESERVED_MICRO_USD = 25_000;
const PORTRAIT_FALLBACK_COST_USD = 0.025;

export type VisualToolWork = { readonly jobId: string; readonly ownerId: string; readonly request: VisualWorkerRequest };
export type VisualVideoRenderer = NonNullable<Parameters<typeof createCarouselVideoCandidate>[0]["render"]>;

export interface VisualToolWorkerStore {
  claim(jobId: string): Promise<VisualToolWork | null>;
  succeed(jobId: string, ownerId: string, resultRef: Readonly<Record<string, unknown>>): Promise<boolean>;
  fail(jobId: string, ownerId: string, errorCode: string): Promise<void>;
}

export interface VisualToolAssetStore {
  loadPortraitReference(ownerId: string, assetId: string): Promise<Readonly<{ assetId: string; bytes: Uint8Array; mime: string }>>;
  loadSlideFrames(ownerId: string, assetIds: readonly string[]): Promise<Readonly<{ pages: readonly RenderedPage[]; width: number; height: number }>>;
  loadAudio(ownerId: string, assetId: string): Promise<Readonly<{ bytes: Buffer; extension: string }>>;
}

export interface PortraitBudgetGate {
  reserve(input: Readonly<{ ownerId: string; jobId: string; prompt: string; referenceAssetId: string }>): Promise<"created" | "quota_exceeded" | "budget_exceeded">;
  settle(input: Readonly<{ ownerId: string; jobId: string; succeeded: boolean; bytes?: Uint8Array; providerOperationId?: string | null; providerCostUsd?: number | null }>): Promise<void>;
}

export interface VisualToolDependencies {
  readonly store: VisualToolWorkerStore;
  readonly assets: VisualToolAssetStore;
  readonly portraitProvider: AiImageProvider;
  readonly portraitBudget: PortraitBudgetGate;
  readonly persist: (input: PersistToolOutputInput) => Promise<PersistedToolOutput>;
  readonly renderImage?: ToolImageRenderer;
  readonly renderVideo?: VisualVideoRenderer;
  readonly now?: () => Date;
}

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/ogg": "ogg",
};

export function createSupabaseVisualToolWorkerStore(client: SupabaseClient): VisualToolWorkerStore {
  return {
    async claim(jobId) {
      const jobResult = await client.from("jobs").select("id,owner_id,project_id,input_ref,state,cancel_requested_at").eq("id", jobId).eq("kind", "tool").maybeSingle();
      if (jobResult.error || !jobResult.data || jobResult.data.cancel_requested_at || !["pending_dispatch", "queued"].includes(jobResult.data.state)) return null;
      const job = jobResult.data;
      const request = parseVisualWorkerRequest(job.input_ref);
      const failContext = async () => {
        const finishedAt = new Date().toISOString();
        await client.from("jobs").update({ state: "failed", error_code: "CONTEXT_UNAVAILABLE", finished_at: finishedAt, updated_at: finishedAt }).eq("id", jobId).eq("owner_id", job.owner_id).eq("state", job.state);
        return null;
      };
      if (request.contextProjectId) {
        const project = await client.from("projects").select("id,revision").eq("id", request.contextProjectId).eq("owner_id", job.owner_id).in("state", ["draft", "archived"]).maybeSingle();
        if (job.project_id !== request.contextProjectId || project.error || !project.data || project.data.revision !== request.contextRevision) return failContext();
      } else if (job.project_id !== null) {
        return failContext();
      }
      const now = new Date().toISOString();
      const claimed = await client.from("jobs").update({ state: "running", stage: "render", progress: 20, heartbeat_at: now, updated_at: now }).eq("id", jobId).eq("owner_id", job.owner_id).eq("state", job.state).is("cancel_requested_at", null).select("id").maybeSingle();
      if (claimed.error || !claimed.data) return null;
      return { jobId, ownerId: job.owner_id, request };
    },
    async succeed(jobId, ownerId, resultRef) {
      const finishedAt = new Date().toISOString();
      const result = await client.from("jobs").update({ state: "succeeded", stage: "upload", progress: 100, result_ref: resultRef, finished_at: finishedAt, updated_at: finishedAt }).eq("id", jobId).eq("owner_id", ownerId).eq("state", "running").select("id").maybeSingle();
      return !result.error && Boolean(result.data);
    },
    async fail(jobId, ownerId, errorCode) {
      const finishedAt = new Date().toISOString();
      await client.from("jobs").update({ state: "failed", error_code: errorCode, finished_at: finishedAt, updated_at: finishedAt }).eq("id", jobId).eq("owner_id", ownerId).eq("state", "running");
    },
  };
}

export function createSupabaseVisualToolAssetStore(client: SupabaseClient): VisualToolAssetStore {
  const download = async (bucket: string, objectKey: string, code: string) => {
    const { data, error } = await client.storage.from(bucket).download(objectKey);
    if (error || !data) throw new Error(code);
    return Buffer.from(await data.arrayBuffer());
  };
  return {
    async loadPortraitReference(ownerId, assetId) {
      const { data, error } = await client.from("assets").select("id,bucket,object_key,mime,state").eq("id", assetId).eq("owner_id", ownerId).eq("state", "ready").maybeSingle();
      if (error || !data || data.bucket !== "assets" || !["image/png", "image/jpeg", "image/webp"].includes(data.mime)) throw new Error("PORTRAIT_REFERENCE_UNAVAILABLE");
      return { assetId: data.id, bytes: new Uint8Array(await download(data.bucket, data.object_key, "PORTRAIT_REFERENCE_UNAVAILABLE")), mime: data.mime };
    },
    async loadSlideFrames(ownerId, assetIds) {
      const { data, error } = await client.from("assets").select("id,kind,bucket,object_key,mime,width,height,state,accepted_at").eq("owner_id", ownerId).in("id", [...assetIds]);
      if (error || !data || data.length !== assetIds.length) throw new Error("VIDEO_SLIDES_UNAVAILABLE");
      const ordered = assetIds.map((id) => data.find((row) => row.id === id));
      const first = ordered[0];
      if (!first?.width || !first.height) throw new Error("VIDEO_SLIDES_UNAVAILABLE");
      const pages: RenderedPage[] = [];
      for (const row of ordered) {
        // A generated frame still needs the explicit user acceptance the library records.
        if (!row || row.state !== "ready" || row.mime !== "image/png" || row.width !== first.width || row.height !== first.height) throw new Error("VIDEO_SLIDES_UNAVAILABLE");
        if (["ai_image", "portrait"].includes(row.kind) && !row.accepted_at) throw new Error("VIDEO_SLIDES_UNAVAILABLE");
        pages.push({ slideId: row.id, bytes: await download(row.bucket, row.object_key, "VIDEO_SLIDES_UNAVAILABLE") });
      }
      return { pages, width: first.width, height: first.height };
    },
    async loadAudio(ownerId, assetId) {
      const { data, error } = await client.from("assets").select("id,bucket,object_key,mime,state,rights").eq("id", assetId).eq("owner_id", ownerId).eq("kind", "audio").eq("state", "ready").maybeSingle();
      const rights = data?.rights;
      const confirmed = rights && typeof rights === "object" && !Array.isArray(rights) && (
        (rights as Record<string, unknown>).exportAuthorized === true ||
        typeof (rights as Record<string, unknown>).licenseConfirmedAt === "string"
      );
      const extension = data ? AUDIO_EXTENSIONS[data.mime] : undefined;
      if (error || !data || !confirmed || !extension) throw new Error("VIDEO_AUDIO_UNAVAILABLE");
      return { bytes: await download(data.bucket, data.object_key, "VIDEO_AUDIO_UNAVAILABLE"), extension };
    },
  };
}

// The reservation is keyed by the job id, so a worker retry re-enters the same open reservation
// instead of reserving a second image credit.
export function createSupabasePortraitBudgetGate(client: SupabaseClient, environment: AppEnvironment): PortraitBudgetGate {
  const release = async (ownerId: string, jobId: string) => {
    await client.from("assets").update({ state: "failed", error_code: "PROVIDER_FAILED" }).eq("id", jobId).eq("owner_id", ownerId).eq("state", "pending_upload");
    const { error } = await client.rpc("server_finalize_ai_asset_candidate", { p_asset_id: jobId, p_owner_id: ownerId, p_succeeded: false, p_provider_operation_id: null, p_actual_micro_usd: 0 });
    if (error) throw new Error("IMAGE_BUDGET_RELEASE_FAILED");
  };
  return {
    async reserve(input) {
      const { data, error } = await client.rpc("server_create_ai_asset_candidate", {
        p_asset_id: input.jobId, p_owner_id: input.ownerId, p_kind: "portrait",
        p_object_key: `${input.ownerId}/${input.jobId}/pending.png`,
        p_rights: { provider: "apimart", model: "gpt-image-2", resolution: "1k", prompt: input.prompt, candidate: true, referenceAssetId: input.referenceAssetId, userAcceptedRequired: true, requestedAt: new Date().toISOString() },
        p_environment: environment, p_reserved_micro_usd: PORTRAIT_RESERVED_MICRO_USD,
      });
      const outcome = data && typeof data === "object" ? (data as { outcome?: unknown }).outcome : null;
      if (error || (outcome !== "created" && outcome !== "quota_exceeded" && outcome !== "budget_exceeded")) throw new Error("IMAGE_BUDGET_UNAVAILABLE");
      return outcome;
    },
    async settle(input) {
      if (!input.succeeded || !input.bytes) return release(input.ownerId, input.jobId);
      try {
        const metadata = generatedMetadata(input.bytes);
        const objectKey = `${input.ownerId}/${input.jobId}/generated.png`;
        const uploaded = await client.storage.from("assets").upload(objectKey, input.bytes, { contentType: "image/png", upsert: false });
        if (uploaded.error) throw new Error("IMAGE_CANDIDATE_UPLOAD_FAILED");
        const updated = await client.from("assets").update({ object_key: objectKey, mime: "image/png", ...metadata, state: "ready", error_code: null }).eq("id", input.jobId).eq("owner_id", input.ownerId).eq("state", "pending_upload").select("id").maybeSingle();
        if (updated.error || !updated.data) {
          await client.storage.from("assets").remove([objectKey]);
          throw new Error("IMAGE_CANDIDATE_UPLOAD_FAILED");
        }
      } catch (error) {
        await release(input.ownerId, input.jobId);
        throw error;
      }
      const { error } = await client.rpc("server_finalize_ai_asset_candidate", {
        p_asset_id: input.jobId, p_owner_id: input.ownerId, p_succeeded: true,
        p_provider_operation_id: input.providerOperationId ?? null,
        p_actual_micro_usd: Math.max(0, Math.round((input.providerCostUsd ?? PORTRAIT_FALLBACK_COST_USD) * 1_000_000)),
      });
      if (error) throw new Error("IMAGE_BUDGET_SETTLEMENT_FAILED");
    },
  };
}

async function createPortrait(dependencies: VisualToolDependencies, work: VisualToolWork): Promise<VisualToolCandidate> {
  const input = work.request.input as { readonly prompt: string; readonly referenceAssetId: string };
  const reference = await dependencies.assets.loadPortraitReference(work.ownerId, input.referenceAssetId);
  const reserved = await dependencies.portraitBudget.reserve({ ownerId: work.ownerId, jobId: work.jobId, prompt: input.prompt, referenceAssetId: input.referenceAssetId });
  if (reserved !== "created") throw new Error(reserved === "quota_exceeded" ? "IMAGE_QUOTA_EXCEEDED" : "IMAGE_BUDGET_EXCEEDED");
  let candidate: VisualToolCandidate;
  try {
    candidate = await createPortraitCandidate({ jobId: work.jobId, request: input, reference, provider: dependencies.portraitProvider });
  } catch (error) {
    await dependencies.portraitBudget.settle({ ownerId: work.ownerId, jobId: work.jobId, succeeded: false });
    throw error;
  }
  const providerOperationId = candidate.metadata.providerOperationId;
  const providerCostUsd = candidate.metadata.providerCostUsd;
  await dependencies.portraitBudget.settle({
    ownerId: work.ownerId, jobId: work.jobId, succeeded: true, bytes: candidate.artifact.bytes,
    providerOperationId: typeof providerOperationId === "string" ? providerOperationId : null,
    providerCostUsd: typeof providerCostUsd === "number" ? providerCostUsd : null,
  });
  return candidate;
}

async function createVideo(dependencies: VisualToolDependencies, work: VisualToolWork): Promise<VisualToolCandidate> {
  const input = work.request.input as { readonly slideAssetIds: readonly string[]; readonly audioAssetId?: string };
  const frames = await dependencies.assets.loadSlideFrames(work.ownerId, input.slideAssetIds);
  const audio = input.audioAssetId ? await dependencies.assets.loadAudio(work.ownerId, input.audioAssetId) : undefined;
  return createCarouselVideoCandidate({
    jobId: work.jobId, request: input, pages: frames.pages, width: frames.width, height: frames.height,
    ...(audio ? { audio } : {}), ...(dependencies.renderVideo ? { render: dependencies.renderVideo } : {}),
  });
}

export async function createVisualToolCandidate(dependencies: VisualToolDependencies, work: VisualToolWork): Promise<VisualToolCandidate> {
  const render = dependencies.renderImage;
  if (work.request.tool === "quote-card") return createQuoteCardCandidate({ jobId: work.jobId, request: work.request.input, ...(render ? { render } : {}) });
  if (work.request.tool === "infographic") return createInfographicCandidate({ jobId: work.jobId, request: work.request.input, ...(render ? { render } : {}) });
  if (work.request.tool === "portrait") return createPortrait(dependencies, work);
  return createVideo(dependencies, work);
}

function outputContent(candidate: VisualToolCandidate): ToolOutputContent {
  const artifact = candidate.artifact;
  if (artifact.kind === "image") {
    const dimensions = candidate.tool === "portrait" ? TOOL_IMAGE_SIZES["portrait-square"] : artifact.dimensions;
    return { kind: "image", bytes: artifact.bytes, mime: artifact.mime, width: dimensions.width, height: dimensions.height };
  }
  return { kind: "video", bytes: artifact.bytes, mime: artifact.mime, durationSeconds: artifact.durationSeconds };
}

export async function runVisualToolJob(dependencies: VisualToolDependencies, payload: unknown) {
  const accepted = payloadSchema.parse(payload);
  const work = await dependencies.store.claim(accepted.jobId);
  if (!work) return { jobId: accepted.jobId, state: "ignored" as const };
  const context = work.request.contextProjectId && work.request.contextRevision
    ? { contextProjectId: work.request.contextProjectId, contextRevision: work.request.contextRevision }
    : {};
  try {
    const candidate = await createVisualToolCandidate(dependencies, work);
    const now = (dependencies.now ?? (() => new Date()))();
    const output = await dependencies.persist({
      ownerId: work.ownerId, jobId: work.jobId, tool: candidate.tool, content: outputContent(candidate),
      ...context, expiresAt: new Date(now.getTime() + TOOL_OUTPUT_LIFETIME_MS),
    });
    // The stored reference carries the candidate result only: never the submitted text or bytes.
    const resultRef = { tool: candidate.tool, state: "candidate" as const, outputId: output.id, result: output.result, expiresAt: output.expiresAt, ...context };
    if (!await dependencies.store.succeed(work.jobId, work.ownerId, resultRef)) throw new Error("VISUAL_TOOL_WRITEBACK_LOST");
    return { jobId: work.jobId, state: "succeeded" as const };
  } catch (error) {
    const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : "VISUAL_TOOL_FAILED";
    await dependencies.store.fail(work.jobId, work.ownerId, code);
    throw error;
  }
}

export const visualToolTask = task({
  id: VISUAL_TOOL_TASK_ID,
  maxDuration: 600,
  run: async (payload: unknown) => {
    const apiKey = process.env.APIMART_API_KEY?.trim();
    if (!apiKey) throw new Error("APIMART_API_KEY is not configured for the visual tool task");
    const client = createAdminSupabaseClient();
    return runVisualToolJob({
      store: createSupabaseVisualToolWorkerStore(client),
      assets: createSupabaseVisualToolAssetStore(client),
      portraitProvider: createApiMartImageProvider(apiKey),
      portraitBudget: createSupabasePortraitBudgetGate(client, readServerEnvironment(process.env).appEnvironment),
      persist: (input) => persistToolOutput(client, input),
    }, payload);
  },
});
