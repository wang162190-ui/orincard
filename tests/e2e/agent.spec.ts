import crypto from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { expect, test, type APIRequestContext } from "@playwright/test";
import { MAX_PLAN_STEPS } from "../../src/server/agent/planner";
import { PLAN_RESERVED_MICRO_USD } from "../../src/server/agent/plan-run";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the agent end-to-end spec.`);
  return value;
}

interface AgentRunBody {
  readonly data: {
    readonly jobId: string;
    readonly request: string;
    readonly plan: { readonly summary: string; readonly steps: readonly { readonly tool: string }[]; readonly clarification?: string } | null;
    readonly state: string;
    readonly errorCode: string | null;
    readonly jobState: string;
  };
}

async function waitForRun(request: APIRequestContext, jobId: string): Promise<AgentRunBody["data"]> {
  for (let attempt = 0; attempt < 180; attempt += 1) {
    const response = await request.get(`/api/v1/agent?jobId=${jobId}`);
    expect(response.status(), await response.text()).toBe(200);
    const body = (await response.json()) as AgentRunBody;
    if (body.data.jobState === "succeeded") return body.data;
    if (["failed", "partial", "canceled"].includes(body.data.jobState)) {
      throw new Error(`Agent job ${jobId} ended as ${body.data.jobState}: ${body.data.errorCode ?? "unknown"}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error(`Agent job ${jobId} did not finish within three minutes.`);
}

// 需要一个在跑的 Trigger worker（`trigger dev`）：没有它，任务只会停在 pending_dispatch，
// 这条用例会以超时失败——那正是它该报的结论，不要为此放宽断言。
//
// 还有一个容易踩的前提：被测 app 的 `TRIGGER_SECRET_KEY` 必须和 worker 在**同一个 Trigger 环境**。
// `trigger dev` 只服务 dev 环境；app 若拿着 prod 密钥，run 会派进一个没有 worker 的环境，
// job 停在 `queued` 一动不动（2026-09-15 实测就是这样）。
test("T101 plans one request end to end and settles the provider call", async ({ page }) => {
  // 轮询本身允许三分钟，默认用例超时只有 30 秒——不放宽的话，先到的永远是用例超时，
  // 报出来的是「超时」而不是「任务没被消费」，把真正的结论盖掉了。
  test.setTimeout(300_000);
  const appOrigin = new URL(required("PLAYWRIGHT_BASE_URL")).origin;
  const admin = createClient(required("NEXT_PUBLIC_SUPABASE_URL"), required("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  const email = required("ORINCARD_AUTH_TEST_EMAIL");
  const password = required("ORINCARD_AUTH_TEST_PASSWORD");
  required("DEEPSEEK_API_KEY");
  required("TRIGGER_SECRET_KEY");

  await page.goto("/login");
  await page.getByLabel("Email").fill(email);
  const passwordField = page.getByLabel("Password");
  await passwordField.fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await passwordField.fill("").catch(() => undefined);
  await expect(page).toHaveURL(`${appOrigin}/`, { timeout: 30_000 });

  const runId = crypto.randomUUID();
  const submitted = await page.request.post("/api/v1/agent", {
    headers: { origin: appOrigin, "idempotency-key": `agent-e2e-${runId}` },
    data: {
      request:
        "把下面这段写成一条 Instagram 文案，再给三个后续选题：小步发布的好处是反馈来得快，问题在小范围内就暴露了。",
    },
  });
  expect(submitted.status(), await submitted.text()).toBe(202);
  const { data: accepted } = (await submitted.json()) as { data: { jobId: string; state: string } };
  expect(accepted.state).toBe("pending_dispatch");

  const run = await waitForRun(page.request, accepted.jobId);
  expect(run.state).toBe("ready");
  expect(run.errorCode).toBeNull();
  // 契约是「要么有可执行的步骤，要么说清还缺什么」；两者都合法，断死一边会随模型措辞变红。
  expect(run.plan, "a succeeded planning job must carry a plan").not.toBeNull();
  expect(run.plan!.steps.length).toBeLessThanOrEqual(MAX_PLAN_STEPS);
  expect(run.plan!.steps.length > 0 || Boolean(run.plan!.clarification?.trim())).toBe(true);
  process.stderr.write(`[agent-e2e] plan ${JSON.stringify({ summary: run.plan!.summary, steps: run.plan!.steps.map((s) => s.tool) })}\n`);

  // 一次 run 恰好一次模型调用，所以 attempt_key 的序号恒为 1。
  const attemptKey = `job:${accepted.jobId}:agent:1`;
  const sampled = await admin.rpc("server_sample_cost_attempts", { p_limit: 500 });
  expect(sampled.error).toBeNull();
  const attempts = (sampled.data ?? []) as { attempt_key: string; state: string; usage: unknown; actual_micro_usd: number | null }[];
  const attempt = attempts.find((row) => row.attempt_key === attemptKey);
  expect(attempt, `${attemptKey} is missing from private.cost_attempts`).toBeTruthy();
  expect(attempt!.state, `${attemptKey} did not settle`).toBe("settled");
  expect(attempt!.actual_micro_usd).not.toBeNull();
  expect(attempt!.actual_micro_usd!).toBeGreaterThan(0);
  // 预留是上界，不是预算目标；实测高于预留说明 PLAN_RESERVED_MICRO_USD 估小了。
  expect(attempt!.actual_micro_usd!).toBeLessThanOrEqual(PLAN_RESERVED_MICRO_USD);
  process.stderr.write(`[agent-e2e] ${attemptKey} settled at ${attempt!.actual_micro_usd} µUSD (reserved ${PLAN_RESERVED_MICRO_USD})\n`);

  // 确认这一步是用户的：规划成功不会自动续跑，执行必须是另一次显式请求。
  const executed = await page.request.post("/api/v1/agent/execute", {
    headers: { origin: appOrigin },
    data: { jobId: accepted.jobId },
  });
  expect(executed.status(), await executed.text()).toBe(202);
  const { data: execution } = (await executed.json()) as {
    data: {
      runId: string;
      state: string;
      steps: { stepIndex: number; tool: string; jobId: string; submitted: boolean }[];
      blocked: { stepIndex: number; code: string } | null;
    };
  };
  // 额度或环境预算闸住某一步是**合法结果**，不是测试失败——但已提交的步骤必须留着，
  // 而且必须有 blocked 如实说明停在哪。断言写成两者只能有一个方向，才不会把真实的闸门当成红灯。
  expect(execution.steps.length > 0 || execution.blocked, JSON.stringify(execution)).toBeTruthy();
  process.stderr.write(`[agent-e2e] execution ${JSON.stringify(execution)}\n`);

  for (const step of execution.steps) {
    const child = await admin.from("jobs").select("id,kind,parent_job_id").eq("id", step.jobId).single();
    expect(child.error).toBeNull();
    expect(child.data!.kind).toBe("tool");
    expect(child.data!.parent_job_id).toBe(accepted.jobId);
  }
  const linked = await admin.from("agent_run_steps").select("step_index,job_id").eq("run_id", execution.runId);
  expect(linked.error).toBeNull();
  expect((linked.data ?? []).length).toBe(execution.steps.length);

  // 按步幂等：再点一次执行不该产生第二批子任务。
  const repeated = await page.request.post("/api/v1/agent/execute", {
    headers: { origin: appOrigin },
    data: { jobId: accepted.jobId },
  });
  expect(repeated.status()).toBe(202);
  const { data: again } = (await repeated.json()) as { data: { steps: { jobId: string; submitted: boolean }[] } };
  expect(again.steps.map((step) => step.jobId)).toEqual(execution.steps.map((step) => step.jobId));
  expect(again.steps.every((step) => step.submitted === false)).toBe(true);
});
