import { readFile } from "node:fs/promises";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import type { CarouselDocument } from "../../src/domain/document";
import { appBaseUrl, authenticatedTest, expect, requiredEnv } from "./fixtures/authenticated";

/**
 * T099 编辑器助手验收（AC-012）。
 *
 * 三件事，一件都不用 mock：
 * 1. 真实浏览器走完「提问 → 看 diff → 确认 → 新 revision」。
 * 2. 构造一个过期的 `expectedRevision`，断言 apply 返回 409 **且源项目逐列未变**
 *    （逐列比对用 service key 直接读 public.projects 那一行，不是读 API 的投影）。
 * 3. 把额度按到零，断言这一轮被拒、**没有产生 revision**、也没有留下悬空预留。
 *
 * **这份 spec 真花钱**：每轮一次 DeepSeek 调用，带改动的那一轮另记一条 rewrite 候选
 * （1 对话 + 1 候选 = 2 个 generation 单位，见 20260916000200_copilot_turn.sql 的表头注释）。
 * 因此它有**自己的**开关，不跟着 full-product 那条不花钱的冒烟一起跑。
 * 实测花费记在 docs/acceptance/assistant.md。
 */

const runsAssistantAcceptance = process.env.ORINCARD_RUN_ASSISTANT_E2E === "1";
const test = authenticatedTest;

test.skip(!runsAssistantAcceptance, "Set ORINCARD_RUN_ASSISTANT_E2E=1 for the real AC-012 acceptance run (it spends money).");
test.describe.configure({ mode: "serial" });
test.setTimeout(5 * 60_000);

interface ProjectRow {
  readonly id: string;
  readonly owner_id: string;
  readonly revision: number;
  readonly [column: string]: unknown;
}

function adminClient(): SupabaseClient {
  return createClient(requiredEnv("NEXT_PUBLIC_SUPABASE_URL"), requiredEnv("SUPABASE_SECRET_KEY"), {
    auth: { autoRefreshToken: false, persistSession: false },
  });
}

/** 整行读回来，逐列比对用。读 API 的投影会漏掉 updated_at / state 这类不在响应里的列。 */
async function projectRow(admin: SupabaseClient, projectId: string): Promise<ProjectRow> {
  const { data, error } = await admin.from("projects").select("*").eq("id", projectId).single();
  expect(error?.message, "reading the project row").toBeUndefined();
  return data as ProjectRow;
}

async function baseDocument(): Promise<CarouselDocument> {
  return JSON.parse(
    await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8"),
  ) as CarouselDocument;
}

/**
 * 建一个云端项目给这一轮用。
 *
 * **不在 finally 里删**：jobs.project_id 是 on delete restrict，而账目行（usage_ledger、
 * private.cost_reservations）又以 restrict 挂在 jobs 上。要删掉这个项目就得先删账，
 * 而删账是一次显式的核销决定，不该由一条测试顺手做。留下的项目属于测试账号，无副作用。
 */
async function createProject(
  request: import("@playwright/test").APIRequestContext,
  origin: string,
  runId: string,
): Promise<string> {
  const response = await request.post("/api/v1/projects", {
    headers: { origin, "idempotency-key": `assistant-create-${runId}` },
    data: {
      document: await baseDocument(),
      localDraftId: `local-generated-${runId}`,
      explicitMigrationConsent: true,
    },
  });
  expect(response.status(), await response.text()).toBe(201);
  const body = (await response.json()) as { data: { projectId: string; revision: number } };
  expect(body.data.revision).toBe(1);
  return body.data.projectId;
}

interface CopilotTurn {
  readonly jobId: string;
  readonly reply: string;
  readonly proposal: {
    readonly proposalJobId: string;
    readonly projectRevision: number;
    readonly baseSlideRevision: number;
    readonly slideId: string;
    readonly before: string;
    readonly after: string;
  } | null;
}

async function ask(
  request: import("@playwright/test").APIRequestContext,
  origin: string,
  projectId: string,
  message: string,
  idempotencyKey: string,
) {
  const response = await request.post("/api/v1/copilot", {
    headers: { origin, "idempotency-key": idempotencyKey },
    data: { projectId, message },
  });
  return { response, body: (await response.json()) as { data?: CopilotTurn; error?: { code?: string } } };
}

test("asks, shows a diff, applies on confirmation and advances the revision", async ({ page }) => {
  const origin = new URL(appBaseUrl()).origin;
  const admin = adminClient();
  const runId = crypto.randomUUID();
  const projectId = await createProject(page.request, origin, runId);

  await page.goto(`/editor/${projectId}`);
  const panel = page.getByTestId("assistant-panel");
  await expect(panel, "the assistant panel is missing on a cloud project").toBeVisible();
  await expect(page.getByTestId("assistant-notice")).toHaveAttribute("data-phase", "idle");
  // 还没问之前，界面上不能有任何写入口。
  await expect(panel.getByRole("button", { name: "Accept" })).toHaveCount(0);

  await panel.locator("textarea").fill("Rewrite the title of the first slide so it is punchier. Keep it under nine words.");
  await panel.getByRole("button", { name: "Ask", exact: true }).click();

  const notice = page.getByTestId("assistant-notice");
  await expect(notice).toHaveAttribute("data-phase", "proposal", { timeout: 120_000 });
  // diff 两侧都要在，且「before」必须是项目里真实的那句话。
  const firstTitle = (await baseDocument()).slides[0]?.title;
  expect(firstTitle, "the fixture's first slide has no title to diff against").toBeTruthy();
  await expect(panel).toContainText(firstTitle!);
  await expect(panel.getByRole("button", { name: "Reject" })).toBeVisible();

  const beforeApply = await projectRow(admin, projectId);
  expect(beforeApply.revision).toBe(1);

  await panel.getByRole("button", { name: "Accept" }).click();
  await expect(notice).toHaveAttribute("data-phase", "applied", { timeout: 60_000 });

  const afterApply = await projectRow(admin, projectId);
  expect(afterApply.revision).toBe(2);
  await expect(notice).toContainText("revision 2");
  // 确认之后提议就消失了：同一条提议不能被点第二次。
  await expect(panel.getByRole("button", { name: "Accept" })).toHaveCount(0);
});

test("refuses a stale expectedRevision with 409 and leaves the project row column-for-column unchanged", async ({ page }) => {
  const origin = new URL(appBaseUrl()).origin;
  const admin = adminClient();
  const runId = crypto.randomUUID();
  const projectId = await createProject(page.request, origin, runId);

  const { response, body } = await ask(
    page.request,
    origin,
    projectId,
    "Rewrite the title of the second slide to be sharper. Keep it short.",
    `assistant-conflict-${runId}`,
  );
  expect(response.status(), JSON.stringify(body)).toBe(200);
  const proposal = body.data?.proposal;
  expect(proposal, "the model did not attach an edit to this turn; rerun or sharpen the prompt").toBeTruthy();

  const before = await projectRow(admin, projectId);

  // 构造冲突：带一个项目从未到达过的 revision 去 apply。
  const conflicted = await page.request.post(`/api/v1/projects/${projectId}/apply-proposal`, {
    headers: { origin, "idempotency-key": `assistant-conflict-apply-${runId}` },
    data: {
      proposalJobId: proposal!.proposalJobId,
      expectedRevision: before.revision + 5,
      baseSlideRevision: proposal!.baseSlideRevision,
    },
  });
  expect(conflicted.status(), await conflicted.text()).toBe(409);
  expect((await conflicted.json()).error?.code).toBe("VERSION_CONFLICT");

  // 冲突是**整条写入被拒**，不是部分写入：项目那一行逐列（含 updated_at）完全相同。
  expect(await projectRow(admin, projectId)).toEqual(before);
});

test("rejects a turn once the quota is gone, without a model call and without a revision", async ({ page }) => {
  const origin = new URL(appBaseUrl()).origin;
  const admin = adminClient();
  const runId = crypto.randomUUID();
  const projectId = await createProject(page.request, origin, runId);
  const project = await projectRow(admin, projectId);

  // 当期的 generation 桶：把 granted 压到 reserved + consumed，下一次预留就必然 quota_exceeded。
  // 这是 private.b04_begin_ai_candidate_job 真实走的那条判断，不是绕过它的旁路。
  // 选桶的条件必须与 b04 里那一句逐字同义：now 落在 [period_start, period_end)，
  // 再按 period_start desc 取第一条。少写一个 period_start 的边界就会选中另一只桶，
  // 于是「额度已按到零」是假的，而这条用例会以一个非常难读的方式绿着或红着。
  const now = new Date().toISOString();
  const { data: accounts, error } = await admin
    .from("usage_accounts")
    .select("id, granted, reserved, consumed, period_start, period_end")
    .eq("owner_id", project.owner_id)
    .eq("resource", "generation")
    .lte("period_start", now)
    .gt("period_end", now)
    .order("period_start", { ascending: false })
    .limit(1);
  expect(error?.message, "reading the generation quota bucket").toBeUndefined();
  const account = accounts?.[0] as
    | { id: string; granted: number; reserved: number; consumed: number }
    | undefined;
  expect(account, "the test account has no current generation bucket to exhaust").toBeTruthy();

  const restored = account!.granted;
  const exhausted = await admin
    .from("usage_accounts")
    .update({ granted: account!.reserved + account!.consumed })
    .eq("id", account!.id);
  expect(exhausted.error?.message, "exhausting the quota bucket").toBeUndefined();

  try {
    const reservedBefore = account!.reserved;
    const { response, body } = await ask(
      page.request,
      origin,
      projectId,
      "Rewrite the first slide title.",
      `assistant-quota-${runId}`,
    );
    expect(response.status(), JSON.stringify(body)).toBe(429);
    expect(body.error?.code).toBe("QUOTA_EXCEEDED");
    // 被拒的那一轮不产生 revision，也没有落下任何对话轮——预留在模型之前就失败了。
    expect((await projectRow(admin, projectId)).revision).toBe(1);
    const turns = await admin.from("copilot_turns").select("id").eq("project_id", projectId);
    expect(turns.data ?? []).toEqual([]);
    // 也没有留下悬空预留：被拒的那一轮 reserved 一动不动。
    // 这里断言账上的数字，而不是「再问一轮看看还能不能问」——后者取决于这个共享开发账号
    // 当月还剩多少额度，跑到月底就会以一个与本用例无关的理由变红。
    const after = await admin
      .from("usage_accounts")
      .select("reserved")
      .eq("id", account!.id)
      .single();
    expect(after.error?.message, "re-reading the quota bucket").toBeUndefined();
    expect((after.data as { reserved: number }).reserved).toBe(reservedBefore);
  } finally {
    // 额度必须还回去：这是共享的开发账号，不能让一条测试把它按死在零。
    const rollback = await admin.from("usage_accounts").update({ granted: restored }).eq("id", account!.id);
    expect(rollback.error?.message, "restoring the quota bucket").toBeUndefined();
  }
});
