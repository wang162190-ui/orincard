import { createHmac } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseToolRequest, type ToolId } from "../../domain/tools";
import { toolReservedMicroUsd, toTextWorkerRequest, toVisualWorkerRequest, VISUAL_TOOL_IDS } from "../tools/application";
import { currentUsagePeriod } from "../billing/entitlement-grant";
import { parseAgentPlan, type AgentPlan, type PlanStep } from "./planner";

/**
 * 每一步消耗一个 `generation` 额度单位。
 *
 * 与规划那一步同口径（见 `src/app/api/v1/agent/route.ts` 的 `PLAN_USAGE_UNITS`）：
 * `private.submit_job` 要求 `p_units > 0`，而 `grantsForPlan` 目前只发放 `generation` 一种桶。
 * 代价写在明处：一次三步 run 花掉 4 个单位（1 规划 + 3 执行）。
 */
const STEP_USAGE_UNITS = 1;

/**
 * 每一步的成本预留上界，与 `/api/v1/tools/[tool]` 走同一个口径（见
 * `toolReservedMicroUsd`）——同一个工具不论从哪个入口进来都预留同一笔钱。
 *
 * `MAX_PLAN_STEPS` 的注释算的就是「最贵的一步 25_000 × 6 步 = 150_000 µUSD」这笔账，
 * 改那边的数值前先看这笔账还对不对得上。
 */
export function stepReservedMicroUsd(tool: ToolId): number {
  return toolReservedMicroUsd(tool);
}

export class AgentExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AgentExecutionError";
  }
}

export interface AgentExecutionRun {
  readonly runId: string;
  /** 产出计划的那个规划任务；每个子任务的 `parent_job_id` 都指向它。 */
  readonly planJobId: string;
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly plan: unknown;
  readonly state: string;
}

export interface AgentStepSubmission {
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly inputRef: Readonly<Record<string, unknown>>;
  readonly reservedMicroUsd: number;
  readonly submittedAt: string;
  readonly environment: string;
  readonly costPeriod: string;
}

export interface AgentExecutorStore {
  loadRun(ownerId: string, planJobId: string): Promise<AgentExecutionRun | null>;
  /** 已派发过的步骤：步骤序号 → 子任务 id。重跑时据此续跑而不是重复提交。 */
  loadSteps(runId: string): Promise<ReadonlyMap<number, string>>;
  submitStep(input: AgentStepSubmission): Promise<{ readonly jobId: string }>;
  linkStep(input: {
    readonly runId: string;
    readonly stepIndex: number;
    readonly jobId: string;
    readonly parentJobId: string;
  }): Promise<void>;
  markRunState(input: {
    readonly runId: string;
    readonly ownerId: string;
    readonly state: "executing";
    readonly errorCode: string | null;
  }): Promise<void>;
}

export interface AgentStepOutcome {
  readonly stepIndex: number;
  readonly tool: ToolId;
  readonly jobId: string;
  /** 本次调用新提交的，还是之前就已经在跑了。 */
  readonly submitted: boolean;
}

export interface AgentExecutionResult {
  readonly runId: string;
  readonly state: "executing" | "ready";
  readonly steps: readonly AgentStepOutcome[];
  /** 被闸住的那一步。已完成的步骤仍在 `steps` 里，不回滚。 */
  readonly blocked: { readonly stepIndex: number; readonly tool: ToolId; readonly code: string } | null;
}

/**
 * 把提交失败翻译成稳定错误码。
 *
 * `private.submit_job` 对「用户额度不够」和「环境成本预算不够」都抛 22003，只有 message 不同
 * （`walking_skeleton.sql:1010` / `:1019`）。两者对用户是两回事：前者要等下个周期或升级方案，
 * 后者是我们这边的环境预算到顶了，跟用户的额度无关。
 */
export function stepBlockCode(error: unknown): string {
  const failure = error as { code?: string; message?: string } | null;
  const message = failure?.message ?? "";
  if (failure?.code === "22003") {
    return /cost budget/i.test(message) ? "BUDGET_EXCEEDED" : "QUOTA_EXCEEDED";
  }
  if (failure?.code === "42501") return "NOT_FOUND";
  if (failure?.code === "23505") return "IDEMPOTENCY_CONFLICT";
  return "STEP_SUBMIT_FAILED";
}

/** 该步的工具入参，翻译成对应 worker 认的载荷形状；与 `/api/v1/tools/[tool]` 同一套适配器。 */
export function stepInputRef(step: PlanStep): Readonly<Record<string, unknown>> {
  const parsed = parseToolRequest(step.tool, { input: step.input });
  return VISUAL_TOOL_IDS.includes(step.tool as (typeof VISUAL_TOOL_IDS)[number])
    ? (toVisualWorkerRequest(parsed) as unknown as Readonly<Record<string, unknown>>)
    : (toTextWorkerRequest(parsed) as unknown as Readonly<Record<string, unknown>>);
}

/**
 * 计划里每一步都要能落到 `agent_run_steps`，所以幂等键必须只由「哪次 run 的第几步」决定：
 * 重复点「执行」不会产生第二批子任务，被闸住后再点会从第一个没提交的步骤续上。
 */
export function stepIdempotencyKey(runId: string, stepIndex: number): string {
  return `agent:${runId}:${stepIndex}`;
}

export interface AgentExecutorDependencies {
  readonly store: AgentExecutorStore;
  readonly dispatch: (jobId: string, requestId: string) => Promise<void>;
  readonly requestHashSecret: string;
  readonly environment?: string;
  readonly now?: () => Date;
}

/**
 * 用户确认后，把计划的每一步提交为规划任务的子任务。
 *
 * 三条刻意的取舍：
 *
 * 1. **不整体回滚。** 某一步被额度或环境预算闸住时，前面已经提交的步骤原样留着跑完，
 *    结果照常可用，被闸住的那一步如实回报（`blocked`）。把已经花掉的额度再撤回来，
 *    既做不到原子，也会把一份用户已经看到的部分产出凭空抹掉。
 * 2. **步骤之间不传递产物。** 计划里每一步的 `input` 都是自包含的（规划时就已经过
 *    `parseToolRequest` 校验），系统里也没有「把第 1 步的输出接到第 2 步的输入」这条通路。
 *    因此这里一次把各步都提交出去，而不是串行等待。要做产物传递，得先设计那条通路，
 *    不能靠执行顺序假装它存在。
 * 3. **`parent_job_id` 在提交之后单独写。** `server_submit_job` 的签名里没有这个参数，
 *    扩它要另开一份迁移改函数签名。父子关系的权威记录是 `agent_run_steps`（有外键），
 *    `parent_job_id` 是给既有任务视图用的第二处索引，写失败不影响执行，因此不阻断。
 */
export async function executeAgentPlan(
  dependencies: AgentExecutorDependencies,
  ownerId: string,
  planJobId: string,
  requestId: string,
): Promise<AgentExecutionResult> {
  const now = dependencies.now ?? (() => new Date());
  const run = await dependencies.store.loadRun(ownerId, planJobId);
  if (!run) throw new AgentExecutionError("NOT_FOUND", "Agent run was not found.", 404, false);
  if (!["ready", "executing"].includes(run.state)) {
    throw new AgentExecutionError("PLAN_NOT_READY", "This plan is not ready to run.", 409, false);
  }

  // 计划存的是 jsonb，读回来重新过一遍 schema：写进去时是合法的不代表读出来还是——
  // 中间隔着一次数据库往返和一个可被别的代码写坏的列。
  let plan: AgentPlan;
  try {
    plan = parseAgentPlan(run.plan);
  } catch {
    throw new AgentExecutionError("PLAN_INVALID", "The stored plan is no longer valid.", 409, false);
  }
  if (plan.steps.length === 0) {
    // 零步计划是合法产出（模型要澄清），但没有任何可执行的东西。
    throw new AgentExecutionError("PLAN_HAS_NO_STEPS", "This plan needs more detail before it can run.", 409, false);
  }

  const dispatched = await dependencies.store.loadSteps(run.runId);
  const at = now();
  const period = currentUsagePeriod(at);
  const steps: AgentStepOutcome[] = [];
  let blocked: AgentExecutionResult["blocked"] = null;

  for (const [stepIndex, step] of plan.steps.entries()) {
    const existing = dispatched.get(stepIndex);
    if (existing) {
      steps.push({ stepIndex, tool: step.tool, jobId: existing, submitted: false });
      continue;
    }
    let jobId: string;
    try {
      const submission = await dependencies.store.submitStep({
        ownerId: run.ownerId,
        projectId: run.projectId,
        idempotencyKey: stepIdempotencyKey(run.runId, stepIndex),
        requestHash: createHmac("sha256", dependencies.requestHashSecret)
          .update(JSON.stringify({ runId: run.runId, stepIndex, tool: step.tool, input: step.input }))
          .digest("hex"),
        inputRef: stepInputRef(step),
        reservedMicroUsd: stepReservedMicroUsd(step.tool),
        submittedAt: at.toISOString(),
        environment: dependencies.environment ?? "development",
        costPeriod: at.toISOString().slice(0, 7),
      });
      jobId = submission.jobId;
    } catch (error) {
      // 闸在这里就停在这里：后面的步骤不提交，前面的原样留着。
      blocked = { stepIndex, tool: step.tool, code: stepBlockCode(error) };
      break;
    }
    await dependencies.store.linkStep({ runId: run.runId, stepIndex, jobId, parentJobId: run.planJobId });
    await dependencies.dispatch(jobId, requestId);
    steps.push({ stepIndex, tool: step.tool, jobId, submitted: true });
  }

  // 一步都没落地时状态不动：run 仍是 `ready`，用户补足额度后可以原样再点一次执行。
  const state = steps.length > 0 ? ("executing" as const) : ("ready" as const);
  if (state === "executing") {
    await dependencies.store.markRunState({
      runId: run.runId,
      ownerId: run.ownerId,
      state: "executing",
      errorCode: blocked?.code ?? null,
    });
  }
  return { runId: run.runId, state, steps, blocked };
}

export function createSupabaseAgentExecutorStore(client: SupabaseClient): AgentExecutorStore {
  return {
    async loadRun(ownerId, planJobId) {
      const { data, error } = await client
        .from("agent_runs")
        .select("id,job_id,owner_id,plan,state,jobs!inner(project_id,state)")
        .eq("owner_id", ownerId)
        .eq("job_id", planJobId)
        .maybeSingle();
      if (error || !data) return null;
      const job = data.jobs as unknown as { project_id: string | null; state: string };
      return {
        runId: data.id as string,
        planJobId: data.job_id as string,
        ownerId: data.owner_id as string,
        projectId: job.project_id ?? null,
        plan: data.plan,
        state: data.state as string,
      };
    },

    async loadSteps(runId) {
      const { data, error } = await client.from("agent_run_steps").select("step_index,job_id").eq("run_id", runId);
      if (error || !data) return new Map();
      return new Map(data.map((row) => [Number(row.step_index), row.job_id as string]));
    },

    async submitStep(input) {
      const account = await client
        .from("usage_accounts")
        .select("period_start,period_end")
        .eq("owner_id", input.ownerId)
        .eq("resource", "generation")
        .lte("period_start", input.submittedAt)
        .gt("period_end", input.submittedAt)
        .maybeSingle();
      if (account.error) throw account.error;
      if (!account.data) {
        throw Object.assign(new Error("insufficient usage balance"), { code: "22003" });
      }
      const { data, error } = await client.rpc("server_submit_job", {
        p_owner_id: input.ownerId,
        p_project_id: input.projectId,
        p_kind: "tool",
        p_input_ref: input.inputRef,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
        p_resource: "generation",
        p_units: STEP_USAGE_UNITS,
        p_period_start: account.data.period_start,
        p_period_end: account.data.period_end,
        p_environment: input.environment,
        p_cost_period: input.costPeriod,
        p_reserved_micro_usd: input.reservedMicroUsd,
      });
      if (error || !data) throw error ?? new Error("STEP_SUBMIT_FAILED");
      return { jobId: (data as unknown as Record<string, unknown>).id as string };
    },

    async linkStep(input) {
      const { error } = await client
        .from("agent_run_steps")
        .insert({ run_id: input.runId, step_index: input.stepIndex, job_id: input.jobId });
      // 重复点执行时这一行已经存在；唯一冲突在这里是正常结果。
      if (error && (error as { code?: string }).code !== "23505") throw error;
      // 见 executeAgentPlan 的取舍 3：父子指针是第二处索引，写不上不阻断执行。
      await client.from("jobs").update({ parent_job_id: input.parentJobId }).eq("id", input.jobId);
    },

    async markRunState(input) {
      await client
        .from("agent_runs")
        .update({ state: input.state, error_code: input.errorCode, updated_at: new Date().toISOString() })
        .eq("id", input.runId)
        .eq("owner_id", input.ownerId)
        .in("state", ["ready", "executing"]);
    },
  };
}
