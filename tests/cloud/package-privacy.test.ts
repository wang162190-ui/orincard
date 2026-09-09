import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildAccountDataPackage } from "../../src/server/account-export";
import { inspectRecoveryZip, RECOVERY_LIMITS } from "../../src/server/recovery";

type Row = Record<string, unknown>;

function privacyClient(ownerId: string, foreignOwnerId: string) {
  const queriedTables: string[] = [];
  const rows: Record<string, Row[]> = {
    profiles: [{ id: ownerId, status: "active", display_name: "Owner", preferences: {}, created_at: "2026-09-10", updated_at: "2026-09-10", api_key: "DO-NOT-EXPORT-API-KEY" }],
    projects: [
      { id: "owned-project", owner_id: ownerId, title: "Owned project", platform: "linkedin", document: { title: "Owned project" }, revision: 1, brand_kit_id: null, state: "draft", deleted_at: null, created_at: "2026-09-10", updated_at: "2026-09-10" },
      { id: "foreign-project", owner_id: foreignOwnerId, title: "FOREIGN-PRIVATE-CONTENT", platform: "linkedin", document: {}, revision: 1, state: "draft" },
    ],
    project_versions: [], brand_kits: [], sources: [], exports: [],
    assets: [{ id: "owned-asset", owner_id: ownerId, kind: "upload", purpose: "media", bucket: "assets", object_key: `${ownerId}/PRIVATE-STORAGE-KEY`, mime: "image/png", bytes: 12, sha256: "a".repeat(64), width: 1, height: 1, duration_ms: null, rights: {}, accepted_at: null, library_retained: true, state: "ready", created_at: "2026-09-10", updated_at: "2026-09-10", credential: "DO-NOT-EXPORT-CREDENTIAL" }],
    billing_customers: [{ owner_id: ownerId, stripe_customer_id: "DO-NOT-EXPORT-PAYMENT" }],
  };
  return {
    queriedTables,
    from(table: string) {
      queriedTables.push(table);
      let selected = rows[table] ?? [];
      let columns: string[] = [];
      const query = {
        select(value: string) { columns = value.split(","); return query; },
        eq(column: string, value: unknown) { selected = selected.filter((row) => row[column] === value); return query; },
        then(resolve: (result: { data: Row[]; error: null }) => unknown) {
          return Promise.resolve({ data: selected.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => columns.includes(key)))), error: null }).then(resolve);
        },
        maybeSingle() {
          const row = selected[0];
          return Promise.resolve({ data: row ? Object.fromEntries(Object.entries(row).filter(([key]) => columns.includes(key))) : null, error: null });
        },
      };
      return query;
    },
  };
}

function forbiddenKeys(value: unknown, path = "root"): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => forbiddenKeys(item, `${path}[${index}]`));
  if (!value || typeof value !== "object") return [];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => [
    ...(/api.?key|secret|password|credential|payment|stripe|object_key|bucket|owner_id/i.test(key) ? [`${path}.${key}`] : []),
    ...forbiddenKeys(child, `${path}.${key}`),
  ]);
}

describe("T061 account package privacy and recovery limits", () => {
  it("exports only allowlisted owner records without storage, credential, payment, or foreign fields", async () => {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const client = privacyClient(ownerId, "22222222-2222-4222-8222-222222222222");
    const result = await buildAccountDataPackage(client as never, ownerId, "2026-09-10T00:00:00.000Z");
    const archive = await JSZip.loadAsync(result.bytes);
    const serialized = await archive.file("account.json")!.async("string");
    const account = JSON.parse(serialized) as unknown;
    expect(forbiddenKeys(account)).toEqual([]);
    expect(serialized).toContain("Owned project");
    expect(serialized).not.toContain("FOREIGN-PRIVATE-CONTENT");
    expect(serialized).not.toContain("PRIVATE-STORAGE-KEY");
    expect(serialized).not.toContain("DO-NOT-EXPORT");
    expect(client.queriedTables).not.toContain("billing_customers");
  });

  it("rejects a recovery package above the extraction limit before reading archive bytes", async () => {
    const oversized = { byteLength: RECOVERY_LIMITS.maxBytes + 1 } as Buffer;
    await expect(inspectRecoveryZip(oversized)).rejects.toMatchObject({ code: "FILE_TOO_LARGE", status: 413 });
  });
});
