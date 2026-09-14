import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function sha256(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function objectPath(directory, bucket, key) {
  const root = resolve(directory, "storage");
  const path = resolve(root, bucket, key);
  if (!path.startsWith(`${root}/`)) throw new Error("Storage inventory contains an unsafe object path.");
  return path;
}

// 这是唯一的生产闸门：脚本拿到的是外部注入的适配器，看不到 Supabase project ref，
// 没法像 CI 守卫那样比对 SUPABASE_PROJECT_REF != SUPABASE_PRODUCTION_PROJECT_REF。
// 因此必须是**白名单**而不是黑名单 —— 原来只精确匹配小写 "production"，
// 实测 APP_ENV=Production / PRODUCTION / prod 三种写法全部放行、备份照常写出。
const APPROVED_ENVIRONMENTS = new Set(["development", "preview"]);

export function assertIsolatedTarget({ environment, target, approval }) {
  const resolved = resolve(target);
  if (!APPROVED_ENVIRONMENTS.has(environment)) {
    throw new Error("Production backup and restore targets are forbidden; only development and preview are approved.");
  }
  if (approval !== `APPROVED_ISOLATED_TARGET:${environment}:${resolved}`) throw new Error("Isolated target approval does not match.");
  return resolved;
}

export async function createBackup({ environment, target, approval, database, storage, now = () => new Date() }) {
  const directory = assertIsolatedTarget({ environment, target, approval });
  await mkdir(join(directory, "storage"), { recursive: true });
  const databaseDump = await database.dump();
  const inventory = await database.inventory();
  await writeFile(join(directory, "database.dump"), databaseDump, { mode: 0o600 });
  const objects = [];
  for (const object of await storage.list()) {
    const bytes = await storage.download(object.bucket, object.key);
    const path = objectPath(directory, object.bucket, object.key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { mode: 0o600 });
    objects.push({ bucket: object.bucket, key: object.key, size: bytes.length, sha256: sha256(bytes) });
  }
  const manifest = { schemaVersion: 1, createdAt: now().toISOString(), environment, database: { file: "database.dump", sha256: sha256(databaseDump) }, objects, references: [...inventory.references].sort(), tombstones: [...inventory.tombstones].sort() };
  await writeFile(join(directory, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

async function main() {
  const target = process.argv[2];
  const environment = process.env.APP_ENV;
  if (!target) throw new Error("Usage: node scripts/backup.mjs <isolated-output-directory>");
  const directory = assertIsolatedTarget({ environment, target, approval: process.env.ISOLATED_TARGET_APPROVAL });
  const dumpPath = process.env.APPROVED_DATABASE_DUMP;
  const storagePath = process.env.APPROVED_STORAGE_EXPORT;
  if (!dumpPath || !storagePath) throw new Error("Approved database dump and Storage export paths are required.");
  const inventory = JSON.parse(await readFile(join(storagePath, "inventory.json"), "utf8"));
  const storageRoot = resolve(storagePath);
  await createBackup({ environment, target: directory, approval: process.env.ISOLATED_TARGET_APPROVAL, database: { dump: () => readFile(dumpPath), inventory: async () => ({ references: inventory.references ?? [], tombstones: inventory.tombstones ?? [] }) }, storage: { list: async () => inventory.objects ?? [], download: (bucket, key) => { const path = resolve(storageRoot, bucket, key); if (!path.startsWith(`${storageRoot}/`)) throw new Error("Storage inventory contains an unsafe object path."); return readFile(path); } } });
  console.log(`Backup written to ${directory}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
