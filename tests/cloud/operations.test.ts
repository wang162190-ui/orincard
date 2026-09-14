import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertProviderBudget, BudgetCircuitOpenError, verifyReconciler, type OperationalEvent } from "../../src/server/observability";
import { createSupabaseRetentionStore, runRetentionMaintenance, type RetentionStore } from "../../src/trigger/retention";

function logger(events: OperationalEvent[]) { return { emit: vi.fn(async (event: OperationalEvent) => { events.push(event); }) }; }

// 这个替身模拟 Data API 的真实行为，而不是一个什么都答应的 mock：
// 暴露的 schema 只有 public / graphql_public，任何 client.schema("private") 的查询都回 PGRST106。
// 巡检原先正是踩在这上面，从上线第一天起一次都没成功执行过；而全 mock 的用例看不见这件事。
function dataApiClient(input: { readonly staleJobs: number; readonly unsettled: number }) {
  function chain(result: unknown) {
    const node: Record<string, unknown> = {};
    for (const key of ["from", "select", "in", "lt", "not", "neq", "limit", "eq", "update"]) node[key] = () => node;
    node.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve);
    return node;
  }
  const rpc = vi.fn(async () => ({ data: input.unsettled, error: null }));
  const client = {
    from: vi.fn(() => chain({ count: input.staleJobs, error: null })),
    schema: vi.fn(() => chain({ count: null, error: { code: "PGRST106", message: "Invalid schema: private" } })),
    rpc,
  } as unknown as SupabaseClient;
  return { client, rpc, schema: client.schema as unknown as ReturnType<typeof vi.fn> };
}

describe("provider budget observability", () => {
  it("warns at 80 percent without opening the circuit", async () => {
    const events: OperationalEvent[] = [];
    await expect(assertProviderBudget({ spent: 75, reserved: 5, limit: 100 }, logger(events))).resolves.toMatchObject({ state: "warning", ratio: 0.8 });
    expect(events).toEqual([{ code: "budget.warning", resource: "provider_cost", ratio: 0.8 }]);
  });

  it("fails closed at 100 percent", async () => {
    const events: OperationalEvent[] = [];
    await expect(assertProviderBudget({ spent: 90, reserved: 10, limit: 100 }, logger(events))).rejects.toBeInstanceOf(BudgetCircuitOpenError);
    expect(events[0]?.code).toBe("budget.circuit_open");
  });
});

it("removes expired source and export objects and re-verifies the reconciler", async () => {
  const events: OperationalEvent[] = [];
  const expire = vi.fn(async () => undefined); const removeObject = vi.fn(async () => undefined); const reconcile = vi.fn(async () => ({ checked: 2 }));
  const store: RetentionStore = {
    listExpired: vi.fn(async (kind) => [{ id: `${kind}-1`, kind, assetId: `${kind}-asset`, bucket: kind === "source" ? "uploads" : "exports", objectKey: `owner/${kind}-1/file` }]),
    expire, removeObject,
    readBudget: vi.fn(async () => ({ limit: 100, reserved: 5, spent: 10 })),
    reconciliationHealth: vi.fn(async () => ({ staleJobs: 0, unsettledReservations: 0 })),
  };
  const result = await runRetentionMaintenance({ store, reconcile, logger: logger(events), now: () => new Date("2026-09-10T00:00:00Z"), environment: "development" });
  expect(result.removed).toEqual({ source: 1, export: 1 });
  expect(removeObject).toHaveBeenCalledTimes(2); expect(expire).toHaveBeenCalledTimes(2); expect(reconcile).toHaveBeenCalledOnce();
  expect(store.readBudget).toHaveBeenCalledWith("2026-09", "development");
  expect(events.at(-1)).toEqual({ code: "reconciler.verified", resource: "jobs", count: 0 });
  expect(JSON.stringify(events)).not.toMatch(/body|prompt|transcript|content/i);
});

// 80% 告警此前只存在于 observability.ts 里，全仓无人调用。这两条锁住它真的接在每小时巡检上。
describe("T086 budget alarm wired into the hourly maintenance pass", () => {
  function store(budget: { limit: number; reserved: number; spent: number } | null): RetentionStore {
    return {
      listExpired: vi.fn(async () => []),
      expire: vi.fn(async () => undefined),
      removeObject: vi.fn(async () => undefined),
      readBudget: vi.fn(async () => budget),
      reconciliationHealth: vi.fn(async () => ({ staleJobs: 0, unsettledReservations: 0 })),
    };
  }

  it("emits the 80 percent warning without stopping the pass", async () => {
    const events: OperationalEvent[] = [];
    const result = await runRetentionMaintenance({
      store: store({ limit: 10_000_000, reserved: 500_000, spent: 8_000_000 }),
      reconcile: async () => undefined, logger: logger(events),
      now: () => new Date("2026-09-12T00:00:00Z"), environment: "development",
    });
    expect(result.budget).toMatchObject({ state: "warning" });
    expect(events).toContainEqual({ code: "budget.warning", resource: "provider_cost", ratio: 0.85 });
    // 告警不是熔断：到期清理与对账巡检照常走完。
    expect(events.at(-1)).toEqual({ code: "reconciler.verified", resource: "jobs", count: 0 });
  });

  it("opens the circuit at 100 percent and when the budget row is missing", async () => {
    const exhausted: OperationalEvent[] = [];
    await expect(runRetentionMaintenance({
      store: store({ limit: 10_000_000, reserved: 2_000_000, spent: 8_000_000 }),
      reconcile: async () => undefined, logger: logger(exhausted),
      now: () => new Date("2026-09-12T00:00:00Z"), environment: "development",
    })).rejects.toBeInstanceOf(BudgetCircuitOpenError);
    expect(exhausted.at(-1)).toMatchObject({ code: "budget.circuit_open", ratio: 1 });

    // 查不到预算行按熔断处理，和 SQL 侧 budget.period is null 直接拒绝预留保持一致。
    const missing: OperationalEvent[] = [];
    await expect(runRetentionMaintenance({
      store: store(null), reconcile: async () => undefined, logger: logger(missing),
      now: () => new Date("2026-09-12T00:00:00Z"), environment: "development",
    })).rejects.toBeInstanceOf(BudgetCircuitOpenError);
  });
});

describe("T086 reconciliation health over the Data API", () => {
  it("counts unsettled reservations through the public RPC instead of the private schema", async () => {
    const { client, rpc, schema } = dataApiClient({ staleJobs: 2, unsettled: 7 });
    const before = "2026-09-12T00:00:00.000Z";

    await expect(createSupabaseRetentionStore(client).reconciliationHealth(before)).resolves.toEqual({
      staleJobs: 2,
      unsettledReservations: 7,
    });
    expect(rpc).toHaveBeenCalledWith("server_count_unsettled_reservations", { p_before: before });
    // 碰一下 private schema 就说明这条读法回到了 PGRST106 的老路上。
    expect(schema).not.toHaveBeenCalled();
  });

  it("surfaces the PGRST106 error instead of silently reporting a healthy zero", async () => {
    const { client } = dataApiClient({ staleJobs: 0, unsettled: 0 });
    (client.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: null,
      error: { code: "PGRST106", message: "Invalid schema: private" },
    });

    // 巡检读不到数就必须炸，不能把「读失败」和「没有卡死预留」混成同一个 0。
    await expect(
      createSupabaseRetentionStore(client).reconciliationHealth("2026-09-12T00:00:00.000Z"),
    ).rejects.toMatchObject({ code: "PGRST106" });
  });
});

it("fails a reconciler verification while logging counts only", async () => {
  const events: OperationalEvent[] = [];
  await expect(verifyReconciler({ run: async () => undefined, inspect: async () => ({ staleJobs: 1, unsettledReservations: 2 }) }, logger(events))).rejects.toThrow("RECONCILER_UNHEALTHY");
  expect(events).toEqual([{ code: "reconciler.unhealthy", resource: "jobs", count: 3 }]);
});

// --- T086 真实开发云验收 -----------------------------------------------------------------------
// 上面的用例全部是替身。T086 的 Expect 要的是真的跑一次到期清理与对账巡检，所以这一段直连
// 开发 Supabase，只在 ORINCARD_RUN_OPERATIONS_CLOUD=1 时运行，且只读 + 只清真正到期的行。
// 不碰生产：SUPABASE_PRODUCTION_PROJECT_REF 在本机故意不设置，指向哪里由 .env.local 决定。
const operationsCloud = process.env.ORINCARD_RUN_OPERATIONS_CLOUD === "1" ? describe : describe.skip;

operationsCloud("T086 retention and reconciliation against the development project", () => {
  it("runs the real maintenance pass and reports reconciliation honestly", async () => {
    const { createClient } = await import("@supabase/supabase-js");
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
    const key = process.env.SUPABASE_SECRET_KEY?.trim();
    if (!url || !key) throw new Error("需要 NEXT_PUBLIC_SUPABASE_URL 与 SUPABASE_SECRET_KEY 才能跑真实验收");
    const client = createClient(url, key, { auth: { persistSession: false } });

    const events: OperationalEvent[] = [];
    const store = createSupabaseRetentionStore(client);
    const outcome = await runRetentionMaintenance({
      store,
      // 对账巡检本身（reconcileJobs）已有 T029 的验收覆盖，这里复验的是它跑完之后的健康读数。
      reconcile: async () => undefined,
      logger: logger(events),
    }).catch((error: unknown) => error as Error);

    const health = await store.reconciliationHealth(new Date(Date.now() - 5 * 60_000).toISOString());
    // 关键断言：这个数是真的读出来的。改回 client.schema("private") 会直接抛 PGRST106。
    expect(Number.isInteger(health.unsettledReservations)).toBe(true);
    expect(Number.isInteger(health.staleJobs)).toBe(true);

    // 日志只许出现计数与比例，不许出现任何正文字段。
    expect(JSON.stringify(events)).not.toMatch(/body|prompt|transcript|content|text/i);
    expect(events.filter((event) => event.code === "retention.completed")).toHaveLength(2);

    if (health.staleJobs + health.unsettledReservations > 0) {
      // 仍有卡死预留时巡检必须是红的——红本身就是要报的结论，不允许调绿。
      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe("RECONCILER_UNHEALTHY");
      expect(events.at(-1)).toMatchObject({ code: "reconciler.unhealthy", resource: "jobs" });
    } else {
      expect(outcome).not.toBeInstanceOf(Error);
      expect(events.at(-1)).toEqual({ code: "reconciler.verified", resource: "jobs", count: 0 });
    }
  }, 120_000);
});
