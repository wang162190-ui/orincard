import { describe, expect, it } from "vitest";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { parseToolRequest } from "../../src/domain/tools";
import { createEntitlementProvisioner } from "../../src/server/billing/entitlement-grant";
import { readServerEnvironment } from "../../src/server/environment";
import { createSupabaseJobStore, dispatchPendingJob } from "../../src/server/jobs";
import { createSupabaseToolSubmissionStore, createToolJobService } from "../../src/app/api/v1/tools/[tool]/route";
import { resolveTriggerDispatcher } from "../../src/trigger/dispatch";

/**
 * `/api/v1/tools/[tool]` 曾经用 `admin.from("jobs").upsert()` 直接建 job，绕开
 * `server_submit_job`，于是 `private.cost_reservations` 里没有任何行，worker 走到
 * `private.register_cost_attempt` 必然 22023 `open cost reservation not found`。
 *
 * 预留住在 `private` schema，Data API 一律回 PGRST106，查不到——所以这里不去查那张表，
 * 而是让 worker 真的跑完：跑到 `succeeded` 就说明它真的找到了一笔开着的预留。
 *
 * 计费：一次真实的文本工具调用，实测约 1,100 µUSD ≈ $0.0011。默认跳过。
 * 前提：`trigger dev` worker 在跑，且 app 的 TRIGGER_SECRET_KEY 与它同一个 Trigger 环境。
 */
const live = process.env.ORINCARD_RUN_TOOL_CLOUD === "1";
const OWNER_ID = process.env.ORINCARD_TOOL_CLOUD_OWNER_ID ?? "";

function liveService(admin: SupabaseClient) {
  return createToolJobService({
    store: createSupabaseToolSubmissionStore(admin),
    requestHashSecret: process.env.SUPABASE_SECRET_KEY!,
    environment: process.env.APP_ENVIRONMENT ?? "development",
    ensureEntitlements: createEntitlementProvisioner({
      client: admin,
      appEnvironment: readServerEnvironment(process.env).appEnvironment,
      rawPolicy: process.env.BILLING_POLICY_JSON,
    }),
    dispatch: async (jobId, requestId) => {
      await dispatchPendingJob(createSupabaseJobStore(admin), resolveTriggerDispatcher("tool"), jobId, requestId);
    },
  });
}

async function settleJob(admin: SupabaseClient, jobId: string) {
  type JobRow = { state: string; error_code: string | null; result_ref: Record<string, unknown> | null };
  const deadline = Date.now() + 110_000;
  let job: JobRow | null = null;
  while (Date.now() < deadline) {
    const polled = await admin.from("jobs").select("state,error_code,result_ref").eq("id", jobId).maybeSingle();
    job = (polled.data ?? null) as JobRow | null;
    if (job && ["succeeded", "failed", "canceled"].includes(job.state)) break;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return job;
}

describe.skipIf(!live)("live tool submission", () => {
  it("reserves cost through server_submit_job so the worker can settle its attempt", async () => {
    expect(OWNER_ID, "ORINCARD_TOOL_CLOUD_OWNER_ID is required").toBeTruthy();
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false },
    });

    const before = await admin
      .from("usage_accounts")
      .select("reserved,consumed,granted")
      .eq("owner_id", OWNER_ID)
      .eq("resource", "generation")
      .maybeSingle();

    // 预留是钱。收尾无条件翻 'unknown' 的话，每跑一次这个数就 +1 且永不回落——
    // S6 头注里量到过 18 条 / $1.223 卡死的后果。
    const unsettledBefore = await admin.rpc("server_count_unsettled_reservations", {
      p_before: new Date(Date.now() + 60_000).toISOString(),
    });

    const service = liveService(admin);

    const request = parseToolRequest("caption", {
      input: { text: "小步发布的好处是反馈来得快，问题在小范围内就暴露了。" },
    });
    const submitted = await service.submit(OWNER_ID, request, `live-tool-${Date.now()}`, "live-probe");
    process.stderr.write(`[tool-live] job ${submitted.jobId} state ${submitted.state}\n`);
    expect(submitted.jobId).toBeTruthy();

    // 额度真的被预留了——旧路径连这一步都没有。
    const after = await admin
      .from("usage_accounts")
      .select("reserved,consumed,granted")
      .eq("owner_id", OWNER_ID)
      .eq("resource", "generation")
      .maybeSingle();
    process.stderr.write(`[tool-live] usage ${JSON.stringify(before.data)} -> ${JSON.stringify(after.data)}\n`);
    expect(after.data).toBeTruthy();

    const job = await settleJob(admin, submitted.jobId);
    process.stderr.write(`[tool-live] final ${JSON.stringify({ state: job?.state, errorCode: job?.error_code })}\n`);
    // 这就是回归断言：旧路径在这里是 failed / 22023。
    expect(job?.error_code ?? null).toBeNull();
    expect(job?.state).toBe("succeeded");

    // 收尾也必须结账：worker 从前用裸 UPDATE 标成功，reserved 里那一个单位永远不还。
    const settled = await admin
      .from("usage_accounts")
      .select("reserved,consumed,granted")
      .eq("owner_id", OWNER_ID)
      .eq("resource", "generation")
      .maybeSingle();
    process.stderr.write(`[tool-live] settled ${JSON.stringify(settled.data)}\n`);
    expect(settled.data?.reserved).toBe(before.data?.reserved ?? 0);
    expect(settled.data?.consumed).toBe((before.data?.consumed ?? 0) + 1);

    // 成本预留也必须落地：worker 在 finally 里报过实测用量，收尾就该精确结算而不是兜底。
    const unsettledAfter = await admin.rpc("server_count_unsettled_reservations", {
      p_before: new Date(Date.now() + 60_000).toISOString(),
    });
    process.stderr.write(`[tool-live] unsettled ${unsettledBefore.data} -> ${unsettledAfter.data}\n`);
    expect(unsettledAfter.error).toBeNull();
    expect(unsettledAfter.data).toBe(unsettledBefore.data);
  }, 120_000);

  // `count` 从前在 `toTextWorkerRequest` 里被静默丢掉：要 3 条、回 5 条。单测能证明
  // 约束进了 JSON Schema，只有真跑一次才能证明供应商照它出数。
  it("returns exactly the requested number of post ideas", async () => {
    expect(OWNER_ID, "ORINCARD_TOOL_CLOUD_OWNER_ID is required").toBeTruthy();
    const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SECRET_KEY!, {
      auth: { persistSession: false },
    });
    const request = parseToolRequest("post-ideas", {
      input: { topic: "小步发布", count: 3, instructions: "每条角度要具体可执行。" },
    });
    const submitted = await liveService(admin).submit(OWNER_ID, request, `live-count-${Date.now()}`, "live-probe");
    const job = await settleJob(admin, submitted.jobId);
    const ideas = (job?.result_ref as { candidate?: { payload?: { ideas?: unknown[] } } } | null)?.candidate?.payload?.ideas;
    process.stderr.write(`[tool-live] ideas ${JSON.stringify({ state: job?.state, errorCode: job?.error_code, count: ideas?.length })}\n`);
    expect(job?.state).toBe("succeeded");
    expect(ideas).toHaveLength(3);
  }, 120_000);
});
