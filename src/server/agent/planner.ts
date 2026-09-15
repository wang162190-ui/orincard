import { z } from "zod";
import { parseToolRequest, TOOL_IDS, type ToolId } from "../../domain/tools";

/**
 * 一份计划最多几步。
 *
 * 这个数不是审美，是预算：执行阶段每一步都是一次独立的任务提交，最贵的一步（generation /
 * portrait 类）预留 25_000 µUSD，6 步的最坏上界是 150_000 µUSD ≈ $0.15。配合
 * `AI_MONTHLY_BUDGET_USD=10` 的月度硬顶，一个月能跑 60 次以上。改大这个数之前先重算这笔账。
 *
 * 上界同时写在三处，必须一起改：本常量、供应商侧 JSON Schema 的 `maxItems`（由本文件的
 * `planSchema` 现生成，自动跟随）、以及 `public.agent_run_steps.step_index` 的检查约束
 * （`supabase/migrations/20260915000000_agent_orchestrator.sql`）。
 */
export const MAX_PLAN_STEPS = 6;

const planStepSchema = z.object({
  tool: z.enum(TOOL_IDS),
  /** 给用户看的一句话理由，让「为什么是这几步」可审。 */
  rationale: z.string().trim().min(1).max(300),
  /**
   * 该工具的入参。这里只约束到「是个对象」，真正的校验交给 `parseToolRequest`——
   * 那是工具自己的权威 schema，在这里复述一遍就又制造了一处漂移。
   */
  input: z.record(z.string(), z.unknown()),
});

const planObjectSchema = z.object({
  summary: z.string().trim().min(1).max(500),
  steps: z.array(planStepSchema).max(MAX_PLAN_STEPS),
  /** 需求太含糊、无法规划时，模型返回零步并在这里说明还缺什么。 */
  clarification: z.string().trim().max(500).optional(),
});

export const planSchema = planObjectSchema.refine(
  (plan) => plan.steps.length > 0 || Boolean(plan.clarification?.trim()),
  { message: "An empty plan must explain what is missing." },
);

export const PLAN_SCHEMA_NAME = "agent_plan" as const;

/**
 * 交给供应商 `text.format` 的 JSON Schema，从 `planObjectSchema` 现生成。
 *
 * 从 refine 之前的对象生成是有意的：`.refine()` 是运行时断言，`z.toJSONSchema` 会静默丢弃它。
 * 从 refine 之后生成不会报错，只会得到一份**看起来完整、实则少了那条规则**的 schema——
 * 于是那条规则只剩我们这边在查。把生成点固定在 refine 之前，这件事在代码上就是显式的。
 */
export const PLAN_JSON_SCHEMA: Record<string, unknown> =
  z.toJSONSchema(planObjectSchema, { io: "output" }) as Record<string, unknown>;

export type PlanStep = z.infer<typeof planStepSchema>;
export type AgentPlan = z.infer<typeof planObjectSchema>;

export class PlanRejectedError extends Error {
  constructor(readonly code: "PLAN_INVALID" | "PLAN_STEP_INVALID", message: string) {
    super(message);
    this.name = "PlanRejectedError";
  }
}

/**
 * 校验模型产出的计划。
 *
 * 两道关：先过 `planSchema`（形状、步数上界），再逐步过该工具自己的 `parseToolRequest`。
 * 任何一步过不了就**整份判废**，不做「尽力修补」——修补出来的计划用户没法信，
 * 而且会把一个模型错误伪装成一次成功规划。
 *
 * 步数上界在 JSON Schema 里已经写了 `maxItems`，这里再查一次：供应商不保证遵守 schema，
 * 而超限的代价直接是钱。
 */
export function parseAgentPlan(value: unknown): AgentPlan {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    throw new PlanRejectedError("PLAN_INVALID", "The model returned a plan that does not match the plan schema.");
  }
  const plan = parsed.data;
  plan.steps.forEach((step, index) => {
    try {
      parseToolRequest(step.tool, { input: step.input });
    } catch {
      throw new PlanRejectedError(
        "PLAN_STEP_INVALID",
        `Step ${index} does not match the input schema of tool "${step.tool}".`,
      );
    }
  });
  return plan;
}

/** 计划里出现过的工具，按首次出现排序；供界面和验收文档引用。 */
export function planTools(plan: AgentPlan): readonly ToolId[] {
  return [...new Set(plan.steps.map((step) => step.tool))];
}
