import { task } from "@trigger.dev/sdk";
import type { JobDispatchPayload } from "../server/jobs";
import { JOB_DISPATCH_TASK_ID } from "./dispatch";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateJobDispatchPayload(payload: unknown): JobDispatchPayload {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new Error("Invalid job dispatch payload");
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
    throw new Error("Invalid job dispatch payload");
  }
  return {
    jobId: value.jobId,
    schemaVersion: 1,
    requestId: value.requestId,
  };
}

export const jobDispatchTask = task({
  id: JOB_DISPATCH_TASK_ID,
  maxDuration: 60,
  run: async (payload: unknown) => {
    const accepted = validateJobDispatchPayload(payload);
    return { jobId: accepted.jobId, accepted: true as const };
  },
});
