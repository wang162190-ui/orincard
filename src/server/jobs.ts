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

// The dispatch payload carries no kind, so recovery has to resolve the owning task
// from the job record itself. Injecting the resolver keeps heavy task modules out of
// the callers' bundles.
export type TriggerDispatcherResolver = (kind: string) => TriggerDispatcher;

export interface TriggerRunController {
  cancel(runId: string): Promise<void>;
  retrieve(
    runId: string,
  ): Promise<{ readonly failed: boolean; readonly completed: boolean }>;
}

export const triggerRunController: TriggerRunController = {
  async cancel(runId) {
    const { runs } = await import("@trigger.dev/sdk");
    await runs.cancel(runId);
  },
  async retrieve(runId) {
    const { runs } = await import("@trigger.dev/sdk");
    const run = await runs.retrieve(runId);
    return { failed: run.isFailed, completed: run.isCompleted };
  },
};

export class JobServiceError extends Error {
  readonly code: "INVALID_REQUEST" | "NOT_FOUND" | "SERVICE_UNAVAILABLE";
  readonly httpStatus: number;
  readonly retryable: boolean;

  constructor(
    code: "INVALID_REQUEST" | "NOT_FOUND" | "SERVICE_UNAVAILABLE",
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

function invalidRequest(message: string): JobServiceError {
  return new JobServiceError("INVALID_REQUEST", message, 400, false);
}

function isTerminal(state: JobState): boolean {
  return ["succeeded", "partial", "failed", "canceled"].includes(state);
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
    `${jobId}:${job.attempt}`,
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

export async function requestOwnedJobCancellation(
  store: JobStore,
  runs: TriggerRunController,
  ownerId: string,
  jobId: string,
): Promise<JobStatus> {
  const current = await store.findOwned(ownerId, jobId);
  if (!current) {
    throw notFound();
  }
  if (isTerminal(current.state)) {
    return toJobStatus(current);
  }

  const persisted = await store.requestCancellation(ownerId, jobId);
  if (!persisted) {
    const latest = await store.findOwned(ownerId, jobId);
    if (!latest) {
      throw notFound();
    }
    return toJobStatus(latest);
  }

  if (persisted.providerRunId) {
    try {
      await runs.cancel(persisted.providerRunId);
    } catch {
      // The durable cancel flag is authoritative; reconciliation retries the provider call.
    }
  }
  return toJobStatus(persisted);
}

async function dispatchClaimedRetry(
  store: JobStore,
  resolve: TriggerDispatcherResolver,
  job: JobRecord,
  requestId: string,
): Promise<JobRecord> {
  const trigger = resolve(job.kind);
  if (!job.providerRunId) {
    return dispatchPendingJob(store, trigger, job.id, requestId);
  }
  const handle = await trigger.trigger(
    { jobId: job.id, schemaVersion: 1, requestId },
    `${job.id}:${job.attempt}`,
  );
  const queued = await store.markQueued(job.id, job.providerRunId, handle.id);
  if (queued) {
    return queued;
  }
  const current = await store.findById(job.id);
  if (!current) {
    throw notFound();
  }
  return current;
}

export async function retryOwnedJob(
  store: JobStore,
  runs: TriggerRunController,
  resolve: TriggerDispatcherResolver,
  ownerId: string,
  jobId: string,
  requestId: string,
): Promise<JobStatus> {
  const job = await store.findOwned(ownerId, jobId);
  if (!job) {
    throw notFound();
  }
  if (isTerminal(job.state)) {
    throw invalidRequest("A terminal job cannot be retried by this operation.");
  }
  if (job.cancelRequestedAt) {
    throw invalidRequest("A canceled job cannot be retried.");
  }
  if (job.state === "pending_dispatch") {
    return toJobStatus(await dispatchClaimedRetry(store, resolve, job, requestId));
  }
  if (!job.providerRunId) {
    throw invalidRequest("The job has no provider run to reconcile.");
  }
  if (job.attempt >= 3) {
    throw invalidRequest("The job has reached its retry limit.");
  }

  const provider = await runs.retrieve(job.providerRunId);
  if (!provider.failed) {
    throw invalidRequest("The provider run is not retryable.");
  }

  const claimed = await store.claimRetry(ownerId, jobId, job.providerRunId);
  if (!claimed) {
    const latest = await store.findOwned(ownerId, jobId);
    if (!latest) {
      throw notFound();
    }
    if (latest.state !== "pending_dispatch") {
      return toJobStatus(latest);
    }
    return toJobStatus(
      await dispatchClaimedRetry(store, resolve, latest, requestId),
    );
  }
  return toJobStatus(
    await dispatchClaimedRetry(store, resolve, claimed, requestId),
  );
}

export interface ReconciliationSummary {
  readonly checked: number;
  readonly dispatched: number;
  readonly retried: number;
  readonly cancelRequested: number;
}

export async function reconcileJobs(
  store: JobStore,
  runs: TriggerRunController,
  resolve: TriggerDispatcherResolver,
  before: string,
): Promise<ReconciliationSummary> {
  const candidates = await store.listReconciliationCandidates(before, 50);
  const summary = {
    checked: candidates.length,
    dispatched: 0,
    retried: 0,
    cancelRequested: 0,
  };

  for (const job of candidates) {
    if (job.cancelRequestedAt) {
      if (job.providerRunId) {
        try {
          await runs.cancel(job.providerRunId);
        } catch {
          // A later reconciliation pass keeps trying while the durable flag remains set.
        }
      }
      summary.cancelRequested += 1;
      continue;
    }

    try {
      if (job.state === "pending_dispatch" && !job.providerRunId) {
        await dispatchPendingJob(store, resolve(job.kind), job.id, crypto.randomUUID());
        summary.dispatched += 1;
        continue;
      }
      if (job.providerRunId) {
        await retryOwnedJob(
          store,
          runs,
          resolve,
          job.ownerId,
          job.id,
          crypto.randomUUID(),
        );
        summary.retried += 1;
      }
    } catch {
      // Active, terminal, unknown, or temporarily unreachable runs stay recoverable.
    }
  }
  return summary;
}

export function isJobServiceError(error: unknown): error is JobServiceError {
  return error instanceof JobServiceError;
}
