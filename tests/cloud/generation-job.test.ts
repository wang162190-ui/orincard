// @vitest-environment jsdom

import { describe, expect, it, vi } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseCarouselDocument, type CarouselDocument } from "../../src/domain/document";
import { createSupabaseJobStore, dispatchPendingJob, type JobRecord } from "../../src/server/jobs";
import type { GenerationOptions } from "../../src/server/generation";
import {
  GenerationJobError,
  createGenerationJobService,
  createSupabaseGenerationSubmissionStore,
  handleGenerationPost,
  type GenerationSubmissionStore,
} from "../../src/app/api/v1/generation/route";
import {
  createSupabaseGenerationWorkerStore,
  generationTriggerDispatcher,
  runGenerationJob,
  validateGenerationJobPayload,
  type GenerationWorkerStore,
} from "../../src/trigger/generate";
import { createSupabaseSourceStore, createTextSourceService } from "../../src/server/sources";
import { loadGenerationProgress } from "../../src/features/generation/progress";
import fixture from "../fixtures/base-document.json";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "22222222-2222-4222-8222-222222222222";
const NOW = new Date("2026-09-06T12:00:00.000Z");

const options: GenerationOptions = {
  language: "English",
  format: "educational",
  pageCount: 6,
  instructions: "Keep it practical.",
  templateId: "paper",
  platform: "linkedin",
};

const pendingJob: JobRecord = {
  id: JOB_ID,
  ownerId: OWNER_ID,
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
  updatedAt: NOW.toISOString(),
  finishedAt: null,
};

function submissionStore(
  overrides: Partial<GenerationSubmissionStore> = {},
): GenerationSubmissionStore {
  return {
    findOwnedSource: vi.fn().mockResolvedValue({
      id: SOURCE_ID,
      ownerId: OWNER_ID,
      state: "ready",
      expiresAt: "2026-09-13T00:00:00.000Z",
    }),
    hasActiveGeneration: vi.fn().mockResolvedValue(false),
    submit: vi.fn().mockResolvedValue(pendingJob),
    ...overrides,
  };
}

describe("T029 registered generation submission", () => {
  it("creates a durable reference-only job and dispatches only its jobId", async () => {
    const submit = vi.fn().mockResolvedValue(pendingJob);
    const dispatch = vi.fn().mockResolvedValue(undefined);
    const service = createGenerationJobService({
      store: submissionStore({ submit }),
      dispatch,
      requestHashSecret: "test-only-request-hash-secret",
      now: () => NOW,
    });

    const result = await service.submit(
      OWNER_ID,
      { sourceId: SOURCE_ID, ...options },
      "generation-operation-1",
      "request-1",
    );

    expect(result).toMatchObject({ id: JOB_ID, state: "pending_dispatch" });
    expect(submit).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER_ID,
        idempotencyKey: "generation-operation-1",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        inputRef: { sourceId: SOURCE_ID, options },
        units: 1,
        costPeriod: "2026-09",
      }),
    );
    const submitted = submit.mock.calls[0]?.[0];
    expect(JSON.stringify(submitted)).not.toContain("Build a calmer work week");
    expect(dispatch).toHaveBeenCalledWith(JOB_ID, "request-1");
  });

  it("replays the durable job ID while leaving a timed-out dispatch recoverable", async () => {
    const submit = vi.fn().mockResolvedValue(pendingJob);
    const dispatch = vi.fn().mockRejectedValue(new Error("Trigger timed out"));
    const service = createGenerationJobService({
      store: submissionStore({ submit }),
      dispatch,
      requestHashSecret: "test-only-request-hash-secret",
      now: () => NOW,
    });

    await expect(
      service.submit(
        OWNER_ID,
        { sourceId: SOURCE_ID, ...options },
        "generation-operation-1",
        "request-1",
      ),
    ).resolves.toMatchObject({ id: JOB_ID, state: "pending_dispatch" });
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("rejects missing, foreign, expired, or non-ready sources before reservation", async () => {
    for (const source of [
      null,
      {
        id: SOURCE_ID,
        ownerId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        state: "ready",
        expiresAt: "2026-09-13T00:00:00.000Z",
      },
      {
        id: SOURCE_ID,
        ownerId: OWNER_ID,
        state: "ready",
        expiresAt: "2026-09-06T11:59:59.000Z",
      },
      {
        id: SOURCE_ID,
        ownerId: OWNER_ID,
        state: "failed",
        expiresAt: "2026-09-13T00:00:00.000Z",
      },
    ]) {
      const submit = vi.fn();
      const service = createGenerationJobService({
        store: submissionStore({
          findOwnedSource: vi.fn().mockResolvedValue(source),
          submit,
        }),
        dispatch: vi.fn(),
        requestHashSecret: "test-only-request-hash-secret",
        now: () => NOW,
      });
      await expect(
        service.submit(
          OWNER_ID,
          { sourceId: SOURCE_ID, ...options },
          "generation-operation-1",
          "request-1",
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      expect(submit).not.toHaveBeenCalled();
    }
  });

  it("maps concurrency, quota, budget, and idempotency conflicts", async () => {
    const cases = [
      ["CONCURRENCY_LIMIT", submissionStore({ hasActiveGeneration: vi.fn().mockResolvedValue(true) })],
      ["QUOTA_EXCEEDED", submissionStore({ submit: vi.fn().mockRejectedValue({ code: "QUOTA_EXCEEDED" }) })],
      ["BUDGET_EXCEEDED", submissionStore({ submit: vi.fn().mockRejectedValue({ code: "BUDGET_EXCEEDED" }) })],
      ["IDEMPOTENCY_CONFLICT", submissionStore({ submit: vi.fn().mockRejectedValue({ code: "IDEMPOTENCY_CONFLICT" }) })],
    ] as const;

    for (const [code, store] of cases) {
      const service = createGenerationJobService({
        store,
        dispatch: vi.fn(),
        requestHashSecret: "test-only-request-hash-secret",
        now: () => NOW,
      });
      await expect(
        service.submit(
          OWNER_ID,
          { sourceId: SOURCE_ID, ...options },
          "generation-operation-1",
          "request-1",
        ),
      ).rejects.toMatchObject({ code });
    }
  });
});

describe("T029 generation route boundary", () => {
  function request(headers: Record<string, string> = {}) {
    return new Request("https://orincard.test/api/v1/generation", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: "https://orincard.test",
        "idempotency-key": "generation-operation-1",
        ...headers,
      },
      body: JSON.stringify({ sourceId: SOURCE_ID, ...options }),
    });
  }

  it("returns 202 with the durable job ID for an authenticated request", async () => {
    const service = { submit: vi.fn().mockResolvedValue(pendingJob) };
    const response = await handleGenerationPost(request(), {
      appOrigin: "https://orincard.test",
      authenticate: vi.fn().mockResolvedValue(OWNER_ID),
      service,
      requestId: () => "request-1",
    });

    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      data: { jobId: JOB_ID, state: "pending_dispatch" },
      requestId: "request-1",
    });
    expect(service.submit).toHaveBeenCalledWith(
      OWNER_ID,
      { sourceId: SOURCE_ID, ...options },
      "generation-operation-1",
      "request-1",
    );
  });

  it.each([
    ["foreign origin", request({ origin: "https://evil.example" }), "INVALID_REQUEST", 400],
    ["missing idempotency key", request({ "idempotency-key": "" }), "INVALID_REQUEST", 400],
  ])("rejects %s before calling the service", async (_label, input, code, status) => {
    const service = { submit: vi.fn() };
    const response = await handleGenerationPost(input, {
      appOrigin: "https://orincard.test",
      authenticate: vi.fn().mockResolvedValue(OWNER_ID),
      service,
      requestId: () => "request-1",
    });
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toMatchObject({ error: { code } });
    expect(service.submit).not.toHaveBeenCalled();
  });

  it("returns 401 without revealing source existence when authentication fails", async () => {
    const service = { submit: vi.fn() };
    const response = await handleGenerationPost(request(), {
      appOrigin: "https://orincard.test",
      authenticate: vi.fn().mockRejectedValue(new Error("expired")),
      service,
      requestId: () => "request-1",
    });
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTH_REQUIRED", retryable: false },
    });
    expect(service.submit).not.toHaveBeenCalled();
  });

  it.each([
    ["QUOTA_EXCEEDED", 429],
    ["BUDGET_EXCEEDED", 429],
    ["CONCURRENCY_LIMIT", 429],
    ["IDEMPOTENCY_CONFLICT", 409],
  ] as const)("returns %s without a false job success", async (code, status) => {
    const service = {
      submit: vi.fn().mockRejectedValue(new GenerationJobError(code, "Rejected", status, false)),
    };
    const response = await handleGenerationPost(request(), {
      appOrigin: "https://orincard.test",
      authenticate: vi.fn().mockResolvedValue(OWNER_ID),
      service,
      requestId: () => "request-1",
    });
    expect(response.status).toBe(status);
    await expect(response.json()).resolves.toEqual({
      error: { code, message: "Rejected", retryable: false },
      requestId: "request-1",
    });
  });
});

describe("T029 durable generation worker", () => {
  it("accepts only a reference-only Trigger payload", () => {
    expect(validateGenerationJobPayload({ jobId: JOB_ID, schemaVersion: 1, requestId: "request-1" })).toEqual({
      jobId: JOB_ID,
      schemaVersion: 1,
      requestId: "request-1",
    });
    expect(() => validateGenerationJobPayload({
      jobId: JOB_ID,
      schemaVersion: 1,
      requestId: "request-1",
      sourceText: "must never enter Trigger payloads",
    })).toThrow("payload");
  });

  it("settles success only after generation and never writes an existing project", async () => {
    const order: string[] = [];
    const document = structuredClone(fixture) as CarouselDocument;
    const store: GenerationWorkerStore = {
      claim: vi.fn().mockImplementation(async () => {
        order.push("claim");
        return {
          jobId: JOB_ID,
          ownerId: OWNER_ID,
          leaseToken: "33333333-3333-4333-8333-333333333333",
          source: {
            id: SOURCE_ID,
            ownerId: OWNER_ID,
            kind: "topic",
            metadata: { characterCount: 24 },
            segments: [{ segmentId: "segment-1", text: "Build a calmer work week" }],
            state: "ready",
            expiresAt: "2026-09-13T00:00:00.000Z",
          },
          options,
        };
      }),
      progress: vi.fn().mockImplementation(async () => { order.push("progress"); }),
      succeed: vi.fn().mockImplementation(async () => { order.push("succeed"); }),
      fail: vi.fn(),
    };
    const generate = vi.fn().mockImplementation(async () => {
      order.push("generate");
      return document;
    });

    await runGenerationJob(store, generate, { jobId: JOB_ID, schemaVersion: 1, requestId: "request-1" });

    expect(order.at(-1)).toBe("succeed");
    expect(order.indexOf("generate")).toBeLessThan(order.indexOf("succeed"));
    expect(store.succeed).toHaveBeenCalledWith(
      JOB_ID,
      "33333333-3333-4333-8333-333333333333",
      document,
    );
    expect(JSON.stringify(vi.mocked(store.succeed).mock.calls)).not.toContain("projectId");
    expect(store.fail).not.toHaveBeenCalled();
  });

  it("releases delivery on failure and returns no candidate document", async () => {
    const store: GenerationWorkerStore = {
      claim: vi.fn().mockResolvedValue({
        jobId: JOB_ID,
        ownerId: OWNER_ID,
        leaseToken: "33333333-3333-4333-8333-333333333333",
        source: { id: SOURCE_ID, ownerId: OWNER_ID, kind: "topic", metadata: { characterCount: 1 }, segments: [], state: "ready", expiresAt: "2026-09-13T00:00:00.000Z" },
        options,
      }),
      progress: vi.fn(),
      succeed: vi.fn(),
      fail: vi.fn(),
    };
    await expect(
      runGenerationJob(store, vi.fn().mockRejectedValue(new Error("provider failed")), {
        jobId: JOB_ID,
        schemaVersion: 1,
        requestId: "request-1",
      }),
    ).rejects.toThrow("provider failed");
    expect(store.succeed).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith(
      JOB_ID,
      "33333333-3333-4333-8333-333333333333",
      "PROVIDER_FAILED",
    );
  });
});

describe("T029 Supabase generation worker store", () => {
  const claimedRow = {
    job_id: JOB_ID,
    owner_id: OWNER_ID,
    lease_token: "33333333-3333-4333-8333-333333333333",
    source: {
      id: SOURCE_ID,
      ownerId: OWNER_ID,
      kind: "topic",
      metadata: { characterCount: 24 },
      segments: [{ segmentId: "segment-1", text: "Build a calmer work week" }],
      state: "ready",
      expiresAt: "2026-09-13T00:00:00.000Z",
    },
    options,
  };

  it("maps the set-returning claim RPC row that Supabase returns as an array", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [claimedRow], error: null });
    const work = await createSupabaseGenerationWorkerStore(
      { rpc } as unknown as SupabaseClient,
    ).claim(JOB_ID);

    expect(rpc).toHaveBeenCalledWith("server_claim_generation_job", { p_job_id: JOB_ID });
    expect(work).toMatchObject({
      jobId: JOB_ID,
      ownerId: OWNER_ID,
      leaseToken: "33333333-3333-4333-8333-333333333333",
      options,
    });
    expect(work?.source.ownerId).toBe(OWNER_ID);
    expect(work?.source.state).toBe("ready");
  });

  it("treats an empty claim result as no claimable work", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [], error: null });
    await expect(
      createSupabaseGenerationWorkerStore({ rpc } as unknown as SupabaseClient).claim(JOB_ID),
    ).resolves.toBeNull();
  });
});

describe("T029 generation progress recovery", () => {
  it("reloads safe progress by jobId without provider details", async () => {
    const fetchJob = vi.fn().mockResolvedValue({
      data: {
        id: JOB_ID,
        kind: "generation",
        state: "running",
        stage: "write",
        progress: 55,
        resultRef: null,
        errorCode: null,
        cancelRequested: false,
        updatedAt: NOW.toISOString(),
        finishedAt: null,
      },
      requestId: "request-progress",
    });
    const restored = await loadGenerationProgress(JOB_ID, fetchJob);
    expect(fetchJob).toHaveBeenCalledWith(JOB_ID);
    expect(restored).toMatchObject({ jobId: JOB_ID, state: "running", stage: "write", progress: 55 });
    expect(JSON.stringify(restored)).not.toContain("providerRunId");
  });
});

const cloud = process.env.ORINCARD_RUN_GENERATION_JOB_CLOUD === "1" ? describe : describe.skip;

cloud("T029 real Supabase and Trigger generation job", () => {
  it("submits a real source job and restores its terminal result by jobId", async () => {
    for (const name of [
      "NEXT_PUBLIC_SUPABASE_URL",
      "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY",
      "SUPABASE_SECRET_KEY",
      "ORINCARD_AUTH_TEST_EMAIL",
      "ORINCARD_AUTH_TEST_PASSWORD",
      "TRIGGER_SECRET_KEY",
    ]) {
      expect(process.env[name], `missing ${name}`).toBeTruthy();
    }
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
    const publishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!;
    const secretKey = process.env.SUPABASE_SECRET_KEY!;
    const admin = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const account = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const signedIn = await account.auth.signInWithPassword({
      email: process.env.ORINCARD_AUTH_TEST_EMAIL!,
      password: process.env.ORINCARD_AUTH_TEST_PASSWORD!,
    });
    expect(signedIn.error?.message).toBeUndefined();
    const ownerId = signedIn.data.user?.id;
    expect(ownerId).toBeTruthy();

    const periodStart = new Date();
    periodStart.setUTCDate(1);
    periodStart.setUTCHours(0, 0, 0, 0);
    const periodEnd = new Date(periodStart);
    periodEnd.setUTCMonth(periodEnd.getUTCMonth() + 1);
    const usage = await admin.from("usage_accounts").upsert({
      owner_id: ownerId!,
      period_start: periodStart.toISOString(),
      period_end: periodEnd.toISOString(),
      resource: "generation",
      granted: 20,
      reserved: 0,
      consumed: 0,
    }, { onConflict: "owner_id,period_start,resource" });
    expect(usage.error?.message).toBeUndefined();

    const runId = crypto.randomUUID();
    const source = await createTextSourceService({
      store: createSupabaseSourceStore(admin),
      requestHashSecret: secretKey,
    }).create(ownerId!, {
      kind: "topic",
      text: "Create a concise carousel about reviewing a calm work week",
    }, `cloud-source-${runId}`);
    const jobStore = createSupabaseJobStore(admin);
    const service = createGenerationJobService({
      store: createSupabaseGenerationSubmissionStore(admin),
      requestHashSecret: secretKey,
      environment: "development",
      dispatch: (jobId, requestId) =>
        dispatchPendingJob(jobStore, generationTriggerDispatcher, jobId, requestId).then(() => undefined),
    });
    const submitted = await service.submit(
      ownerId!,
      { sourceId: source.id, ...options, pageCount: 4 },
      `cloud-generation-${runId}`,
      `cloud-request-${runId}`,
    );

    let terminal: JobRecord | null = null;
    for (let attempt = 0; attempt < 180; attempt += 1) {
      terminal = await jobStore.findOwned(ownerId!, submitted.id);
      if (terminal && ["succeeded", "failed", "partial", "canceled"].includes(terminal.state)) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    expect(terminal).toMatchObject({ state: "succeeded", stage: "layout", progress: 100 });
    const generated = terminal?.resultRef && "document" in terminal.resultRef
      ? terminal.resultRef.document
      : terminal?.resultRef;
    expect(parseCarouselDocument(generated).slides).toHaveLength(4);
    expect(JSON.stringify(terminal)).not.toContain("Create a concise carousel");
    await account.auth.signOut();
  }, 300_000);
});
