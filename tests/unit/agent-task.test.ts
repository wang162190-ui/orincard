import { describe, expect, it, vi } from "vitest";
import type { ProviderMeasurement, StructuredOutputRequest } from "../../src/server/ai";
import { PlanRejectedError, type AgentPlan } from "../../src/server/agent/planner";
import {
  AgentRunMissingError,
  agentErrorCode,
  createAgentPlanRunner,
  planSummaryRef,
  runAgentPlanJob,
  type AgentClaim,
  type AgentWork,
  type AgentWorkerStore,
} from "../../src/trigger/agent";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";
const RUN_ID = "33333333-3333-4333-8333-333333333333";
const PAYLOAD = { jobId: JOB_ID, schemaVersion: 1, requestId: "request-1" };

const CLAIM: AgentClaim = { jobId: JOB_ID, ownerId: OWNER_ID, projectId: null };
const WORK: AgentWork = { ...CLAIM, runId: RUN_ID, request: "Write a caption and three follow-up ideas." };

const PLAN: AgentPlan = {
  summary: "Draft a caption, then three follow-up ideas.",
  steps: [
    { tool: "caption", rationale: "Turn the request into a caption.", input: { text: "Shipping small features." } },
    { tool: "post-ideas", rationale: "Suggest follow-ups.", input: { topic: "shipping" } },
  ],
};

function storeStub(overrides: Partial<AgentWorkerStore> = {}) {
  return {
    claim: vi.fn(async () => CLAIM),
    loadRun: vi.fn(async () => WORK),
    succeed: vi.fn(async () => true),
    fail: vi.fn(async () => {}),
    ...overrides,
  } satisfies AgentWorkerStore;
}

describe("agent plan job", () => {
  it("plans once and writes the plan back", async () => {
    const store = storeStub();
    const generate = vi.fn(async () => PLAN);
    await expect(runAgentPlanJob(store, generate, PAYLOAD)).resolves.toEqual({ jobId: JOB_ID, state: "succeeded" });
    expect(generate).toHaveBeenCalledOnce();
    expect(store.succeed).toHaveBeenCalledWith(WORK, PLAN);
  });

  it("returns ignored when the job could not be claimed", async () => {
    const store = storeStub({ claim: vi.fn(async () => null) });
    await expect(runAgentPlanJob(store, vi.fn(), PAYLOAD)).resolves.toEqual({ jobId: JOB_ID, state: "ignored" });
    expect(store.loadRun).not.toHaveBeenCalled();
    expect(store.fail).not.toHaveBeenCalled();
  });

  // 对账兜底重新派发时 run 行可能缺失。空需求继续跑会花掉一次真实调用、再编一份计划出来，
  // 所以这必须是一个明确的失败。
  it("fails loudly when the run row is missing instead of planning an empty request", async () => {
    const store = storeStub({ loadRun: vi.fn(async () => null) });
    const generate = vi.fn();
    await expect(runAgentPlanJob(store, generate, PAYLOAD)).rejects.toThrow(AgentRunMissingError);
    expect(generate).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith(JOB_ID, OWNER_ID, "AGENT_RUN_MISSING");
  });

  it("records a rejected plan under its own error code", async () => {
    const store = storeStub();
    const generate = vi.fn(async () => {
      throw new PlanRejectedError("PLAN_STEP_INVALID", "bad step");
    });
    await expect(runAgentPlanJob(store, generate, PAYLOAD)).rejects.toThrow(PlanRejectedError);
    expect(store.succeed).not.toHaveBeenCalled();
    expect(store.fail).toHaveBeenCalledWith(JOB_ID, OWNER_ID, "PLAN_STEP_INVALID");
  });

  it("fails the job when the plan writeback is lost", async () => {
    const store = storeStub({ succeed: vi.fn(async () => false) });
    await expect(runAgentPlanJob(store, async () => PLAN, PAYLOAD)).rejects.toThrow("AGENT_WRITEBACK_LOST");
    expect(store.fail).toHaveBeenCalledWith(JOB_ID, OWNER_ID, "AGENT_WRITEBACK_LOST");
  });

  it("rejects a payload carrying anything beyond the immutable boundary", async () => {
    const store = storeStub();
    await expect(runAgentPlanJob(store, vi.fn(), { ...PAYLOAD, request: "smuggled body" })).rejects.toThrow();
    expect(store.claim).not.toHaveBeenCalled();
  });

  it("keeps the request text out of the job result", () => {
    const ref = planSummaryRef(PLAN);
    expect(ref).toEqual({ plan: { summary: PLAN.summary, stepCount: 2, tools: ["caption", "post-ideas"] } });
    expect(JSON.stringify(ref)).not.toContain(WORK.request);
  });

  it("maps unknown failures to a stable code", () => {
    expect(agentErrorCode(new Error("Request failed with status 502"))).toBe("AGENT_PLAN_FAILED");
    expect(agentErrorCode(new Error("PROVIDER_FAILED"))).toBe("PROVIDER_FAILED");
  });
});

describe("agent cost settlement", () => {
  function rpcStub() {
    const calls: string[] = [];
    return {
      calls,
      client: {
        rpc: vi.fn(async (name: string, _parameters: Readonly<Record<string, unknown>>) => {
          calls.push(name);
          return { data: null, error: null };
        }),
      },
    };
  }

  const measurement: ProviderMeasurement = {
    providerOperationId: "resp-1",
    model: "deepseek-v4-pro",
    usage: { inputTokens: 3_000, outputTokens: 500, cachedInputTokens: 0, totalTokens: 3_500 },
  };

  it("registers the attempt before calling the provider and settles afterwards", async () => {
    const { client, calls } = rpcStub();
    const ai = {
      generateStructured: vi.fn(async (request: StructuredOutputRequest) => {
        expect(calls).toEqual(["server_register_cost_attempt"]);
        await request.onMeasurement?.(measurement);
        return PLAN;
      }),
    };
    await expect(createAgentPlanRunner({ client, ai })(WORK)).resolves.toMatchObject({ summary: PLAN.summary });
    expect(calls).toEqual(["server_register_cost_attempt", "server_settle_cost_attempt"]);
    expect(client.rpc.mock.calls[0][1]).toMatchObject({ p_job_id: JOB_ID, p_attempt_key: `job:${JOB_ID}:agent:1` });
  });

  // 结算放 finally：失败也要结算，token 已经烧掉了。
  it("still settles when the provider call throws", async () => {
    const { client, calls } = rpcStub();
    const ai = {
      generateStructured: vi.fn(async (request: StructuredOutputRequest) => {
        await request.onMeasurement?.(measurement);
        throw new Error("PROVIDER_FAILED");
      }),
    };
    await expect(createAgentPlanRunner({ client, ai })(WORK)).rejects.toThrow("PROVIDER_FAILED");
    expect(calls).toEqual(["server_register_cost_attempt", "server_settle_cost_attempt"]);
  });

  // 登记失败说明预留不在，继续调用等于绕过预算：错误向上冒泡，且不发起供应商调用。
  it("never calls the provider when the attempt could not be registered", async () => {
    const client = { rpc: vi.fn(async () => ({ data: null, error: new Error("cost reservation missing") })) };
    const ai = { generateStructured: vi.fn() };
    await expect(createAgentPlanRunner({ client, ai })(WORK)).rejects.toThrow();
    expect(ai.generateStructured).not.toHaveBeenCalled();
  });
});
