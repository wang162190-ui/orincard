import { schedules } from "@trigger.dev/sdk";
import type { SupabaseClient } from "@supabase/supabase-js";
import { consoleOperationalLogger, verifyReconciler, type OperationalLogger } from "../server/observability";
import { createSupabaseJobStore, reconcileJobs, triggerRunController } from "../server/jobs";
import { createAdminSupabaseClient } from "../server/supabase";
import { resolveTriggerDispatcher } from "./dispatch";

export type RetainedObject = { readonly id: string; readonly kind: "source" | "export"; readonly assetId: string | null; readonly bucket: string | null; readonly objectKey: string | null };
export interface RetentionStore {
  listExpired(kind: RetainedObject["kind"], before: string, limit: number): Promise<readonly RetainedObject[]>;
  expire(record: RetainedObject): Promise<void>;
  removeObject(bucket: string, objectKey: string): Promise<void>;
  reconciliationHealth(before: string): Promise<{ readonly staleJobs: number; readonly unsettledReservations: number }>;
}

export async function runRetentionMaintenance(input: { readonly store: RetentionStore; readonly reconcile: () => Promise<unknown>; readonly logger: OperationalLogger; readonly now?: () => Date }) {
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
  const staleBefore = new Date(now.getTime() - 5 * 60_000).toISOString();
  const reconciliation = await verifyReconciler({ run: input.reconcile, inspect: () => input.store.reconciliationHealth(staleBefore) }, input.logger);
  return { removed, reconciliation };
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
    async reconciliationHealth(before) {
      const [jobs, reservations] = await Promise.all([
        client.from("jobs").select("id", { count: "exact", head: true }).in("state", ["pending_dispatch", "queued", "running"]).lt("updated_at", before),
        client.schema("private").from("cost_reservations").select("id", { count: "exact", head: true }).in("state", ["open", "unknown"]).lt("updated_at", before),
      ]);
      if (jobs.error) throw jobs.error; if (reservations.error) throw reservations.error;
      return { staleJobs: jobs.count ?? 0, unsettledReservations: reservations.count ?? 0 };
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
