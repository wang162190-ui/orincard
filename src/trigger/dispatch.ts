import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type { JobDispatchPayload, TriggerDispatcher } from "../server/jobs";

export const JOB_DISPATCH_TASK_ID = "orincard-job-dispatch";

export const triggerDispatcher: TriggerDispatcher = {
  async trigger(payload: JobDispatchPayload, key: string) {
    const idempotencyKey = await idempotencyKeys.create(key, { scope: "global" });
    return tasks.trigger(JOB_DISPATCH_TASK_ID, payload, { idempotencyKey });
  },
};
