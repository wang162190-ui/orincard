import { describe, expect, it, vi } from "vitest";
import {
  reconcileJobs,
  requestOwnedJobCancellation,
  retryOwnedJob,
  type JobRecord,
  type JobStore,
  type TriggerDispatcher,
  type TriggerRunController,
} from "../../src/server/jobs";

const queuedJob: JobRecord = {
  id: "11111111-1111-4111-8111-111111111111",
  ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  kind: "generation",
  state: "queued",
  stage: "validate",
  progress: 0,
  providerRunId: "run_original",
  attempt: 0,
  heartbeatAt: "2026-09-06T00:00:00.000Z",
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
      this.current = { ...this.current, state: "queued", providerRunId };
      return this.current;
    },
    async requestCancellation(ownerId, jobId) {
      if (this.current.ownerId !== ownerId || this.current.id !== jobId) {
        return null;
      }
      this.current = {
        ...this.current,
        cancelRequestedAt: "2026-09-06T00:05:00.000Z",
      };
      return this.current;
    },
    async claimRetry(ownerId, jobId, expectedProviderRunId) {
      if (
        this.current.ownerId !== ownerId ||
        this.current.id !== jobId ||
        this.current.providerRunId !== expectedProviderRunId ||
        !["queued", "running"].includes(this.current.state) ||
        this.current.cancelRequestedAt !== null ||
        this.current.attempt >= 3
      ) {
        return null;
      }
      this.current = {
        ...this.current,
        state: "pending_dispatch",
        attempt: this.current.attempt + 1,
        heartbeatAt: null,
      };
      return this.current;
    },
    async listReconciliationCandidates() {
      return [this.current];
    },
  };
}

function controller(overrides: Partial<TriggerRunController> = {}): TriggerRunController {
  return {
    cancel: vi.fn().mockResolvedValue(undefined),
    retrieve: vi.fn().mockResolvedValue({ failed: false, completed: false }),
    ...overrides,
  };
}

describe("T025 job cancellation", () => {
  it("persists the cancel request before calling Trigger and keeps it on API failure", async () => {
    const jobs = store(queuedJob);
    const order: string[] = [];
    const persist = jobs.requestCancellation.bind(jobs);
    jobs.requestCancellation = async (...args) => {
      order.push("persist");
      return persist(...args);
    };
    const runs = controller({
      cancel: vi.fn().mockImplementation(async () => {
        order.push("cancel-run");
        throw new Error("Trigger unavailable");
      }),
    });

    const status = await requestOwnedJobCancellation(
      jobs,
      runs,
      queuedJob.ownerId,
      queuedJob.id,
    );

    expect(order).toEqual(["persist", "cancel-run"]);
    expect(status.cancelRequested).toBe(true);
    expect(jobs.current.cancelRequestedAt).not.toBeNull();
  });

  it("does not cancel a provider run after the database job is terminal", async () => {
    const jobs = store({
      ...queuedJob,
      state: "succeeded",
      progress: 100,
      finishedAt: "2026-09-06T00:10:00.000Z",
    });
    const runs = controller();

    const status = await requestOwnedJobCancellation(
      jobs,
      runs,
      queuedJob.ownerId,
      queuedJob.id,
    );

    expect(status.state).toBe("succeeded");
    expect(runs.cancel).not.toHaveBeenCalled();
  });
});

describe("T025 bounded retry and reconciliation", () => {
  it("checks the stale provider run before retrying and never replays active work", async () => {
    const jobs = store(queuedJob);
    const runs = controller();
    const trigger: TriggerDispatcher = { trigger: vi.fn() };

    await expect(
      retryOwnedJob(
        jobs,
        runs,
        () => trigger,
        queuedJob.ownerId,
        queuedJob.id,
        "request-active",
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(runs.retrieve).toHaveBeenCalledWith("run_original");
    expect(trigger.trigger).not.toHaveBeenCalled();
    expect(jobs.current.attempt).toBe(0);
  });

  it("claims one retry and recovers the same Trigger handle after a dispatch timeout", async () => {
    const jobs = store(queuedJob);
    const claim = vi.spyOn(jobs, "claimRetry");
    const runs = controller({
      retrieve: vi.fn().mockResolvedValue({ failed: true, completed: true }),
    });
    const trigger: TriggerDispatcher = {
      trigger: vi
        .fn()
        .mockRejectedValueOnce(new Error("response timed out"))
        .mockResolvedValueOnce({ id: "run_retried_once" }),
    };

    await expect(
      retryOwnedJob(
        jobs,
        runs,
        () => trigger,
        queuedJob.ownerId,
        queuedJob.id,
        "request-timeout",
      ),
    ).rejects.toThrow("timed out");
    await retryOwnedJob(
      jobs,
      runs,
      () => trigger,
      queuedJob.ownerId,
      queuedJob.id,
      "request-recover",
    );

    expect(claim).toHaveBeenCalledTimes(1);
    expect(trigger.trigger).toHaveBeenNthCalledWith(
      2,
      {
        jobId: queuedJob.id,
        schemaVersion: 1,
        requestId: "request-recover",
      },
      `${queuedJob.id}:1`,
    );
    expect(jobs.current.attempt).toBe(1);
    expect(jobs.current.providerRunId).toBe("run_retried_once");
  });

  it("reconciles a cancellation before inspecting or retrying a stale run", async () => {
    const jobs = store({
      ...queuedJob,
      cancelRequestedAt: "2026-09-06T00:05:00.000Z",
    });
    const runs = controller();
    const trigger: TriggerDispatcher = { trigger: vi.fn() };

    const result = await reconcileJobs(
      jobs,
      runs,
      () => trigger,
      "2026-09-06T00:10:00.000Z",
    );

    expect(result).toEqual({ checked: 1, dispatched: 0, retried: 0, cancelRequested: 1 });
    expect(runs.cancel).toHaveBeenCalledWith("run_original");
    expect(runs.retrieve).not.toHaveBeenCalled();
    expect(trigger.trigger).not.toHaveBeenCalled();
  });
});

describe("T025 job kind routing", () => {
  // The acknowledgement task only validates the payload and returns { accepted: true }.
  // Routing recovery through it looks successful while the real work never restarts.
  function dispatchers() {
    const generation: TriggerDispatcher = {
      trigger: vi.fn().mockResolvedValue({ id: "run_generation" }),
    };
    const basicExport: TriggerDispatcher = {
      trigger: vi.fn().mockResolvedValue({ id: "run_export" }),
    };
    const acknowledge: TriggerDispatcher = { trigger: vi.fn() };
    const resolve = vi.fn((kind: string) =>
      kind === "generation" ? generation : kind === "export" ? basicExport : acknowledge,
    );
    return { generation, basicExport, acknowledge, resolve };
  }

  it("re-dispatches a stalled job to the task that owns its kind", async () => {
    const jobs = store({ ...queuedJob, state: "pending_dispatch", providerRunId: null });
    const runs = controller();
    const { generation, acknowledge, resolve } = dispatchers();

    const result = await reconcileJobs(jobs, runs, resolve, "2026-09-06T00:10:00.000Z");

    expect(resolve).toHaveBeenCalledWith("generation");
    expect(generation.trigger).toHaveBeenCalledTimes(1);
    expect(acknowledge.trigger).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(1);
    expect(jobs.current.providerRunId).toBe("run_generation");
  });

  it("routes an export job to the export task rather than the generation task", async () => {
    const jobs = store({
      ...queuedJob,
      kind: "export",
      state: "pending_dispatch",
      providerRunId: null,
    });
    const runs = controller();
    const { generation, basicExport, resolve } = dispatchers();

    await reconcileJobs(jobs, runs, resolve, "2026-09-06T00:10:00.000Z");

    expect(resolve).toHaveBeenCalledWith("export");
    expect(basicExport.trigger).toHaveBeenCalledTimes(1);
    expect(generation.trigger).not.toHaveBeenCalled();
    expect(jobs.current.providerRunId).toBe("run_export");
  });

  it("retries an owned job through its own task", async () => {
    const jobs = store(queuedJob);
    const runs = controller({
      retrieve: vi.fn().mockResolvedValue({ failed: true, completed: false }),
    });
    const { generation, acknowledge, resolve } = dispatchers();

    await retryOwnedJob(jobs, runs, resolve, queuedJob.ownerId, queuedJob.id, "request-retry");

    expect(resolve).toHaveBeenCalledWith("generation");
    expect(generation.trigger).toHaveBeenCalledWith(
      { jobId: queuedJob.id, schemaVersion: 1, requestId: "request-retry" },
      `${queuedJob.id}:1`,
    );
    expect(acknowledge.trigger).not.toHaveBeenCalled();
    expect(jobs.current.providerRunId).toBe("run_generation");
  });
});
