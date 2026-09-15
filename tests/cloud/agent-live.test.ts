import { describe, expect, it } from "vitest";
import { createDeepSeekResponsesAdapter, createDeepSeekResponsesClient, type ProviderMeasurement } from "../../src/server/ai";
import { runPlan, PLAN_RESERVED_MICRO_USD } from "../../src/server/agent/plan-run";
import { MAX_PLAN_STEPS, planTools } from "../../src/server/agent/planner";
import { priceMeasurements } from "../../src/server/cost";

// 规划器的形状由 Zod 在本地守着，但「模型真的会照这份 schema 产出一份可执行的计划」
// 只能真的调一次供应商证明——而且这次调用同时把 PLAN_RESERVED_MICRO_USD 的估算拿去对账。
// 计费：一次结构化调用，估算上界 7,000 µUSD ≈ $0.007。默认跳过，靠 ORINCARD_RUN_AGENT_CLOUD=1 开启。
const live = process.env.ORINCARD_RUN_AGENT_CLOUD === "1";

describe.skipIf(!live)("live agent planning", () => {
  it("turns one request into a schema-valid plan within the reserved budget", async () => {
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    expect(apiKey, "DEEPSEEK_API_KEY is required for the live agent test").toBeTruthy();
    const ai = createDeepSeekResponsesAdapter(createDeepSeekResponsesClient(apiKey!));

    const measurements: ProviderMeasurement[] = [];
    const plan = await runPlan({
      ai,
      // 需求自带素材：引用「这篇内容」而素材不在载荷里时，模型会（正确地）返回零步 + clarification。
      request:
        "把下面这段写成一条 Instagram 文案，再给三个后续选题：小步发布的好处是反馈来得快，问题在小范围内就暴露了。",
      onMeasurement: async (measurement) => {
        measurements.push(measurement);
      },
    });

    // 契约是「要么有可执行的步骤，要么说清还缺什么」——两者都是合法产出，断死一边会让这个
    // 测试随模型措辞变红。步数上界则是硬的：超限直接是钱。
    expect(plan.steps.length).toBeLessThanOrEqual(MAX_PLAN_STEPS);
    expect(plan.steps.length > 0 || Boolean(plan.clarification?.trim())).toBe(true);
    // vitest 会吞掉通过用例的 console 输出，成本数字必须看得见，所以直接写 stderr。
    process.stderr.write(`[agent-live] plan ${JSON.stringify({ summary: plan.summary, tools: planTools(plan), clarification: plan.clarification ?? null })}\n`);

    // 供应商回报了用量才谈得上对账；没回报就不估算、不补零，与结算路径同口径。
    const priced = priceMeasurements(measurements, new Date());
    if (priced) {
      process.stderr.write(`[agent-live] actual ${priced.actualMicroUsd} µUSD vs reserved ${PLAN_RESERVED_MICRO_USD}\n`);
      expect(priced.actualMicroUsd).toBeLessThanOrEqual(PLAN_RESERVED_MICRO_USD);
    } else {
      process.stderr.write("[agent-live] provider reported no usage; cost reconciliation not exercised\n");
    }
  }, 120_000);
});
