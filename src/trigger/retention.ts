import { schedules } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { assertProviderBudget, consoleOperationalLogger, verifyReconciler, type OperationalLogger } from "../server/observability";
import { createSupabaseJobStore, reconcileJobs, triggerRunController } from "../server/jobs";
import { createAdminSupabaseClient } from "../server/supabase";
import { resolveTriggerDispatcher } from "./dispatch";

export type RetainedObject = { readonly id: string; readonly kind: "source" | "export"; readonly assetId: string | null; readonly bucket: string | null; readonly objectKey: string | null };
export type ProviderBudget = { readonly limit: number; readonly reserved: number; readonly spent: number };
export interface RetentionStore {
  listExpired(kind: RetainedObject["kind"], before: string, limit: number): Promise<readonly RetainedObject[]>;
  expire(record: RetainedObject): Promise<void>;
  removeObject(bucket: string, objectKey: string): Promise<void>;
  readBudget(period: string, environment: string): Promise<ProviderBudget | null>;
  reconciliationHealth(before: string): Promise<{ readonly staleJobs: number; readonly unsettledReservations: number }>;
}

// 预算的 100% 硬闸门在 SQL 里：每个预留入口都会算
// limit - reserved - spent < 请求额 → 直接回 budget_exceeded，不建 guard、不建预留。
// 但 80% 告警一直只是 observability.ts 里的一个函数，全仓无人调用——也就是说
// 「快到上限了」这件事从来没有任何地方会说出来。放在这个每小时任务里是最省的接法：
// 不给用户请求加一次往返，又能每小时把比例喊一次。
export async function runRetentionMaintenance(input: { readonly store: RetentionStore; readonly reconcile: () => Promise<unknown>; readonly logger: OperationalLogger; readonly now?: () => Date; readonly environment?: string }) {
  const now = input.now?.() ?? new Date();
  const before = now.toISOString();
  const removed = { source: 0, export: 0 };
  for (const kind of ["source", "export"] as const) {
    const records = await input.store.listExpired(kind, before, 100);
    for (const record of records) {
      if (record.bucket && record.objectKey) await input.store.removeObject(record.bucket, record.objectKey);
      await input.store.expire(record);
      removed[kind] += 1;
    }
    await input.logger.emit({ code: "retention.completed", resource: kind, count: removed[kind] });
  }
  // 清理先做完再查预算：预算即使打满，到期数据该删还是要删。
  const period = before.slice(0, 7);
  const environment = input.environment ?? process.env.APP_ENV ?? "development";
  const budget = await input.store.readBudget(period, environment);
  // 查不到预算行按熔断处理，和 SQL 侧一致：那边 budget.period is null 同样直接拒绝预留。
  const budgetState = await assertProviderBudget(
    budget ? { spent: budget.spent, reserved: budget.reserved, limit: budget.limit } : { spent: 0, reserved: 0, limit: 0 },
    input.logger,
  );
  const staleBefore = new Date(now.getTime() - 5 * 60_000).toISOString();
  const reconciliation = await verifyReconciler({ run: input.reconcile, inspect: () => input.store.reconciliationHealth(staleBefore) }, input.logger);
  return { removed, budget: budgetState, reconciliation };
}

export function createSupabaseRetentionStore(client: SupabaseClient): RetentionStore {
  return {
    async listExpired(kind, before, limit) {
      const table = kind === "source" ? "sources" : "exports";
      let query = client.from(table).select("id,asset_id,assets(bucket,object_key)").lte("expires_at", before).limit(limit);
      query = kind === "source" ? query.neq("state", "deleted") : query.not("state", "in", "(expired,deleted)");
      const result = await query;
      if (result.error) throw result.error;
      return (result.data ?? []).map((row: any) => ({ id: row.id, kind, assetId: row.asset_id, bucket: row.assets?.bucket ?? null, objectKey: row.assets?.object_key ?? null }));
    },
    async expire(record) {
      if (record.kind === "source") {
        const result = await client.from("sources").update({ state: "deleted", metadata: {}, segments: [] }).eq("id", record.id).lte("expires_at", new Date().toISOString()).neq("state", "deleted");
        if (result.error) throw result.error;
      } else {
        const result = await client.from("exports").update({ state: "expired", manifest: {} }).eq("id", record.id).lte("expires_at", new Date().toISOString()).not("state", "in", "(expired,deleted)");
        if (result.error) throw result.error;
      }
      if (record.assetId) await client.from("assets").update({ state: "deleted" }).eq("id", record.assetId).not("state", "eq", "deleted");
    },
    async removeObject(bucket, objectKey) { const result = await client.storage.from(bucket).remove([objectKey]); if (result.error) throw result.error; },
    async readBudget(period, environment) {
      // 同 reconciliationHealth：private.cost_budgets 走不了 Data API，只能经 server_* 只读入口。
      const result = await client.rpc("server_read_cost_budget", { p_period: period, p_environment: environment });
      if (result.error) throw result.error;
      const row = result.data as { limit_micro_usd?: number; reserved_micro_usd?: number; spent_micro_usd?: number } | null;
      if (!row) return null;
      return { limit: Number(row.limit_micro_usd ?? 0), reserved: Number(row.reserved_micro_usd ?? 0), spent: Number(row.spent_micro_usd ?? 0) };
    },
    async reconciliationHealth(before) {
      // 不能走 client.schema("private")：Data API 只暴露 public / graphql_public，
      // private.* 一律回 PGRST106，而 private.cost_reservations 连 service_role 都 revoke。
      // 巡检因此从上线第一天起就没成功执行过一次——这不是配置疏漏，是这条读法本身就走不通。
      const [jobs, reservations] = await Promise.all([
        client.from("jobs").select("id", { count: "exact", head: true }).in("state", ["pending_dispatch", "queued", "running"]).lt("updated_at", before),
        client.rpc("server_count_unsettled_reservations", { p_before: before }),
      ]);
      if (jobs.error) throw jobs.error; if (reservations.error) throw reservations.error;
      return { staleJobs: jobs.count ?? 0, unsettledReservations: Number(reservations.data ?? 0) };
    },
  };
}

export const retentionTask = schedules.task({
  id: "orincard-retention-maintenance",
  cron: "17 * * * *",
  maxDuration: 300,
  run: async () => {
    const client = createAdminSupabaseClient();
    return runRetentionMaintenance({
      store: createSupabaseRetentionStore(client),
      reconcile: () => reconcileJobs(createSupabaseJobStore(client), triggerRunController, resolveTriggerDispatcher, new Date(Date.now() - 5 * 60_000).toISOString()),
      logger: consoleOperationalLogger,
    });
  },
});
