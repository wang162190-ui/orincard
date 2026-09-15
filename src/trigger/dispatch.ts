import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type {
  JobDispatchPayload,
  TriggerDispatcher,
  TriggerDispatcherResolver,
} from "../server/jobs";
import { createAdminSupabaseClient } from "../server/supabase";
import { VISUAL_TOOL_IDS } from "../server/tools/application";

export const JOB_DISPATCH_TASK_ID = "orincard-job-dispatch";
// The task modules import their ids from here rather than the other way around, so
// dispatching never pulls the renderer, Playwright or the AI client into a caller.
export const GENERATION_TASK_ID = "orincard-generate-carousel";
export const BASIC_EXPORT_TASK_ID = "orincard-basic-export";
export const ACCOUNT_EXPORT_TASK_ID = "orincard-account-export";
export const TEXT_TOOL_TASK_ID = "orincard-text-tool";
// T067. The visual tools render in Chromium and ffmpeg and call the image provider, so they run
// in their own task rather than the text tool worker.
export const VISUAL_TOOL_TASK_ID = "orincard-visual-tool";
// T042. The source parsers pull poppler, tesseract and ffmpeg wrappers behind them, so the
// id lives here and the API route that dispatches a parse never imports the task module.
export const PARSE_SOURCE_TASK_ID = "orincard-parse-source";
// The orchestrator only plans; it never renders or calls an image provider, so it stays out of
// the tool workers and keeps its own task.
export const AGENT_TASK_ID = "orincard-agent-plan";
export const SCREENSHOT_TASK_ID = "orincard-screenshot";
export const CLEANUP_TASK_ID = "orincard-deletion-cleanup";

function dispatcherFor(taskId: string): TriggerDispatcher {
  return {
    async trigger(payload: JobDispatchPayload, key: string) {
      const idempotencyKey = await idempotencyKeys.create(key, { scope: "global" });
      return tasks.trigger(taskId, payload, { idempotencyKey });
    },
  };
}

// Both tool workers own jobs of kind `tool`, and the recovery payload carries no tool, so a
// recovered or retried job resolves its task from the request the job already stores.
export async function resolveToolTaskId(jobId: string): Promise<string> {
  const { data } = await createAdminSupabaseClient().from("jobs").select("input_ref").eq("id", jobId).eq("kind", "tool").maybeSingle();
  const inputRef = data?.input_ref;
  const tool = inputRef && typeof inputRef === "object" && !Array.isArray(inputRef) ? (inputRef as { tool?: unknown }).tool : null;
  return VISUAL_TOOL_IDS.includes(tool as (typeof VISUAL_TOOL_IDS)[number]) ? VISUAL_TOOL_TASK_ID : TEXT_TOOL_TASK_ID;
}

const toolDispatcher: TriggerDispatcher = {
  async trigger(payload: JobDispatchPayload, key: string) {
    const idempotencyKey = await idempotencyKeys.create(key, { scope: "global" });
    return tasks.trigger(await resolveToolTaskId(payload.jobId), payload, { idempotencyKey });
  },
};

export const triggerDispatcher: TriggerDispatcher = dispatcherFor(JOB_DISPATCH_TASK_ID);
export const deletionCleanupDispatcher: TriggerDispatcher = dispatcherFor(CLEANUP_TASK_ID);
export const agentTriggerDispatcher: TriggerDispatcher = dispatcherFor(AGENT_TASK_ID);

const BY_JOB_KIND: Record<string, TriggerDispatcher> = {
  generation: dispatcherFor(GENERATION_TASK_ID),
  export: dispatcherFor(BASIC_EXPORT_TASK_ID),
  account_export: dispatcherFor(ACCOUNT_EXPORT_TASK_ID),
  tool: toolDispatcher,
  agent: agentTriggerDispatcher,
};

// orincard-job-dispatch only validates the payload and acknowledges it, so routing a
// recovered job through it would report success while the real work never restarts.
export const resolveTriggerDispatcher: TriggerDispatcherResolver = (kind) =>
  BY_JOB_KIND[kind] ?? triggerDispatcher;
