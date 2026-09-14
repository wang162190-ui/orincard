import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { dispatchPendingJob, type JobRecord, type JobStore, type TriggerDispatcher } from "../../src/server/jobs";
import { validateJobDispatchPayload } from "../../src/trigger/job-dispatch";
import { validateImageGenerationPayload } from "../../src/trigger/generate-image";
// @ts-expect-error Directly executable ESM operations script.
import { createBackup } from "../../scripts/backup.mjs";
// @ts-expect-error Directly executable ESM operations script.
import { verifyRestore } from "../../scripts/restore-check.mjs";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

function job(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    ownerId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    kind: "generation", state: "pending_dispatch", stage: "validate", progress: 0,
    providerRunId: null, attempt: 0, heartbeatAt: null, resultRef: null, errorCode: null,
    cancelRequestedAt: null, updatedAt: "2026-09-14T00:00:00.000Z", finishedAt: null,
    ...overrides,
  };
}

type DrillStore = JobStore & { current: JobRecord; markQueuedCalls: number };

function store(record: JobRecord): DrillStore {
  const unused = async () => null;
  const api: DrillStore = {
    current: record,
    markQueuedCalls: 0,
    async findById(id: string) { return api.current.id === id ? api.current : null; },
    async findOwned(ownerId: string, id: string) { return api.current.id === id && api.current.ownerId === ownerId ? api.current : null; },
    async markQueued(id: string, expectedProviderRunId: string | null, providerRunId: string) {
      api.markQueuedCalls += 1;
      if (api.current.id !== id || api.current.state !== "pending_dispatch" || api.current.providerRunId !== expectedProviderRunId) return null;
      api.current = { ...api.current, state: "queued", providerRunId };
      return api.current;
    },
    requestCancellation: unused,
    claimRetry: unused,
    listReconciliationCandidates: async () => [],
  };
  return api;
}

// L07 发布演练 —— 对应 docs/sdd/orincard/operations.md 的失败回滚策略：
// 「网站回滚到上一已知版本；worker保留旧schema兼容并固定run版本；DB优先前向修复，不自动破坏性回滚。」
describe("T089 release and rollback drill", () => {
  describe("旧版兼容：回滚后的站点不会撞上少了东西的 schema", () => {
    it("keeps every applied migration additive", async () => {
      const directory = resolve(ROOT, "supabase/migrations");
      const files = (await readdir(directory)).filter((name) => name.endsWith(".sql"));
      expect(files.length).toBeGreaterThan(0);
      const destructive: string[] = [];
      for (const file of files) {
        const sql = await readFile(join(directory, file), "utf8");
        for (const [index, line] of sql.split("\n").entries()) {
          const statement = line.trim().toLowerCase();
          if (statement.startsWith("--")) continue;
          // `drop function/trigger/policy if exists` 是 create or replace 的常规前置，不破坏已有数据；
          // 丢列、丢表、丢类型、收紧为 not null、改列类型、truncate 才会让旧版代码读不回去。
          if (/\b(drop\s+(table|column|type|schema)|truncate\b|alter\s+column\s+\S+\s+(set\s+not\s+null|type)\b)/.test(statement)) {
            destructive.push(`${file}:${index + 1} ${line.trim()}`);
          }
        }
      }
      expect(destructive).toEqual([]);
    });

    // worker 的载荷校验器全部是 z.literal(1) / .strict() 的精确匹配，多一个字段就整条拒绝，
    // 也就是**没有任何版本容忍度**。今天安全完全靠 release.yml 的 migrate→worker→website 顺序
    // （worker 先于站点部署，所以新 worker 总是先就位）。把这条前提钉死，免得顺序被人改掉后无人察觉。
    it("pins the worker payload version and rejects unknown fields", () => {
      const valid = { jobId: "11111111-1111-4111-8111-111111111111", schemaVersion: 1, requestId: "req-1" };
      expect(validateJobDispatchPayload(valid)).toEqual(valid);
      expect(() => validateJobDispatchPayload({ ...valid, schemaVersion: 2 })).toThrow();
      expect(() => validateJobDispatchPayload({ ...valid, extra: "from a newer website" })).toThrow();
      expect(() => validateImageGenerationPayload({ assetId: valid.jobId, schemaVersion: 1, extra: true })).toThrow();
    });
  });

  describe("worker 故障：任务不丢、不重复计费", () => {
    it("leaves a job dispatchable when the worker is unreachable", async () => {
      const jobs = store(job());
      const trigger = { trigger: vi.fn(async () => { throw new Error("Trigger.dev is unreachable"); }) } as unknown as TriggerDispatcher;
      await expect(dispatchPendingJob(jobs, trigger, job().id, "req-1")).rejects.toThrow("unreachable");
      expect(jobs.current.state).toBe("pending_dispatch");
      expect(jobs.current.providerRunId).toBeNull();
      expect(jobs.markQueuedCalls).toBe(0);
    });

    // 重试用的幂等键是 `${jobId}:${attempt}`，不是每次新生成的随机值 —— 上游已经建过的 run
    // 会被 Trigger.dev 去重，所以「派发失败后重试」不会让供应商跑第二遍、也不会二次计费。
    it("reuses the same run key when a failed dispatch is retried", async () => {
      const jobs = store(job());
      const calls: string[] = [];
      const trigger = { trigger: vi.fn(async (_payload: unknown, key: string) => { calls.push(key); if (calls.length === 1) throw new Error("worker down"); return { id: "run_1" }; }) } as unknown as TriggerDispatcher;
      await expect(dispatchPendingJob(jobs, trigger, job().id, "req-1")).rejects.toThrow("worker down");
      await dispatchPendingJob(jobs, trigger, job().id, "req-1");
      expect(calls).toEqual([`${job().id}:0`, `${job().id}:0`]);
      expect(jobs.current.state).toBe("queued");
      expect(jobs.current.providerRunId).toBe("run_1");
    });

    it("does not strand a job when the queue write loses a race", async () => {
      const jobs = store(job({ state: "queued", providerRunId: "run_existing" }));
      jobs.current = job();
      const trigger = { trigger: vi.fn(async () => { jobs.current = job({ state: "queued", providerRunId: "run_existing" }); return { id: "run_new" }; }) } as unknown as TriggerDispatcher;
      const result = await dispatchPendingJob(jobs, trigger, job().id, "req-1");
      expect(result.state).toBe("queued");
      expect(result.providerRunId).toBe("run_existing");
    });
  });

  describe("网站回滚：站点最后部署，回滚它不需要动 DB", () => {
    it("deploys the website after the migration and the worker", async () => {
      const release = await readFile(join(ROOT, ".github/workflows/release.yml"), "utf8");
      expect(release).toMatch(/migrate:\n {4}needs: test[\s\S]+worker:\n {4}needs: migrate[\s\S]+website:\n {4}needs: worker/);
      expect(release.indexOf("website:")).toBeGreaterThan(release.indexOf("worker:"));
    });

    it("never issues a destructive database command during a release", async () => {
      const release = await readFile(join(ROOT, ".github/workflows/release.yml"), "utf8");
      for (const forbidden of ["db reset", "--force", "drop table", "drop column", "truncate"]) {
        expect(release.toLowerCase()).not.toContain(forbidden);
      }
      // 前向修复：发布只推已在 CI 与开发库验证过的迁移，不在流水线里现场生成新迁移。
      expect(release).toContain("supabase db push --linked --include-all");
      expect(release).not.toContain("supabase migration new");
    });
  });

  describe("DB 恢复：先到隔离目标，且删除过的内容不许复活", () => {
    it("re-enforces deletion tombstones on the restored copy", async () => {
      const directory = await mkdtemp(join(tmpdir(), "orincard-drill-"));
      const approval = `APPROVED_ISOLATED_TARGET:development:${resolve(directory)}`;
      const database = { dump: async () => Buffer.from("drill database"), inventory: async () => ({ references: ["uploads/active"], tombstones: ["uploads/deleted"] }) };
      const storage = { list: async () => [{ bucket: "uploads", key: "active" }], download: async () => Buffer.from("object bytes") };
      await createBackup({ environment: "development", target: directory, approval, database, storage });

      await expect(verifyRestore({
        environment: "development", target: directory, approval,
        database: { inventory: database.inventory },
        storage: { download: storage.download, exists: async () => false },
      })).resolves.toMatchObject({ databaseHashVerified: true, objectsVerified: 1, tombstonesVerified: 1 });

      // 恢复把一条已删对象带了回来 —— 演练必须失败，而不是签字通过。
      await expect(verifyRestore({
        environment: "development", target: directory, approval,
        database: { inventory: database.inventory },
        storage: { download: storage.download, exists: async (key: string) => key === "uploads/deleted" },
      })).rejects.toThrow("tombstoned object was restored");
    });

    it("refuses to run the drill against production", async () => {
      const directory = await mkdtemp(join(tmpdir(), "orincard-drill-"));
      const database = { dump: async () => { throw new Error("must not read production"); }, inventory: async () => ({ references: [], tombstones: [] }) };
      for (const environment of ["production", "Production", "PRODUCTION", "prod"]) {
        await expect(createBackup({
          environment, target: directory, approval: `APPROVED_ISOLATED_TARGET:${environment}:${resolve(directory)}`,
          database, storage: { list: async () => [], download: async () => Buffer.alloc(0) },
        })).rejects.toThrow("forbidden");
      }
    });
  });
});
