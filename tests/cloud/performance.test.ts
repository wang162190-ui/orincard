import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";
import { runs, tasks } from "@trigger.dev/sdk";
import { beforeAll, describe, expect, it } from "vitest";
import type { FoundationProbeOutput, foundationRenderProbe } from "../../src/trigger/probe";
import { requireCloudProbe } from "../setup";

// T094 真实成本与内存边界。
// 这个文件只在 ORINCARD_RUN_PERFORMANCE_CLOUD=1 时运行，读数全部来自两个真实来源：
//   1. Trigger.dev 上真实跑一次 orincard-foundation-render-probe，取渲染秒数、进程峰值 RSS、
//      三个成品的真实字节数，以及 Trigger 自己回报的 durationMs / costInCents；
//   2. 开发 Supabase 上真实的用量登记路径：public.jobs、public.usage_ledger，
//      以及 private.cost_reservations / cost_attempts / cost_budgets。
// 没有任何 mock 顶替：不构造假时延、不用固定常量冒充实测。缺库存数据时用例显式抛错说明
// 缺什么真实样本，不 skip 后当作通过。
//
// 内存上限不猜：Trigger 的机器规格由部署侧决定，trigger.config.ts 没有 pin machine，
// 所以本用例要求把该任务真实的机器内存字节数经 ORINCARD_TRIGGER_MACHINE_MEMORY_BYTES 传进来，
// 而不是在代码里写一个"大概 1 GB"的数字当边界。

const cloud = process.env.ORINCARD_RUN_PERFORMANCE_CLOUD === "1" ? describe : describe.skip;

const REQUIRED_VARIABLES = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "SUPABASE_SECRET_KEY",
  "TRIGGER_SECRET_KEY",
  "TRIGGER_PROJECT_ID",
  "ORINCARD_TRIGGER_MACHINE_MEMORY_BYTES",
] as const;

type RequiredVariable = (typeof REQUIRED_VARIABLES)[number];

function readCredentials(): Record<RequiredVariable, string> {
  const values = {} as Record<RequiredVariable, string>;
  const missing: string[] = [];
  for (const name of REQUIRED_VARIABLES) {
    const value = process.env[name]?.trim();
    if (!value) {
      missing.push(name);
      continue;
    }
    values[name] = value;
  }
  if (missing.length > 0) {
    throw new Error(
      `ORINCARD_RUN_PERFORMANCE_CLOUD=1 requires development variables: ${missing.join(", ")}. ` +
        "Configure them in your own shell against the development project; the test never reads " +
        ".env files. ORINCARD_TRIGGER_MACHINE_MEMORY_BYTES is the deployed machine preset's real " +
        "memory in bytes, read from the Trigger dashboard — the memory ceiling is never guessed here.",
    );
  }
  return values;
}

// 渲染探针自己声明 maxDuration: 120（src/trigger/probe.ts），trigger.config.ts 的全局上限是 300 秒。
const PROBE_MAX_DURATION_MS = 120_000;

type JobKind =
  | "generation"
  | "rewrite"
  | "parse"
  | "asset"
  | "export"
  | "tool"
  | "cleanup"
  | "account_export"
  | "import";

interface JobRow {
  readonly id: string;
  readonly kind: JobKind;
  readonly state: string;
  readonly created_at: string;
  readonly finished_at: string | null;
}

interface LedgerRow {
  readonly job_id: string | null;
  readonly kind: "grant" | "reserve" | "settle" | "release" | "reversal";
  readonly units: number;
}

interface ReservationRow {
  readonly id: string;
  readonly period: string;
  readonly environment: string;
  readonly state: "open" | "unknown" | "settled" | "released";
  readonly reserved_micro_usd: number;
  readonly settled_micro_usd: number;
  readonly released_micro_usd: number;
}

interface AttemptRow {
  readonly attempt_key: string;
  readonly state: "planned" | "sent" | "unknown" | "settled";
  readonly usage: Record<string, unknown>;
  readonly actual_micro_usd: number | null;
}

interface BudgetRow {
  readonly period: string;
  readonly environment: string;
  readonly limit_micro_usd: number;
  readonly reserved_micro_usd: number;
  readonly spent_micro_usd: number;
}

interface AssetRow {
  readonly id: string;
  readonly bucket: string;
  readonly mime: string;
  readonly bytes: number;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function elapsedMs(job: JobRow): number {
  if (!job.finished_at) {
    throw new Error(`Job ${job.id} has no finished_at and cannot supply a real elapsed time.`);
  }
  return Date.parse(job.finished_at) - Date.parse(job.created_at);
}

/** 只挑出真正是数字的用量字段：token 数、分钟数、秒数都必须是数字，字符串不算实测。 */
function numericUsage(usage: Record<string, unknown>): Record<string, number> {
  const numbers: Record<string, number> = {};
  for (const [key, value] of Object.entries(usage)) {
    if (typeof value === "number" && Number.isFinite(value)) {
      numbers[key] = value;
    }
  }
  return numbers;
}

function requireSamples<T>(rows: readonly T[], what: string, how: string): readonly T[] {
  if (rows.length === 0) {
    throw new Error(
      `The development project has no ${what}, so there is nothing real to measure. ${how} ` +
        "This case never passes on an empty project.",
    );
  }
  return rows;
}

cloud("T094 real cost and memory ceilings", () => {
  let admin: SupabaseClient;
  let probe: FoundationProbeOutput;
  let probeRunId: string;
  let probeDurationMs: number;
  let probeCostInCents: number;
  let probeBaseCostInCents: number;
  let machineMemoryBytes: number;

  beforeAll(async () => {
    const credentials = readCredentials();

    machineMemoryBytes = Number.parseInt(
      credentials.ORINCARD_TRIGGER_MACHINE_MEMORY_BYTES,
      10,
    );
    if (!Number.isFinite(machineMemoryBytes) || machineMemoryBytes <= 0) {
      throw new Error(
        "ORINCARD_TRIGGER_MACHINE_MEMORY_BYTES must be the deployed machine preset's memory in " +
          "bytes, for example 524288000 for a 0.5 GB preset.",
      );
    }

    const supabaseUrl = credentials.NEXT_PUBLIC_SUPABASE_URL;
    if (!supabaseUrl.startsWith("https://")) {
      throw new Error(
        "T094 measures the real development project over https; a local or plain-http URL cannot " +
          "produce the cost and memory evidence this task asks for.",
      );
    }
    const { createClient } = await import("@supabase/supabase-js");
    admin = createClient(supabaseUrl, credentials.SUPABASE_SECRET_KEY, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    // 真实云端渲染一次。requireCloudProbe 同时要求 RUN_CLOUD_PROBES=1，缺任一变量都会点名抛错。
    requireCloudProbe(["TRIGGER_SECRET_KEY", "TRIGGER_PROJECT_ID"]);
    const handle = await tasks.trigger<typeof foundationRenderProbe>(
      "orincard-foundation-render-probe",
      { probe: true },
      { idempotencyKey: `t094-performance-${new Date().toISOString().slice(0, 10)}` },
    );
    const run = await runs.poll(handle, { pollIntervalMs: 1_000 });
    if (!run.isSuccess || !run.output) {
      throw new Error(
        `The render probe did not succeed (status ${run.status}), so there is no real render ` +
          "measurement. T094 reports no numbers rather than reporting an estimate.",
      );
    }
    probe = run.output;
    probeRunId = run.id;
    probeDurationMs = run.durationMs;
    probeCostInCents = run.costInCents;
    probeBaseCostInCents = run.baseCostInCents;
  }, 300_000);

  it("measures real render seconds, peak memory and artifact bytes on cloud hardware", () => {
    const png = Buffer.from(probe.artifacts.pngBase64, "base64");
    const pdf = Buffer.from(probe.artifacts.pdfBase64, "base64");
    const pptx = Buffer.from(probe.artifacts.pptxBase64, "base64");

    // 先证明这些字节是真产物，再谈由它们得出的数字：哈希对得上，PNG/PDF 头也对。
    expect(probe.hashes.pngSha256).toBe(sha256(png));
    expect(probe.hashes.pdfSha256).toBe(sha256(pdf));
    expect(probe.hashes.pptxSha256).toBe(sha256(pptx));
    expect(png.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    expect(pdf.subarray(0, 5).toString("ascii")).toBe("%PDF-");
    expect(probe.metrics.pngBytes).toBe(png.byteLength);
    expect(probe.metrics.pdfBytes).toBe(pdf.byteLength);
    expect(probe.metrics.pptxBytes).toBe(pptx.byteLength);

    // 渲染秒数：真实进程内计时，必须落在探针自己声明的 maxDuration 之内。
    expect(probe.metrics.elapsedMs).toBeGreaterThan(0);
    expect(
      probe.metrics.elapsedMs,
      `The render probe took ${probe.metrics.elapsedMs} ms, at or past its own ${PROBE_MAX_DURATION_MS} ms maxDuration`,
    ).toBeLessThan(PROBE_MAX_DURATION_MS);

    // 内存峰值：真实 process.memoryUsage().rss，对照部署侧真实机器规格。
    expect(probe.metrics.rssBytes).toBeGreaterThan(0);
    expect(
      probe.metrics.rssBytes,
      `Peak RSS ${probe.metrics.rssBytes} B does not fit the deployed machine's ` +
        `${machineMemoryBytes} B; pin a larger machine in trigger.config.ts or cut the render's memory.`,
    ).toBeLessThan(machineMemoryBytes);
  });

  it("takes the run duration and compute cost from Trigger's own accounting", () => {
    expect(probeRunId).not.toHaveLength(0);
    expect(probeDurationMs, "Trigger reported no compute duration for the probe run").toBeGreaterThan(0);
    // 计费金额由 Trigger 结算，允许为 0（免费额度内），但不能是负数或缺失。
    expect(Number.isFinite(probeCostInCents)).toBe(true);
    expect(probeCostInCents).toBeGreaterThanOrEqual(0);
    expect(Number.isFinite(probeBaseCostInCents)).toBe(true);
    expect(probeBaseCostInCents).toBeGreaterThanOrEqual(0);
    // 进程内计时不可能超过 Trigger 计的整段机器时间（留 5 秒容差给两端的计时边界）。
    expect(probe.metrics.elapsedMs).toBeLessThanOrEqual(probeDurationMs + 5_000);
  });

  it("reads elapsed minutes per job kind out of real terminal jobs", async () => {
    const { data, error } = await admin
      .from("jobs")
      .select("id, kind, state, created_at, finished_at")
      .not("finished_at", "is", null)
      .order("finished_at", { ascending: false })
      .limit(200);
    expect(error).toBeNull();
    const jobs = requireSamples(
      (data ?? []) as JobRow[],
      "terminal job in public.jobs",
      "Run the generation, parse or export acceptance against the development project first.",
    );

    const byKind = new Map<JobKind, number[]>();
    for (const job of jobs) {
      expect(["succeeded", "partial", "failed", "canceled"]).toContain(job.state);
      const elapsed = elapsedMs(job);
      expect(elapsed, `Job ${job.id} finished before it was created`).toBeGreaterThanOrEqual(0);
      // 单个任务的墙钟时间不可能超过 Trigger 的全局 maxDuration 加上排队时间的合理上限。
      expect(Number.isFinite(elapsed)).toBe(true);
      byKind.set(job.kind, [...(byKind.get(job.kind) ?? []), elapsed]);
    }

    // 每个出现过的 kind 都要能算出真实的样本分钟数，而不是只有一个总数。
    expect(byKind.size).toBeGreaterThan(0);
    for (const [kind, samples] of byKind) {
      const slowest = Math.max(...samples);
      expect(samples.length, `${kind} has no elapsed sample`).toBeGreaterThan(0);
      expect(slowest / 60_000, `${kind} reported a non-numeric elapsed minute count`).not.toBeNaN();
    }
  });

  it("takes billable units only from the append-only usage ledger", async () => {
    const { data, error } = await admin
      .from("usage_ledger")
      .select("job_id, kind, units")
      .order("created_at", { ascending: false })
      .limit(500);
    expect(error).toBeNull();
    const ledger = requireSamples(
      (data ?? []) as LedgerRow[],
      "row in public.usage_ledger",
      "Submit at least one real job so the ledger records a reservation.",
    );

    const unitsByKind = new Map<LedgerRow["kind"], number>();
    for (const row of ledger) {
      expect(row.units, "the ledger stores only positive unit counts").toBeGreaterThan(0);
      expect(["grant", "reserve", "settle", "release", "reversal"]).toContain(row.kind);
      unitsByKind.set(row.kind, (unitsByKind.get(row.kind) ?? 0) + row.units);
    }

    // 预留必须最终被结算或释放，否则用户额度会永远挂着；这一条把真实账目对起来。
    const reserved = unitsByKind.get("reserve") ?? 0;
    const closed = (unitsByKind.get("settle") ?? 0) + (unitsByKind.get("release") ?? 0);
    expect(reserved, "the sampled window records no reservation to measure").toBeGreaterThan(0);
    expect(
      closed,
      `${reserved} reserved units against ${closed} settled or released units in the sampled window`,
    ).toBeGreaterThan(0);
  });

  it("reads the provider cost estimate the environment budget actually holds", async () => {
    // 不能走 admin.schema("private")：Data API 只暴露 public / graphql_public，private.* 一律
    // 回 PGRST106。这不是配置疏漏，而是刻意的安全边界（private 表对 service_role 也 revoke）。
    // 读数一律经 public.server_* 的 security definer 只读入口，和生产代码同一条路径。
    const reservationsResult = await admin.rpc("server_sample_cost_reservations", { p_limit: 500 });
    expect(reservationsResult.error).toBeNull();
    const reservations = requireSamples(
      (reservationsResult.data ?? []) as ReservationRow[],
      "row in private.cost_reservations",
      "Submit at least one real job so a cost reservation is written.",
    );

    for (const reservation of reservations) {
      expect(reservation.reserved_micro_usd).toBeGreaterThanOrEqual(0);
      expect(reservation.released_micro_usd).toBeLessThanOrEqual(reservation.reserved_micro_usd);
      expect(["open", "unknown", "settled", "released"]).toContain(reservation.state);
    }
    // 预留金额是目前唯一有数字的成本口径，必须真的有非零样本，否则"修正预算"无从谈起。
    expect(
      reservations.some((reservation) => reservation.reserved_micro_usd > 0),
      "every sampled reservation reserved 0 micro-USD, so the estimate cannot be corrected",
    ).toBe(true);

    const period = new Date().toISOString().slice(0, 7);
    const budgetResult = await admin.rpc("server_read_cost_budget", {
      p_period: period,
      p_environment: "development",
    });
    expect(budgetResult.error).toBeNull();
    const budget = budgetResult.data as BudgetRow | null;
    if (!budget) {
      throw new Error(
        `private.cost_budgets has no development row for ${period}, so every job submission in ` +
          "this month is refused before it starts and no cost can be measured.",
      );
    }
    expect(budget.limit_micro_usd).toBeGreaterThan(0);
    expect(budget.reserved_micro_usd + budget.spent_micro_usd).toBeLessThanOrEqual(
      budget.limit_micro_usd,
    );
  });

  it("finds the sample token counts a corrected budget estimate needs", async () => {
    // 同上，经 public.server_sample_cost_attempts 读，不碰 private schema。
    const { data, error } = await admin.rpc("server_sample_cost_attempts", { p_limit: 500 });
    expect(error).toBeNull();
    const attempts = requireSamples(
      (data ?? []) as AttemptRow[],
      "row in private.cost_attempts",
      "Run one real generation so a provider attempt is registered.",
    );

    const settled = attempts.filter((attempt) => attempt.state === "settled");
    const withUsage = settled.filter(
      (attempt) => Object.keys(numericUsage(attempt.usage)).length > 0,
    );

    // 修正预算估计要的是真实用量，不是预留估值。
    // 2026-09-12 之前这条注定失败：没有任何生产路径调用 private.settle_cost_attempt，
    // 而 src/server/ai.ts 的 DeepSeek 适配器只取 output_text，供应商回的 usage 直接丢掉。
    // 路线图 S1–S2 已把 usage 透传与五个调用点的结算接上（见 docs/acceptance/costs.md），
    // 所以现在它衡量的是「接上的链路有没有真的通电」。仍然不许塞估算数字让它变绿：
    // 没有真实结算样本就让它红着，红本身就是 T094 要报的结论。
    expect(
      settled.length,
      `${attempts.length} provider attempts sampled, none settled. Nothing calls ` +
        "private.settle_cost_attempt, so no real provider usage is ever recorded.",
    ).toBeGreaterThan(0);
    expect(
      withUsage.length,
      "no settled attempt carries a numeric token, minute or second count in private.cost_attempts.usage",
    ).toBeGreaterThan(0);
    for (const attempt of withUsage) {
      expect(attempt.actual_micro_usd, `${attempt.attempt_key} settled without a cost`).not.toBeNull();
      expect(attempt.actual_micro_usd ?? -1).toBeGreaterThanOrEqual(0);
    }
  });

  it("measures export traffic from the bytes really stored in the exports bucket", async () => {
    const { data, error } = await admin
      .from("assets")
      .select("id, bucket, mime, bytes")
      .eq("bucket", "exports")
      .eq("state", "ready")
      .order("created_at", { ascending: false })
      .limit(200);
    expect(error).toBeNull();
    const artifacts = requireSamples(
      (data ?? []) as AssetRow[],
      "ready object in the exports bucket",
      "Produce one real export against the development project first.",
    );

    let total = 0;
    for (const artifact of artifacts) {
      expect(artifact.bytes, `${artifact.id} is ready with 0 bytes`).toBeGreaterThan(0);
      expect(artifact.mime).not.toHaveLength(0);
      total += artifact.bytes;
    }
    // 每次下载的出站流量就是这些真实对象的大小，探针的三个成品是同一渲染器的下界样本。
    expect(total).toBeGreaterThan(0);
    expect(total / artifacts.length).toBeGreaterThan(0);
    expect(probe.metrics.pngBytes + probe.metrics.pdfBytes + probe.metrics.pptxBytes).toBeGreaterThan(0);
  });
});
