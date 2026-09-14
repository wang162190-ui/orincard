import { task } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createDeepSeekResponsesAdapter, createDeepSeekResponsesClient } from "../server/ai";
import { generateTextToolCandidate, parseTextToolRequest, selectProjectContext, type TextToolCandidate, type TextToolRequest } from "../server/tools/text-tools";
import { createMeasurementCollector, registerJobCostAttempt, settleKeyedJobUsage } from "../server/cost-settlement";
import { createAdminSupabaseClient } from "../server/supabase";
import { TEXT_TOOL_TASK_ID } from "./dispatch";

export { TEXT_TOOL_TASK_ID };
const payloadSchema = z.object({ jobId: z.string().uuid(), schemaVersion: z.literal(1), requestId: z.string().min(1).max(200) }).strict();

type ToolWork = { readonly jobId: string; readonly ownerId: string; readonly request: TextToolRequest; readonly selectedProjectContext?: Readonly<Record<string, unknown>> };

export interface TextToolWorkerStore {
  claim(jobId: string): Promise<ToolWork | null>;
  succeed(jobId: string, ownerId: string, candidate: TextToolCandidate): Promise<boolean>;
  fail(jobId: string, ownerId: string, errorCode: string): Promise<void>;
}

export function createSupabaseTextToolWorkerStore(client: SupabaseClient): TextToolWorkerStore {
  return {
    async claim(jobId) {
      const jobResult = await client.from("jobs").select("id,owner_id,project_id,input_ref,state,cancel_requested_at").eq("id", jobId).eq("kind", "tool").maybeSingle();
      if (jobResult.error || !jobResult.data || jobResult.data.cancel_requested_at || !["pending_dispatch", "queued"].includes(jobResult.data.state)) return null;
      const request = parseTextToolRequest(jobResult.data.input_ref);
      let selectedProjectContext: Readonly<Record<string, unknown>> | undefined;
      if (request.contextProjectId) {
        const project = await client.from("projects").select("document,revision").eq("id", request.contextProjectId).eq("owner_id", jobResult.data.owner_id).in("state", ["draft", "archived"]).maybeSingle();
        if (jobResult.data.project_id !== request.contextProjectId || project.error || !project.data || project.data.revision !== request.contextRevision) {
          const finishedAt = new Date().toISOString();
          await client.from("jobs").update({ state: "failed", error_code: "CONTEXT_UNAVAILABLE", finished_at: finishedAt, updated_at: finishedAt }).eq("id", jobId).eq("owner_id", jobResult.data.owner_id).eq("state", jobResult.data.state);
          return null;
        }
        selectedProjectContext = selectProjectContext(project.data.document, request.selectedContext, request.selectedSlideIds);
      } else if (jobResult.data.project_id !== null) {
        const finishedAt = new Date().toISOString();
        await client.from("jobs").update({ state: "failed", error_code: "CONTEXT_UNAVAILABLE", finished_at: finishedAt, updated_at: finishedAt }).eq("id", jobId).eq("owner_id", jobResult.data.owner_id).eq("state", jobResult.data.state);
        return null;
      }
      const now = new Date().toISOString();
      const claimed = await client.from("jobs").update({ state: "running", stage: "write", progress: 20, heartbeat_at: now, updated_at: now }).eq("id", jobId).eq("owner_id", jobResult.data.owner_id).eq("state", jobResult.data.state).is("cancel_requested_at", null).select("id").maybeSingle();
      if (claimed.error || !claimed.data) return null;
      return { jobId, ownerId: jobResult.data.owner_id, request, selectedProjectContext };
    },
    async succeed(jobId, ownerId, candidate) {
      const finishedAt = new Date().toISOString();
      const result = await client.from("jobs").update({ state: "succeeded", stage: "write", progress: 100, result_ref: { candidate }, finished_at: finishedAt, updated_at: finishedAt }).eq("id", jobId).eq("owner_id", ownerId).eq("state", "running").select("id").maybeSingle();
      return !result.error && Boolean(result.data);
    },
    async fail(jobId, ownerId, errorCode) {
      const finishedAt = new Date().toISOString();
      await client.from("jobs").update({ state: "failed", error_code: errorCode, finished_at: finishedAt, updated_at: finishedAt }).eq("id", jobId).eq("owner_id", ownerId).eq("state", "running");
    },
  };
}

export async function runTextToolJob(store: TextToolWorkerStore, generate: (work: ToolWork) => Promise<TextToolCandidate>, payload: unknown) {
  const accepted = payloadSchema.parse(payload);
  const work = await store.claim(accepted.jobId);
  if (!work) return { jobId: accepted.jobId, state: "ignored" as const };
  try {
    const candidate = await generate(work);
    if (!await store.succeed(work.jobId, work.ownerId, candidate)) throw new Error("TEXT_TOOL_WRITEBACK_LOST");
    return { jobId: work.jobId, state: "succeeded" as const };
  } catch (error) {
    await store.fail(work.jobId, work.ownerId, error instanceof Error ? error.message : "TEXT_TOOL_FAILED");
    throw error;
  }
}

export const textToolTask = task({
  id: TEXT_TOOL_TASK_ID,
  maxDuration: 300,
  run: async (payload: unknown) => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured for the text tool task");
    const ai = createDeepSeekResponsesAdapter(createDeepSeekResponsesClient(apiKey));
    const client = createAdminSupabaseClient();
    // 文本工具是五个调用点里唯一没有 SQL 侧登记尝试行的，必须自己 register，
    // 否则结算会因「cost attempt not found」失败。序号恒为 1：这条路径不递增 jobs.attempt，
    // 重跑同一个任务应当复用同一行，而不是另开一行把同一笔预留计两遍。
    const collector = createMeasurementCollector();
    return runTextToolJob(createSupabaseTextToolWorkerStore(client), async (work) => {
      await registerJobCostAttempt({ client, jobId: work.jobId, operation: "tool", sequence: 1 });
      try {
        return await generateTextToolCandidate({ ai, jobId: work.jobId, request: work.request, selectedProjectContext: work.selectedProjectContext, onMeasurement: collector.onMeasurement });
      } finally {
        // 失败也要结算：token 已经烧掉了。
        await settleKeyedJobUsage({ client, jobId: work.jobId, operation: "tool", sequence: 1, measurements: collector.collected() });
      }
    }, payload);
  },
});
