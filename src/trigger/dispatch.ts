import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type {
  JobDispatchPayload,
  TriggerDispatcher,
  TriggerDispatcherResolver,
} from "../server/jobs";

export const JOB_DISPATCH_TASK_ID = "orincard-job-dispatch";
// The task modules import their ids from here rather than the other way around, so
// dispatching never pulls the renderer, Playwright or the AI client into a caller.
export const GENERATION_TASK_ID = "orincard-generate-carousel";
export const BASIC_EXPORT_TASK_ID = "orincard-basic-export";
// T042. The source parsers pull poppler, tesseract and ffmpeg wrappers behind them, so the
// id lives here and the API route that dispatches a parse never imports the task module.
export const PARSE_SOURCE_TASK_ID = "orincard-parse-source";
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

export const triggerDispatcher: TriggerDispatcher = dispatcherFor(JOB_DISPATCH_TASK_ID);
export const deletionCleanupDispatcher: TriggerDispatcher = dispatcherFor(CLEANUP_TASK_ID);

const BY_JOB_KIND: Record<string, TriggerDispatcher> = {
  generation: dispatcherFor(GENERATION_TASK_ID),
  export: dispatcherFor(BASIC_EXPORT_TASK_ID),
};

// orincard-job-dispatch only validates the payload and acknowledges it, so routing a
// recovered job through it would report success while the real work never restarts.
export const resolveTriggerDispatcher: TriggerDispatcherResolver = (kind) =>
  BY_JOB_KIND[kind] ?? triggerDispatcher;
