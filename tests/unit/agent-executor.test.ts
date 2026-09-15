import { describe, expect, it, vi } from "vitest";
import {
  AgentExecutionError,
  executeAgentPlan,
  stepBlockCode,
  stepIdempotencyKey,
  stepInputRef,
  stepReservedMicroUsd,
  type AgentExecutionRun,
  type AgentExecutorStore,
} from "../../src/server/agent/executor";
import type { AgentPlan } from "../../src/server/agent/planner";

const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const PLAN_JOB_ID = "11111111-1111-4111-8111-111111111111";
const RUN_ID = "33333333-3333-4333-8333-333333333333";

const PLAN: AgentPlan = {
  summary: "Draft a caption, then three follow-up ideas.",
  steps: [
    { tool: "caption", rationale: "Turn the request into a caption.", input: { text: "Shipping small features." } },
    { tool: "post-ideas", rationale: "Suggest follow-ups.", input: { topic: "shipping", count: 3 } },
  ],
};

const RUN: AgentExecutionRun = {
  runId: RUN_ID,
  planJobId: PLAN_JOB_ID,
  ownerId: OWNER_ID,
  projectId: null,
  plan: PLAN,
  state: "ready",
};

function storeStub(overrides: Partial<AgentExecutorStore> = {}, run: AgentExecutionRun = RUN) {
  let submitted = 0;
  return {
    loadRun: vi.fn(async () => run),
    loadSteps: vi.fn(async () => new Map<number, string>()),
    submitStep: vi.fn(async () => ({ jobId: `step-job-${submitted++}` })),
    linkStep: vi.fn(async () => {}),
    markRunState: vi.fn(async () => {}),
    ...overrides,
  } satisfies AgentExecutorStore;
}

function dependencies(store: AgentExecutorStore, dispatch = vi.fn(async () => {})) {
  return { deps: { store, dispatch, requestHashSecret: "test-secret" }, dispatch };
}

describe("agent plan execution", () => {
  it("submits every step as a child of the planning job and dispatches it", async () => {
    const store = storeStub();
    const { deps, dispatch } = dependencies(store);
    const result = await executeAgentPlan(deps, OWNER_ID, PLAN_JOB_ID, "request-1");

    expect(result.state).toBe("executing");
    expect(result.blocked).toBeNull();
    expect(result.steps).toEqual([
      { stepIndex: 0, tool: "caption", jobId: "step-job-0", submitted: true },
      { stepIndex: 1, tool: "post-ideas", jobId: "step-job-1", submitted: true },
    ]);
    expect(store.linkStep).toHaveBeenCalledWith({ runId: RUN_ID, stepIndex: 0, jobId: "step-job-0", parentJobId: PLAN_JOB_ID });
    expect(dispatch).toHaveBeenCalledTimes(2);
    expect(store.markRunState).toHaveBeenCalledWith({ runId: RUN_ID, ownerId: OWNER_ID, state: "executing", errorCode: null });
  });

  // 这条守的是 Step 5 的核心要求：闸住一步不回滚整份计划。
  it("keeps the steps it already submitted when a later step is gated", async () => {
    const store = storeStub({
      submitStep: vi.fn(async (input) => {
        if (input.idempotencyKey.endsWith(":1")) {
          throw Object.assign(new Error("insufficient usage balance"), { code: "22003" });
        }
        return { jobId: "step-job-0" };
      }),
    });
    const { deps, dispatch } = dependencies(store);
    const result = await executeAgentPlan(deps, OWNER_ID, PLAN_JOB_ID, "request-1");

    expect(result.steps).toEqual([{ stepIndex: 0, tool: "caption", jobId: "step-job-0", submitted: true }]);
    expect(result.blocked).toEqual({ stepIndex: 1, tool: "post-ideas", code: "QUOTA_EXCEEDED" });
    expect(result.state).toBe("executing");
    expect(dispatch).toHaveBeenCalledTimes(1);
    // 被闸住的原因如实记在 run 上，但状态仍是 executing——第 0 步真的在跑。
    expect(store.markRunState).toHaveBeenCalledWith({ runId: RUN_ID, ownerId: OWNER_ID, state: "executing", errorCode: "QUOTA_EXCEEDED" });
  });

  it("leaves the run ready when even the first step is gated", async () => {
    const store = storeStub({
      submitStep: vi.fn(async () => {
        throw Object.assign(new Error("environment cost budget exceeded"), { code: "22003" });
      }),
    });
    const { deps, dispatch } = dependencies(store);
    const result = await executeAgentPlan(deps, OWNER_ID, PLAN_JOB_ID, "request-1");

    expect(result.state).toBe("ready");
    expect(result.steps).toEqual([]);
    expect(result.blocked).toEqual({ stepIndex: 0, tool: "caption", code: "BUDGET_EXCEEDED" });
    expect(dispatch).not.toHaveBeenCalled();
    // 一步都没落地就不动状态：补足预算后原样再点一次即可。
    expect(store.markRunState).not.toHaveBeenCalled();
  });

  it("resumes from the first step that was never submitted", async () => {
    const store = storeStub({ loadSteps: vi.fn(async () => new Map([[0, "existing-job"]])) });
    const { deps } = dependencies(store);
    const result = await executeAgentPlan(deps, OWNER_ID, PLAN_JOB_ID, "request-1");

    expect(result.steps).toEqual([
      { stepIndex: 0, tool: "caption", jobId: "existing-job", submitted: false },
      { stepIndex: 1, tool: "post-ideas", jobId: "step-job-0", submitted: true },
    ]);
    expect(store.submitStep).toHaveBeenCalledOnce();
    expect(vi.mocked(store.submitStep).mock.calls[0][0].idempotencyKey).toBe(stepIdempotencyKey(RUN_ID, 1));
  });

  it("refuses to execute a plan that is still being planned", async () => {
    const store = storeStub({}, { ...RUN, state: "planning" });
    const { deps } = dependencies(store);
    await expect(executeAgentPlan(deps, OWNER_ID, PLAN_JOB_ID, "request-1")).rejects.toThrow(AgentExecutionError);
    expect(store.submitStep).not.toHaveBeenCalled();
  });

  // 零步 + clarification 是合法的规划产物，但没有任何可执行的东西。
  it("refuses to execute a clarification-only plan", async () => {
    const plan = { summary: "Needs the source text.", steps: [], clarification: "Paste the content first." };
    const store = storeStub({}, { ...RUN, plan });
    const { deps } = dependencies(store);
    await expect(executeAgentPlan(deps, OWNER_ID, PLAN_JOB_ID, "request-1")).rejects.toMatchObject({
      code: "PLAN_HAS_NO_STEPS",
      status: 409,
    });
  });

  it("rejects a stored plan that no longer matches the schema", async () => {
    const store = storeStub({}, { ...RUN, plan: { summary: "x", steps: [{ tool: "not-a-tool", rationale: "y", input: {} }] } });
    const { deps } = dependencies(store);
    await expect(executeAgentPlan(deps, OWNER_ID, PLAN_JOB_ID, "request-1")).rejects.toMatchObject({ code: "PLAN_INVALID" });
  });

  it("reports a missing run as not found", async () => {
    const store = storeStub({ loadRun: vi.fn(async () => null) });
    const { deps } = dependencies(store);
    await expect(executeAgentPlan(deps, OWNER_ID, PLAN_JOB_ID, "request-1")).rejects.toMatchObject({
      code: "NOT_FOUND",
      status: 404,
    });
  });
});

describe("agent step submission details", () => {
  // 幂等键只由 run 和步骤序号决定：重复点执行不会产生第二批子任务。
  it("derives a stable idempotency key per step", () => {
    expect(stepIdempotencyKey(RUN_ID, 2)).toBe(`agent:${RUN_ID}:2`);
    expect(stepIdempotencyKey(RUN_ID, 2).length).toBeGreaterThanOrEqual(8);
  });

  it("reserves the visual tool ceiling only for visual steps", () => {
    // 25_000 与 MAX_PLAN_STEPS 注释里那笔「最贵一步 × 6 步 = 150_000 µUSD」的账对得上。
    expect(stepReservedMicroUsd("portrait")).toBe(25_000);
    expect(stepReservedMicroUsd("caption")).toBe(10_000);
  });

  it("translates a plan step into the shape its worker parses", () => {
    expect(stepInputRef(PLAN.steps[0])).toMatchObject({ tool: "caption", input: "Shipping small features." });
  });

  it("separates a user quota gate from an environment budget gate", () => {
    expect(stepBlockCode(Object.assign(new Error("insufficient usage balance"), { code: "22003" }))).toBe("QUOTA_EXCEEDED");
    expect(stepBlockCode(Object.assign(new Error("environment cost budget exceeded"), { code: "22003" }))).toBe("BUDGET_EXCEEDED");
    expect(stepBlockCode(new Error("connection reset"))).toBe("STEP_SUBMIT_FAILED");
  });
});
