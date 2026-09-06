import { describe, expect, it, vi } from "vitest";
import {
  dispatchPendingJob,
  getOwnedJobStatus,
  type JobRecord,
  type JobStore,
  type TriggerDispatcher,
} from "../../src/server/jobs";

const pendingJob: JobRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  kind: "generation",
  state: "pending_dispatch",
  stage: "validate",
  progress: 0,
  providerRunId: null,
  attempt: 0,
  heartbeatAt: null,
  resultRef: null,
  errorCode: null,
  cancelRequestedAt: null,
  updatedAt: "2026-09-06T00:00:00.000Z",
  finishedAt: null,
};

function store(initial: JobRecord): JobStore & { current: JobRecord } {
  return {
    current: initial,
    async findById(jobId) {
      return this.current.id === jobId ? this.current : null;
    },
    async findOwned(ownerId, jobId) {
      return this.current.id === jobId && this.current.ownerId === ownerId
        ? this.current
        : null;
    },
    async markQueued(jobId, expectedProviderRunId, providerRunId) {
      if (
        this.current.id !== jobId ||
        this.current.state !== "pending_dispatch" ||
        this.current.providerRunId !== expectedProviderRunId
      ) {
        return null;
      }
      this.current = {
        ...this.current,
        state: "queued",
        providerRunId,
        updatedAt: "2026-09-06T00:00:01.000Z",
      };
      return this.current;
    },
    requestCancellation: vi.fn(),
    claimRetry: vi.fn(),
    listReconciliationCandidates: vi.fn(),
  };
}

describe("T024 outbox dispatch", () => {
  it("uses the job ID as the idempotency key and persists only the run handle", async () => {
    const jobs = store(pendingJob);
    const trigger: TriggerDispatcher = {
      trigger: vi.fn().mockResolvedValue({ id: "run_same_job" }),
    };

    const first = await dispatchPendingJob(jobs, trigger, pendingJob.id, "request-1");
    const second = await dispatchPendingJob(jobs, trigger, pendingJob.id, "request-2");

    expect(trigger.trigger).toHaveBeenCalledTimes(1);
    expect(trigger.trigger).toHaveBeenCalledWith(
      {
        jobId: pendingJob.id,
        schemaVersion: 1,
        requestId: "request-1",
      },
      pendingJob.id,
    );
    expect(first.providerRunId).toBe("run_same_job");
    expect(second.providerRunId).toBe("run_same_job");
  });

  it("leaves a timed-out dispatch pending so reconciliation can recover it", async () => {
    const jobs = store(pendingJob);
    const trigger: TriggerDispatcher = {
      trigger: vi.fn().mockRejectedValue(new Error("Trigger request timed out")),
    };

    await expect(
      dispatchPendingJob(jobs, trigger, pendingJob.id, "request-timeout"),
    ).rejects.toThrow("timed out");
    expect(jobs.current.state).toBe("pending_dispatch");
    expect(jobs.current.providerRunId).toBeNull();
  });
});

describe("T024 owner-scoped status", () => {
  it("returns the safe status shape to the owner", async () => {
    const jobs = store({
      ...pendingJob,
      providerRunId: "run_internal",
      resultRef: { projectId: "safe-project-id" },
    });

    await expect(
      getOwnedJobStatus(jobs, pendingJob.ownerId, pendingJob.id),
    ).resolves.toEqual({
      id: pendingJob.id,
      kind: "generation",
      state: "pending_dispatch",
      stage: "validate",
      progress: 0,
      resultRef: { projectId: "safe-project-id" },
      errorCode: null,
      cancelRequested: false,
      updatedAt: "2026-09-06T00:00:00.000Z",
      finishedAt: null,
    });
  });

  it("uses the same not-found result for another owner and an unknown ID", async () => {
    const jobs = store(pendingJob);

    await expect(
      getOwnedJobStatus(
        jobs,
        "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        pendingJob.id,
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      getOwnedJobStatus(
        jobs,
        pendingJob.ownerId,
        "22222222-2222-4222-8222-222222222222",
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
