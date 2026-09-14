import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { assertIsolatedTarget, sha256 } from "./backup.mjs";

export async function verifyRestore({ environment, target, approval, database, storage }) {
  const directory = assertIsolatedTarget({ environment, target, approval });
  const manifest = JSON.parse(await readFile(join(directory, "manifest.json"), "utf8"));
  const dump = await readFile(join(directory, manifest.database.file));
  if (sha256(dump) !== manifest.database.sha256) throw new Error("Database backup hash mismatch.");
  const restored = await database.inventory();
  // 适配器契约：活引用与 tombstone 必须互斥。Orincard 的 assets.state 是单列枚举，
  // 两份清单由 state<>'deleted' / state='deleted' 导出，天然满足；但 verifyRestore 接受任意适配器，
  // 一个把「软删除行」同时算进两边的实现会让下面两项检查双双落空，已删数据复活却全绿。
  // 这里把这条前提从「口头约定」变成断言，成本两行。
  const bothActiveAndDeleted = restored.tombstones.filter((tombstone) => restored.references.includes(tombstone));
  if (bothActiveAndDeleted.length) throw new Error(`Restored inventory lists ${bothActiveAndDeleted.length} keys as both active and tombstoned.`);
  const missingReferences = manifest.references.filter((reference) => !restored.references.includes(reference));
  const resurrectedTombstones = manifest.tombstones.filter((reference) => !restored.tombstones.includes(reference));
  if (missingReferences.length) throw new Error(`Restored database is missing ${missingReferences.length} references.`);
  if (resurrectedTombstones.length) throw new Error(`Restored database resurrected ${resurrectedTombstones.length} tombstones.`);
  for (const object of manifest.objects) {
    const bytes = await storage.download(object.bucket, object.key);
    if (!bytes || sha256(bytes) !== object.sha256) throw new Error(`Storage hash mismatch for ${object.bucket}/${object.key}.`);
  }
  for (const tombstone of manifest.tombstones) {
    if (await storage.exists(tombstone)) throw new Error("A tombstoned object was restored.");
  }
  return { databaseHashVerified: true, referencesVerified: manifest.references.length, tombstonesVerified: manifest.tombstones.length, objectsVerified: manifest.objects.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.error("restore-check.mjs is an adapter library; run it through the approved isolated recovery harness described in docs/runbooks/recovery.md.");
  process.exitCode = 2;
}
