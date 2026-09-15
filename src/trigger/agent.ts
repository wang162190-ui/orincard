import { task } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { createDeepSeekResponsesAdapter, createDeepSeekResponsesClient, type StructuredAI } from "../server/ai";
import { runPlan } from "../server/agent/plan-run";
import { PlanRejectedError, planTools, type AgentPlan } from "../server/agent/planner";
import { createMeasurementCollector, registerJobCostAttempt, settleKeyedJobUsage } from "../server/cost-settlement";
import { createAdminSupabaseClient } from "../server/supabase";
import { AGENT_TASK_ID } from "./dispatch";

export { AGENT_TASK_ID };

/** 载荷是不可变边界，与其余任务逐字一致：只带指针，不带正文。 */
const payloadSchema = z.object({ jobId: z.string().uuid(), schemaVersion: z.literal(1), requestId: z.string().min(1).max(200) }).strict();

/** 一次 run 恰好一次模型调用，序号因此恒为 1；重试复用同一行而不是另开一行把同一笔预留计两遍。 */
const AGENT_OPERATION = "agent" as const;
const AGENT_SEQUENCE = 1;

export type AgentClaim = { readonly jobId: string; readonly ownerId: string; readonly projectId: string | null };
export type AgentWork = AgentClaim & { readonly runId: string; readonly request: string; readonly projectTitle?: string };

/**
 * 找不到 run 行。
 *
 * 路由是「先建 job、再落正文、最后派发」，所以正文落盘失败时不会派发；但对账兜底重新派发时
 * run 行仍可能缺失。那种情况下需求正文根本不存在，**必须当成明确失败报出来**——
 * 用空需求继续跑会花掉一次真实调用，再产出一份凭空捏造的计划。
 */
export class AgentRunMissingError extends Error {
  readonly code = "AGENT_RUN_MISSING";
  constructor(jobId: string) {
    super(`Agent run row is missing for job ${jobId}.`);
    this.name = "AgentRunMissingError";
  }
}

/** 写回 job / agent_runs 时用的稳定错误码，不含正文。 */
export function agentErrorCode(error: unknown): string {
  if (error instanceof AgentRunMissingError) return error.code;
  if (error instanceof PlanRejectedError) return error.code;
  if (error instanceof Error && /^[A-Z][A-Z0-9_]{2,63}$/.test(error.message)) return error.message;
  return "AGENT_PLAN_FAILED";
}

/** job.result_ref 只放摘要：完整计划在 agent_runs.plan，两处存同一份就会漂移。 */
export function planSummaryRef(plan: AgentPlan): Readonly<Record<string, unknown>> {
  return {
    plan: {
      summary: plan.summary,
      stepCount: plan.steps.length,
      tools: planTools(plan),
      ...(plan.clarification ? { clarification: plan.clarification } : {}),
    },
  };
}

export interface AgentWorkerStore {
  claim(jobId: string): Promise<AgentClaim | null>;
  loadRun(claim: AgentClaim): Promise<AgentWork | null>;
  succeed(work: AgentWork, plan: AgentPlan): Promise<boolean>;
  fail(jobId: string, ownerId: string, errorCode: string): Promise<void>;
}

export function createSupabaseAgentWorkerStore(client: SupabaseClient): AgentWorkerStore {
  return {
    async claim(jobId) {
      // kind='agent' 的过滤在这里：迁移里那条检查约束因为 PG 的枚举限制加不了，
      // 不变式由路由和这里两处共同守住（见 20260915000000_agent_orchestrator.sql 的注释）。
      const jobResult = await client.from("jobs").select("id,owner_id,project_id,state,cancel_requested_at").eq("id", jobId).eq("kind", "agent").maybeSingle();
      if (jobResult.error || !jobResult.data || jobResult.data.cancel_requested_at || !["pending_dispatch", "queued"].includes(jobResult.data.state)) return null;
      const now = new Date().toISOString();
      // stage 用 'outline'：`jobs.stage` 是受检查约束的固定集合（walking_skeleton.sql:745），
      // 里面没有 'plan'，而规划正是既有阶段里语义最近的一个。为此新增枚举值要另开迁移，不值当。
      const claimed = await client.from("jobs").update({ state: "running", stage: "outline", progress: 20, heartbeat_at: now, updated_at: now }).eq("id", jobId).eq("owner_id", jobResult.data.owner_id).eq("state", jobResult.data.state).is("cancel_requested_at", null).select("id").maybeSingle();
      if (claimed.error || !claimed.data) return null;
      return { jobId, ownerId: jobResult.data.owner_id, projectId: (jobResult.data.project_id as string | null) ?? null };
    },

    async loadRun(claim) {
      const run = await client.from("agent_runs").select("id,request").eq("job_id", claim.jobId).eq("owner_id", claim.ownerId).maybeSingle();
      if (run.error || !run.data) return null;
      let projectTitle: string | undefined;
      if (claim.projectId) {
        // 标题只是给模型判断需求指代什么的上下文；取不到就不传，不因此让规划失败。
        const project = await client.from("projects").select("title").eq("id", claim.projectId).eq("owner_id", claim.ownerId).maybeSingle();
        projectTitle = (project.data?.title as string | undefined) ?? undefined;
      }
      return { ...claim, runId: run.data.id as string, request: run.data.request as string, projectTitle };
    },

    async succeed(work, plan) {
      const finishedAt = new Date().toISOString();
      // 计划先落 agent_runs：job 标成 succeeded 却没有计划可读，比反过来更难收拾。
      // state 走 'ready' 而非 'completed'——编排器要等用户确认后才执行（Step 5）。
      const stored = await client.from("agent_runs").update({ plan, state: "ready", error_code: null, updated_at: finishedAt }).eq("id", work.runId).eq("owner_id", work.ownerId).eq("state", "planning").select("id").maybeSingle();
      if (stored.error || !stored.data) return false;
      const result = await client.from("jobs").update({ state: "succeeded", stage: "outline", progress: 100, result_ref: planSummaryRef(plan), finished_at: finishedAt, updated_at: finishedAt }).eq("id", work.jobId).eq("owner_id", work.ownerId).eq("state", "running").select("id").maybeSingle();
      return !result.error && Boolean(result.data);
    },

    async fail(jobId, ownerId, errorCode) {
      const finishedAt = new Date().toISOString();
      await client.from("agent_runs").update({ state: "failed", error_code: errorCode, updated_at: finishedAt }).eq("job_id", jobId).eq("owner_id", ownerId).eq("state", "planning");
      await client.from("jobs").update({ state: "failed", error_code: errorCode, finished_at: finishedAt, updated_at: finishedAt }).eq("id", jobId).eq("owner_id", ownerId).eq("state", "running");
    },
  };
}

export async function runAgentPlanJob(
  store: AgentWorkerStore,
  generate: (work: AgentWork) => Promise<AgentPlan>,
  payload: unknown,
) {
  const accepted = payloadSchema.parse(payload);
  const claim = await store.claim(accepted.jobId);
  if (!claim) return { jobId: accepted.jobId, state: "ignored" as const };
  try {
    const work = await store.loadRun(claim);
    // 注意顺序：读需求在登记成本尝试**之前**。没有需求就不该发起调用，更不该先占一笔账。
    if (!work) throw new AgentRunMissingError(claim.jobId);
    const plan = await generate(work);
    if (!await store.succeed(work, plan)) throw new Error("AGENT_WRITEBACK_LOST");
    return { jobId: work.jobId, state: "succeeded" as const };
  } catch (error) {
    await store.fail(claim.jobId, claim.ownerId, agentErrorCode(error));
    throw error;
  }
}

/**
 * 规划一次，并把这次调用记进账。
 *
 * 与 `src/trigger/tool.ts` 同构：`agent` 路径也没有 SQL 侧登记尝试行，必须自己 register，
 * 否则结算会因「cost attempt not found」失败。结算放 `finally`——失败也要结算，token 照烧。
 */
export function createAgentPlanRunner(input: {
  readonly client: Parameters<typeof registerJobCostAttempt>[0]["client"];
  readonly ai: StructuredAI;
}) {
  return async (work: AgentWork): Promise<AgentPlan> => {
    await registerJobCostAttempt({ client: input.client, jobId: work.jobId, operation: AGENT_OPERATION, sequence: AGENT_SEQUENCE });
    const collector = createMeasurementCollector();
    try {
      return await runPlan({
        ai: input.ai,
        request: work.request,
        context: work.projectTitle ? { projectTitle: work.projectTitle } : undefined,
        onMeasurement: collector.onMeasurement,
      });
    } finally {
      await settleKeyedJobUsage({ client: input.client, jobId: work.jobId, operation: AGENT_OPERATION, sequence: AGENT_SEQUENCE, measurements: collector.collected() });
    }
  };
}

export const agentPlanTask = task({
  id: AGENT_TASK_ID,
  maxDuration: 300,
  run: async (payload: unknown) => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) throw new Error("DEEPSEEK_API_KEY is not configured for the agent task");
    const ai = createDeepSeekResponsesAdapter(createDeepSeekResponsesClient(apiKey));
    const client = createAdminSupabaseClient();
    return runAgentPlanJob(
      createSupabaseAgentWorkerStore(client),
      createAgentPlanRunner({ client, ai }),
      payload,
    );
  },
});
