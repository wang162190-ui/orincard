import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
// @ts-expect-error Directly executable ESM operations script.
import { createBackup } from "../../scripts/backup.mjs";
// @ts-expect-error Directly executable ESM operations script.
import { verifyRestore } from "../../scripts/restore-check.mjs";

async function target() { return mkdtemp(join(tmpdir(), "orincard-recovery-")); }
function approval(environment: string, directory: string) { return `APPROVED_ISOLATED_TARGET:${environment}:${resolve(directory)}`; }

it("backs up database and Storage and verifies hashes, references, and tombstones", async () => {
  const directory = await target();
  const database = { dump: async () => Buffer.from("isolated database"), inventory: async () => ({ references: ["uploads/active.pdf"], tombstones: ["uploads/deleted.pdf"] }) };
  const storage = { list: async () => [{ bucket: "uploads", key: "active.pdf" }], download: async () => Buffer.from("private object") };
  const manifest = await createBackup({ environment: "preview", target: directory, approval: approval("preview", directory), database, storage, now: () => new Date("2026-09-10T00:00:00Z") });
  expect(manifest.objects[0]).toMatchObject({ bucket: "uploads", key: "active.pdf", size: 14 });
  expect(JSON.parse(await readFile(join(directory, "manifest.json"), "utf8")).database.sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(verifyRestore({ environment: "preview", target: directory, approval: approval("preview", directory), database: { inventory: database.inventory }, storage: { download: storage.download, exists: async () => false } })).resolves.toEqual({ databaseHashVerified: true, referencesVerified: 1, tombstonesVerified: 1, objectsVerified: 1 });
});

describe("recovery safety", () => {
  it("rejects production and unapproved targets before reading data", async () => {
    const directory = await target();
    const database = { dump: async () => { throw new Error("must not run"); }, inventory: async () => ({ references: [], tombstones: [] }) };
    await expect(createBackup({ environment: "production", target: directory, approval: approval("production", directory), database, storage: { list: async () => [], download: async () => Buffer.alloc(0) } })).rejects.toThrow("Production");
    await expect(createBackup({ environment: "preview", target: directory, approval: "wrong", database, storage: { list: async () => [], download: async () => Buffer.alloc(0) } })).rejects.toThrow("approval");
  });

  // 修复前只精确匹配小写 "production"，实跑确认 Production / PRODUCTION / prod 三种写法全部放行。
  // 这是唯一的生产闸门（脚本看不到 project ref），黑名单在这里是错的做法。
  it.each(["Production", "PRODUCTION", "prod", "staging", ""])(
    "refuses the unapproved environment %j instead of only lowercase production",
    async (environment) => {
      const directory = await target();
      const database = { dump: async () => { throw new Error("must not run"); }, inventory: async () => ({ references: [], tombstones: [] }) };
      await expect(createBackup({ environment, target: directory, approval: approval(environment, directory), database, storage: { list: async () => [], download: async () => Buffer.alloc(0) } })).rejects.toThrow("forbidden");
    },
  );

  // 适配器契约：活引用与 tombstone 必须互斥，否则两项检查会一起落空。
  it("rejects an inventory that lists the same key as both active and tombstoned", async () => {
    const directory = await target();
    const database = { dump: async () => Buffer.from("db"), inventory: async () => ({ references: ["uploads/a"], tombstones: ["uploads/gone"] }) };
    await createBackup({ environment: "development", target: directory, approval: approval("development", directory), database, storage: { list: async () => [], download: async () => Buffer.alloc(0) } });
    await expect(verifyRestore({
      environment: "development", target: directory, approval: approval("development", directory),
      database: { inventory: async () => ({ references: ["uploads/a", "uploads/gone"], tombstones: ["uploads/gone"] }) },
      storage: { download: async () => Buffer.from("original"), exists: async () => false },
    })).rejects.toThrow("both active and tombstoned");
  });

  it("fails on changed objects or resurrected tombstones", async () => {
    const directory = await target();
    const database = { dump: async () => Buffer.from("db"), inventory: async () => ({ references: ["uploads/a"], tombstones: ["uploads/gone"] }) };
    await createBackup({ environment: "development", target: directory, approval: approval("development", directory), database, storage: { list: async () => [{ bucket: "uploads", key: "a" }], download: async () => Buffer.from("original") } });
    await expect(verifyRestore({ environment: "development", target: directory, approval: approval("development", directory), database: { inventory: database.inventory }, storage: { download: async () => Buffer.from("changed"), exists: async () => true } })).rejects.toThrow(/hash mismatch|tombstoned/);
  });
});
