import { idempotencyKeys, task, tasks } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { CarouselDocument } from "../domain/document";
import {
  createDeepSeekResponsesAdapter,
  createDeepSeekResponsesClient,
} from "../server/ai";
import {
  generateCarouselDocument,
  type GenerationOptions,
} from "../server/generation";
import type { JobDispatchPayload, TriggerDispatcher } from "../server/jobs";
import type { SourceRecord } from "../server/sources";
import { createAdminSupabaseClient } from "../server/supabase";
import { GENERATION_TASK_ID } from "./dispatch";

export { GENERATION_TASK_ID };
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export interface GenerationWork {
  readonly jobId: string;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly source: SourceRecord;
  readonly options: GenerationOptions;
}

export interface GenerationWorkerStore {
  claim(jobId: string): Promise<GenerationWork | null>;
  progress(jobId: string, leaseToken: string, stage: "outline" | "write" | "layout", progress: number): Promise<void>;
  succeed(jobId: string, leaseToken: string, document: CarouselDocument): Promise<void>;
  fail(jobId: string, leaseToken: string, errorCode: "PROVIDER_FAILED" | "SOURCE_UNAVAILABLE"): Promise<void>;
}

export function validateGenerationJobPayload(payload: unknown): JobDispatchPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Invalid generation job payload");
  }
  const value = payload as Record<string, unknown>;
  if (
    Object.keys(value).sort().join(",") !== "jobId,requestId,schemaVersion" ||
    typeof value.jobId !== "string" ||
    !UUID_PATTERN.test(value.jobId) ||
    value.schemaVersion !== 1 ||
    typeof value.requestId !== "string" ||
    value.requestId.length < 1 ||
    value.requestId.length > 200
  ) {
    throw new Error("Invalid generation job payload");
  }
  return { jobId: value.jobId, schemaVersion: 1, requestId: value.requestId };
}

function rpcFailure(error: unknown): never {
  throw error instanceof Error ? error : new Error("Generation worker transaction failed");
}

export function createSupabaseGenerationWorkerStore(
  client: SupabaseClient,
): GenerationWorkerStore {
  return {
    async claim(jobId) {
      const { data, error } = await client.rpc("server_claim_generation_job", {
        p_job_id: jobId,
      });
      if (error) rpcFailure(error);
      // server_claim_generation_job is set-returning, so supabase-js yields a row array.
      const row = Array.isArray(data) ? data[0] : data;
      if (!row) return null;
      const value = row as unknown as {
        job_id: string;
        owner_id: string;
        lease_token: string;
        source: SourceRecord;
        options: GenerationOptions;
      };
      return {
        jobId: value.job_id,
        ownerId: value.owner_id,
        leaseToken: value.lease_token,
        source: value.source,
        options: value.options,
      };
    },
    async progress(jobId, leaseToken, stage, progress) {
      const { error } = await client.rpc("server_update_generation_progress", {
        p_job_id: jobId,
        p_lease_token: leaseToken,
        p_stage: stage,
        p_progress: progress,
      });
      if (error) rpcFailure(error);
    },
    async succeed(jobId, leaseToken, document) {
      const { error } = await client.rpc("server_finalize_generation_job", {
        p_job_id: jobId,
        p_lease_token: leaseToken,
        p_document: document,
        p_error_code: null,
      });
      if (error) rpcFailure(error);
    },
    async fail(jobId, leaseToken, errorCode) {
      const { error } = await client.rpc("server_finalize_generation_job", {
        p_job_id: jobId,
        p_lease_token: leaseToken,
        p_document: null,
        p_error_code: errorCode,
      });
      if (error) rpcFailure(error);
    },
  };
}

export async function runGenerationJob(
  store: GenerationWorkerStore,
  generate: (source: SourceRecord, options: GenerationOptions) => Promise<CarouselDocument>,
  payload: unknown,
): Promise<{ readonly jobId: string; readonly state: "ignored" | "succeeded" }> {
  const accepted = validateGenerationJobPayload(payload);
  const work = await store.claim(accepted.jobId);
  if (!work) return { jobId: accepted.jobId, state: "ignored" };
  if (
    work.jobId !== accepted.jobId ||
    work.source.ownerId !== work.ownerId ||
    work.source.state !== "ready" ||
    new Date(work.source.expiresAt).getTime() <= Date.now()
  ) {
    await store.fail(work.jobId, work.leaseToken, "SOURCE_UNAVAILABLE");
    throw new Error("Generation source is no longer available");
  }
  try {
    await store.progress(work.jobId, work.leaseToken, "outline", 20);
    const document = await generate(work.source, work.options);
    await store.progress(work.jobId, work.leaseToken, "layout", 90);
    await store.succeed(work.jobId, work.leaseToken, document);
    return { jobId: work.jobId, state: "succeeded" };
  } catch (error) {
    await store.fail(work.jobId, work.leaseToken, "PROVIDER_FAILED");
    throw error;
  }
}

export const generationTriggerDispatcher: TriggerDispatcher = {
  async trigger(payload, key) {
    const idempotencyKey = await idempotencyKeys.create(key, { scope: "global" });
    return tasks.trigger(GENERATION_TASK_ID, payload, { idempotencyKey });
  },
};

export const generateCarouselTask = task({
  id: GENERATION_TASK_ID,
  maxDuration: 300,
  run: async (payload: unknown) => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured for the generation task");
    const store = createSupabaseGenerationWorkerStore(createAdminSupabaseClient());
    const ai = createDeepSeekResponsesAdapter(createDeepSeekResponsesClient(apiKey));
    return runGenerationJob(
      store,
      (source, options) => generateCarouselDocument({ ai, source, options }),
      payload,
    );
  },
});
