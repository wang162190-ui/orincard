import { describe, expect, it, vi } from "vitest";
import { parseToolRequest } from "../../src/domain/tools";
import {
  ToolJobError,
  createToolJobService,
  handleToolPost,
  toolInputRef,
  toolSubmitFailure,
  type ToolSubmissionStore,
} from "../../src/app/api/v1/tools/[tool]/route";

const OWNER = "11111111-1111-4111-8111-111111111111";
const JOB_ID = "7c2f1a6e-0000-4000-8000-000000000002";
const ASSET_ID = "7c2f1a6e-0000-4000-8000-0000000000aa";
const KEY = "idem-key-0002";

const CAPTION = parseToolRequest("caption", { input: { text: "A short post about shipping." } });
const PORTRAIT = parseToolRequest("portrait", { input: { prompt: "A studio portrait.", referenceAssetId: ASSET_ID } });

function harness(overrides: Partial<ToolSubmissionStore> = {}) {
  const calls: string[] = [];
  const store: ToolSubmissionStore = {
    submit: vi.fn(async () => {
      calls.push("submit");
      return { id: JOB_ID, state: "pending_dispatch" };
    }),
    ...overrides,
  };
  const dispatch = vi.fn(async () => {
    calls.push("dispatch");
  });
  const ensureEntitlements = vi.fn(async () => {
    calls.push("ensureEntitlements");
  });
  const service = createToolJobService({
    store,
    dispatch,
    ensureEntitlements,
    requestHashSecret: "test-secret",
    environment: "development",
    now: () => new Date("2026-09-15T12:00:00Z"),
  });
  return { service, store, dispatch, ensureEntitlements, calls };
}

describe("tool submission", () => {
  // 这条守着本次修的缺陷：这个入口从前用 admin.from("jobs").upsert() 直接建 job，
  // 从不写 private.cost_reservations，于是 worker 走到 register_cost_attempt 必然
  // 22023 `open cost reservation not found`。有预留才说明它走的是 server_submit_job。
  it("reserves cost and charges one usage unit for a text tool", async () => {
    const { service, store } = harness();
    await service.submit(OWNER, CAPTION, KEY, "req-1");
    expect(store.submit).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: OWNER,
        projectId: null,
        environment: "development",
        costPeriod: "2026-09",
        reservedMicroUsd: 10_000,
      }),
    );
  });

  // 视觉工具要渲染并调图片供应商，预留与 visual-tool.ts 的 PORTRAIT_RESERVED_MICRO_USD 同档。
  it("reserves the visual budget for a visual tool", async () => {
    const { service, store } = harness();
    await service.submit(OWNER, PORTRAIT, KEY, "req-1");
    expect(store.submit).toHaveBeenCalledWith(expect.objectContaining({ reservedMicroUsd: 25_000 }));
  });

  // 发放必须在提交之前：submit_job 按 (owner, period_start, resource) 精确相等找桶，桶不存在就是 22003。
  it("provisions entitlements before submitting, then dispatches", async () => {
    const { service, calls } = harness();
    await service.submit(OWNER, CAPTION, KEY, "req-1");
    expect(calls).toEqual(["ensureEntitlements", "submit", "dispatch"]);
  });

  // 额度与成本预留在 submit 那一刻就已落盘，派发失败由对账巡检兜底，不该把请求也判失败。
  it("still returns the job when dispatch fails", async () => {
    const { service, store } = harness();
    const failing = createToolJobService({
      store,
      dispatch: vi.fn(async () => {
        throw new Error("trigger unreachable");
      }),
      requestHashSecret: "test-secret",
    });
    await expect(failing.submit(OWNER, CAPTION, KEY, "req-1")).resolves.toEqual({
      jobId: JOB_ID,
      state: "pending_dispatch",
    });
  });

  it("carries the selected project so the database can check access", async () => {
    const withProject = parseToolRequest("caption", {
      input: { text: "A short post." },
      context: { projectId: ASSET_ID, expectedRevision: 3, fields: { caption: true } },
    });
    const { service, store } = harness();
    await service.submit(OWNER, withProject, KEY, "req-1");
    expect(store.submit).toHaveBeenCalledWith(expect.objectContaining({ projectId: ASSET_ID }));
  });

  it("rejects an over-long idempotency key before submitting", async () => {
    const { service, store } = harness();
    await expect(service.submit(OWNER, CAPTION, "k".repeat(201), "req-1")).rejects.toThrow(ToolJobError);
    expect(store.submit).not.toHaveBeenCalled();
  });
});

describe("tool submission failures", () => {
  // submit_job 对两者都抛 22003，只有 message 不同；对用户这是两回事。
  it("separates a spent user quota from a spent environment budget", () => {
    expect(() => toolSubmitFailure({ code: "22003", message: "insufficient usage balance" })).toThrow(
      expect.objectContaining({ code: "QUOTA_EXCEEDED", status: 429 }),
    );
    expect(() => toolSubmitFailure({ code: "22003", message: "environment cost budget exceeded" })).toThrow(
      expect.objectContaining({ code: "BUDGET_EXCEEDED", status: 429 }),
    );
  });

  it("maps a replayed key with different input to a conflict", () => {
    expect(() => toolSubmitFailure({ code: "23505", message: "idempotency key request hash conflict" })).toThrow(
      expect.objectContaining({ code: "IDEMPOTENCY_CONFLICT", status: 409 }),
    );
  });

  it("maps an inaccessible account or project to not found", () => {
    expect(() => toolSubmitFailure({ code: "42501", message: "account is not active" })).toThrow(
      expect.objectContaining({ code: "NOT_FOUND", status: 404 }),
    );
  });

  it("treats anything else as retryable", () => {
    expect(() => toolSubmitFailure(new Error("connection reset"))).toThrow(
      expect.objectContaining({ code: "SERVICE_UNAVAILABLE", status: 503, retryable: true }),
    );
  });
});

describe("tool worker payload", () => {
  it("routes each tool to the adapter its worker parses", () => {
    expect(toolInputRef(CAPTION)).toEqual(expect.objectContaining({ tool: "caption" }));
    expect(toolInputRef(PORTRAIT)).toEqual(
      expect.objectContaining({ tool: "portrait", input: { prompt: "A studio portrait.", referenceAssetId: ASSET_ID } }),
    );
  });
});

describe("tool POST handler", () => {
  function post(headers: Record<string, string>, body: unknown = { input: { text: "A short post about shipping." } }) {
    return new Request("https://app.test/api/v1/tools/caption", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  }

  function dependencies(service: ReturnType<typeof harness>["service"], tool = "caption") {
    return {
      appUrl: "https://app.test",
      authenticate: async () => OWNER,
      service,
      tool: async () => tool,
      requestId: () => "req-1",
      idempotencyKey: () => KEY,
    };
  }

  it("refuses a cross-origin request before authenticating", async () => {
    const { service } = harness();
    const authenticate = vi.fn(async () => OWNER);
    const response = await handleToolPost(post({ origin: "https://evil.test" }), {
      ...dependencies(service),
      authenticate,
    });
    expect(response.status).toBe(400);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("returns 401 for an unauthenticated caller", async () => {
    const { service } = harness();
    const response = await handleToolPost(post({ origin: "https://app.test" }), {
      ...dependencies(service),
      authenticate: async () => {
        throw new Error("no session");
      },
    });
    expect(response.status).toBe(401);
  });

  it("accepts a well-formed submission with 202 and the tool result type", async () => {
    const { service } = harness();
    const response = await handleToolPost(post({ origin: "https://app.test" }), dependencies(service));
    expect(response.status).toBe(202);
    await expect(response.json()).resolves.toEqual({
      data: { jobId: JOB_ID, resultType: "text" },
      requestId: "req-1",
    });
  });

  it("rejects an unregistered tool", async () => {
    const { service, store } = harness();
    const response = await handleToolPost(post({ origin: "https://app.test" }), dependencies(service, "summarise"));
    expect(response.status).toBe(400);
    expect(store.submit).not.toHaveBeenCalled();
  });

  it("reports a spent quota as 429 rather than a generic outage", async () => {
    const { service } = harness({
      submit: vi.fn(async () => toolSubmitFailure({ code: "22003", message: "insufficient usage balance" })),
    });
    const response = await handleToolPost(post({ origin: "https://app.test" }), dependencies(service));
    expect(response.status).toBe(429);
    await expect(response.json()).resolves.toEqual(
      expect.objectContaining({ error: expect.objectContaining({ code: "QUOTA_EXCEEDED" }) }),
    );
  });
});
