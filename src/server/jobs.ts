import type { SupabaseClient } from "@supabase/supabase-js";

export const jobStates = [
  "pending_dispatch",
  "queued",
  "running",
  "succeeded",
  "partial",
  "failed",
  "canceled",
] as const;

export type JobState = (typeof jobStates)[number];

export interface JobRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: string;
  readonly state: JobState;
  readonly stage: string;
  readonly progress: number;
  readonly providerRunId: string | null;
  readonly attempt: number;
  readonly heartbeatAt: string | null;
  readonly resultRef: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly cancelRequestedAt: string | null;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface JobStatus {
  readonly id: string;
  readonly kind: string;
  readonly state: JobState;
  readonly stage: string;
  readonly progress: number;
  readonly resultRef: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
  readonly cancelRequested: boolean;
  readonly updatedAt: string;
  readonly finishedAt: string | null;
}

export interface JobStore {
  findById(jobId: string): Promise<JobRecord | null>;
  findOwned(ownerId: string, jobId: string): Promise<JobRecord | null>;
  markQueued(
    jobId: string,
    expectedProviderRunId: string | null,
    providerRunId: string,
  ): Promise<JobRecord | null>;
  requestCancellation(ownerId: string, jobId: string): Promise<JobRecord | null>;
  claimRetry(
    ownerId: string,
    jobId: string,
    expectedProviderRunId: string,
  ): Promise<JobRecord | null>;
  listReconciliationCandidates(before: string, limit: number): Promise<JobRecord[]>;
}

export interface JobDispatchPayload {
  readonly jobId: string;
  readonly schemaVersion: 1;
  readonly requestId: string;
}

export interface TriggerDispatcher {
  trigger(
    payload: JobDispatchPayload,
    idempotencyKey: string,
  ): Promise<{ readonly id: string }>;
}

export class JobServiceError extends Error {
  readonly code: "NOT_FOUND" | "SERVICE_UNAVAILABLE";
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    code: "NOT_FOUND" | "SERVICE_UNAVAILABLE",
    message: string,
    httpStatus: number,
    retryable: boolean,
  ) {
    super(message);
    this.name = "JobServiceError";
    this.code = code;
    this.httpStatus = httpStatus;
    this.retryable = retryable;
  }
}

type JobRow = {
  id: string;
  owner_id: string;
  kind: string;
  state: JobState;
  stage: string;
  progress: number;
  provider_run_id: string | null;
  attempt: number;
  heartbeat_at: string | null;
  result_ref: Readonly<Record<string, unknown>> | null;
  error_code: string | null;
  cancel_requested_at: string | null;
  updated_at: string;
  finished_at: string | null;
};

const JOB_COLUMNS = [
  "id",
  "owner_id",
  "kind",
  "state",
  "stage",
  "progress",
  "provider_run_id",
  "attempt",
  "heartbeat_at",
  "result_ref",
  "error_code",
  "cancel_requested_at",
  "updated_at",
  "finished_at",
].join(",");

function record(row: JobRow): JobRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    state: row.state,
    stage: row.stage,
    progress: row.progress,
    providerRunId: row.provider_run_id,
    attempt: row.attempt,
    heartbeatAt: row.heartbeat_at,
    resultRef: row.result_ref,
    errorCode: row.error_code,
    cancelRequestedAt: row.cancel_requested_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function rpcRecord(data: unknown): JobRecord | null {
  const row = Array.isArray(data) ? data[0] : data;
  return row ? record(row as JobRow) : null;
}

function databaseError(error: { readonly message: string } | null): void {
  if (error) {
    throw new JobServiceError(
      "SERVICE_UNAVAILABLE",
      "Job service is temporarily unavailable.",
      503,
      true,
    );
  }
}

export function createSupabaseJobStore(client: SupabaseClient): JobStore {
  return {
    async findById(jobId) {
      const { data, error } = await client
        .from("jobs")
        .select(JOB_COLUMNS)
        .eq("id", jobId)
        .maybeSingle();
      databaseError(error);
      return data ? record(data as unknown as JobRow) : null;
    },

    async findOwned(ownerId, jobId) {
      const { data, error } = await client
        .from("jobs")
        .select(JOB_COLUMNS)
        .eq("id", jobId)
        .eq("owner_id", ownerId)
        .maybeSingle();
      databaseError(error);
      return data ? record(data as unknown as JobRow) : null;
    },

    async markQueued(jobId, expectedProviderRunId, providerRunId) {
      const { data, error } = await client.rpc("server_mark_job_dispatched", {
        p_expected_provider_run_id: expectedProviderRunId,
        p_job_id: jobId,
        p_provider_run_id: providerRunId,
      });
      databaseError(error);
      return rpcRecord(data);
    },

    async requestCancellation(ownerId, jobId) {
      const { data, error } = await client.rpc("server_request_job_cancellation", {
        p_job_id: jobId,
        p_owner_id: ownerId,
      });
      databaseError(error);
      return rpcRecord(data);
    },

    async claimRetry(ownerId, jobId, expectedProviderRunId) {
      const { data, error } = await client.rpc("server_claim_job_retry", {
        p_expected_provider_run_id: expectedProviderRunId,
        p_job_id: jobId,
        p_owner_id: ownerId,
      });
      databaseError(error);
      return rpcRecord(data);
    },

    async listReconciliationCandidates(before, limit) {
      const { data, error } = await client
        .from("jobs")
        .select(JOB_COLUMNS)
        .in("state", ["pending_dispatch", "queued", "running"])
        .lte("updated_at", before)
        .order("updated_at", { ascending: true })
        .limit(limit);
      databaseError(error);
      return (data ?? []).map((row) => record(row as unknown as JobRow));
    },
  };
}

function notFound(): JobServiceError {
  return new JobServiceError("NOT_FOUND", "Job not found.", 404, false);
}

export function toJobStatus(job: JobRecord): JobStatus {
  return {
    id: job.id,
    kind: job.kind,
    state: job.state,
    stage: job.stage,
    progress: job.progress,
    resultRef: job.resultRef,
    errorCode: job.errorCode,
    cancelRequested: job.cancelRequestedAt !== null,
    updatedAt: job.updatedAt,
    finishedAt: job.finishedAt,
  };
}

export async function getOwnedJobStatus(
  store: JobStore,
  ownerId: string,
  jobId: string,
): Promise<JobStatus> {
  const job = await store.findOwned(ownerId, jobId);
  if (!job) {
    throw notFound();
  }
  return toJobStatus(job);
}

export async function dispatchPendingJob(
  store: JobStore,
  trigger: TriggerDispatcher,
  jobId: string,
  requestId: string,
): Promise<JobRecord> {
  const job = await store.findById(jobId);
  if (!job) {
    throw notFound();
  }
  if (
    job.state !== "pending_dispatch" ||
    job.providerRunId !== null ||
    job.cancelRequestedAt !== null
  ) {
    return job;
  }

  const handle = await trigger.trigger(
    { jobId, schemaVersion: 1, requestId },
    jobId,
  );
  const queued = await store.markQueued(jobId, null, handle.id);
  if (queued) {
    return queued;
  }

  const current = await store.findById(jobId);
  if (!current) {
    throw notFound();
  }
  return current;
}

export function isJobServiceError(error: unknown): error is JobServiceError {
  return error instanceof JobServiceError;
}
