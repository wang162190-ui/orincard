import { describe, expect, it, vi } from "vitest";
import {
  AgentJobError,
  createAgentJobService,
  handleAgentPost,
  parseAgentBody,
  type AgentSubmissionStore,
} from "../../src/app/api/v1/agent/route";

const JOB = {
  id: "7c2f1a6e-0000-4000-8000-000000000001",
  ownerId: "11111111-1111-4111-8111-111111111111",
  kind: "agent",
  state: "pending_dispatch" as const,
  stage: "queued",
  progress: 0,
  providerRunId: null,
  attempt: 0,
  heartbeatAt: null,
  resultRef: null,
  errorCode: null,
  cancelRequestedAt: null,
  updatedAt: "2026-09-15T12:00:00.000Z",
  finishedAt: null,
};

function harness(overrides: Partial<AgentSubmissionStore> = {}) {
  const calls: string[] = [];
  const store: AgentSubmissionStore = {
    submit: vi.fn(async () => {
      calls.push("submit");
      return JOB;
    }),
    createRun: vi.fn(async () => {
      calls.push("createRun");
    }),
    findRun: vi.fn(async () => null),
    ...overrides,
  };
  const dispatch = vi.fn(async () => {
    calls.push("dispatch");
  });
  const ensureEntitlements = vi.fn(async () => {
    calls.push("ensureEntitlements");
  });
  const service = createAgentJobService({
    store,
    dispatch,
    ensureEntitlements,
    requestHashSecret: "test-secret",
    environment: "development",
    now: () => new Date("2026-09-15T12:00:00Z"),
  });
  return { service, store, dispatch, ensureEntitlements, calls };
}

const KEY = "idem-key-0001";
const BODY = { request: "Write a caption and three follow-up ideas." };

describe("agent request body", () => {
  it("rejects a blank request", () => {
    expect(() => parseAgentBody({ request: "   " })).toThrow(AgentJobError);
  });

  // 上界与 public.agent_runs.request 的检查约束同值；在路由挡住比让数据库抛 23514 更可读。
  it("rejects a request longer than the column allows", () => {
    expect(() => parseAgentBody({ request: "a".repeat(2_001) })).toThrow(AgentJobError);
  });

  it("keeps an optional projectId and trims the request", () => {
    expect(parseAgentBody({ request: "  plan this  ", projectId: "p1" })).toEqual({
      request: "plan this",
      projectId: "p1",
    });
  });
});

describe("agent submission", () => {
  // 顺序不是风格问题：agent_runs.job_id 有外键，所以 job 必须先建；而正文必须在派发之前落盘，
  // 否则任务可能读到一个没有需求的 run。
  it("provisions, submits, records the request, then dispatches — in that order", async () => {
    const { service, calls } = harness();
    await service.submit(JOB.ownerId, BODY, KEY, "req-1");
    expect(calls).toEqual(["ensureEntitlements", "submit", "createRun", "dispatch"]);
  });

  it("never dispatches when the request text could not be recorded", async () => {
    const { service, dispatch } = harness({
      createRun: vi.fn(async () => {
        throw new AgentJobError("SERVICE_UNAVAILABLE", "nope", 503, true);
      }),
    });
    await expect(service.submit(JOB.ownerId, BODY, KEY, "req-1")).rejects.toThrow(AgentJobError);
    expect(dispatch).not.toHaveBeenCalled();
  });

  it("reserves the planning budget and charges one usage unit", async () => {
    const { service, store } = harness();
    await service.submit(JOB.ownerId, BODY, KEY, "req-1");
    expect(store.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: JOB.ownerId,
        projectId: null,
        environment: "development",
        costPeriod: "2026-09",
      }),
    );
  });

  it("requires a usable idempotency key", async () => {
    const { service, store } = harness();
    await expect(service.submit(JOB.ownerId, BODY, "short", "req-1")).rejects.toThrow(AgentJobError);
    expect(store.submit).not.toHaveBeenCalled();
  });

  // 同样的需求必须产出同样的 hash，否则重放会被误判成幂等冲突。
  it("derives a stable request hash from the request alone", async () => {
    const first = harness();
    const second = harness();
    await first.service.submit(JOB.ownerId, BODY, KEY, "req-1");
    await second.service.submit(JOB.ownerId, { ...BODY }, KEY, "req-2");
    const hashOf = (h: typeof first) =>
      (h.store.submit as ReturnType<typeof vi.fn>).mock.calls[0][0].requestHash;
    expect(hashOf(first)).toBe(hashOf(second));
  });

  it("reports a missing run as not found", async () => {
    const { service } = harness();
    await expect(service.read(JOB.ownerId, JOB.id)).rejects.toThrow(AgentJobError);
  });
});

describe("agent POST handler", () => {
  function post(headers: Record<string, string>) {
    return new Request("https://app.test/api/v1/agent", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(BODY),
    });
  }

  it("refuses a cross-origin request before authenticating", async () => {
    const { service } = harness();
    const authenticate = vi.fn(async () => JOB.ownerId);
    const response = await handleAgentPost(post({ origin: "https://evil.test" }), {
      appOrigin: "https://app.test",
      authenticate,
      service,
      requestId: () => "req-1",
    });
    expect(response.status).toBe(403);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("returns 401 for an unauthenticated caller", async () => {
    const { service } = harness();
    const response = await handleAgentPost(post({ origin: "https://app.test" }), {
      appOrigin: "https://app.test",
      authenticate: async () => {
        throw new Error("no session");
      },
      service,
      requestId: () => "req-1",
    });
    expect(response.status).toBe(401);
  });

  it("accepts a well-formed submission with 202", async () => {
    const { service } = harness();
    const response = await handleAgentPost(
      post({ origin: "https://app.test", "idempotency-key": KEY }),
      {
        appOrigin: "https://app.test",
        authenticate: async () => JOB.ownerId,
        service,
        requestId: () => "req-1",
      },
    );
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      data: { jobId: JOB.id, state: "pending_dispatch" },
      requestId: "req-1",
    });
  });
});
