import type { StructuredAI, StructuredOutputRequest } from "../ai";
import { buildPlanPrompt, type PlanPromptContext } from "./prompts";
import { parseAgentPlan, PLAN_JSON_SCHEMA, PLAN_SCHEMA_NAME, type AgentPlan } from "./planner";

/**
 * 规划调用的成本预留上界，微美元。
 *
 * 取数：`MODEL_RATES["deepseek-v4-pro"]` 峰时、全部未命中缓存（即 `src/server/cost.ts` 注释
 * 所说的「成本上界」口径）。输入约 3,500 token × 1.32 = 4,620；输出约 600 token × 3.96 = 2,376；
 * 合计约 7,000。取 10,000 留出余量，仍只有 generation 预留（25,000）的四成。
 *
 * 改动这个数或改动 prompt 的体量时一起重算——工具目录是从 `inputSchemas` 现生成的，
 * 新增工具会直接推高输入 token。
 */
export const PLAN_RESERVED_MICRO_USD = 10_000;

/**
 * 跑一次规划。一次 run 恰好一次模型调用——这是编排器形态的定义，不是可调参数。
 *
 * 与 `generateTextToolCandidate` 同构：注入 `ai`，透传 `onMeasurement`，产物用 Zod 复校。
 * 这里**没有** `generation.ts` 那样的 schema 修复重试：修复要再花一次钱，而一份规划失败的
 * 代价只是让用户重说一遍需求，不值得为它自动付第二次费。
 */
export async function runPlan(input: {
  readonly ai: StructuredAI;
  readonly request: string;
  readonly context?: PlanPromptContext;
  readonly onMeasurement?: StructuredOutputRequest["onMeasurement"];
}): Promise<AgentPlan> {
  const prompt = buildPlanPrompt(input.request, input.context);
  const output = await input.ai.generateStructured({
    instructions: prompt.instructions,
    input: prompt.input,
    schemaName: PLAN_SCHEMA_NAME,
    schema: PLAN_JSON_SCHEMA,
    onMeasurement: input.onMeasurement,
  });
  return parseAgentPlan(output);
}
