import JSZip from "jszip";
import { describe, expect, it } from "vitest";
import { buildAccountDataPackage, loadAccountPreferences, parseAccountPreferences, saveAccountPreferences } from "../../src/server/account-export";

type QueryResult = { data: unknown; error: null };

function clientFor(ownerId: string, foreignOwnerId: string) {
  const tables: Record<string, Record<string, unknown>[]> = {
    profiles: [{ id: ownerId, status: "active", display_name: "Owner", preferences: { language: "English" }, created_at: "2026-01-01", updated_at: "2026-01-02", secret_key: "never" }],
    projects: [
      { id: "p1", owner_id: ownerId, title: "Mine", platform: "linkedin", state: "draft", current_version_id: "v1", created_at: "2026-01-01", updated_at: "2026-01-02" },
      { id: "p2", owner_id: foreignOwnerId, title: "Foreign secret", platform: "linkedin", state: "draft", current_version_id: "v2", created_at: "2026-01-01", updated_at: "2026-01-02" },
    ],
    project_versions: [{ id: "v1", owner_id: ownerId, project_id: "p1", revision: 1, document: { title: "Owned copy" }, created_at: "2026-01-01" }],
    brand_kits: [], sources: [],
    assets: [{ id: "a1", owner_id: ownerId, kind: "upload", purpose: "media", bucket: "assets", object_key: `${ownerId}/private.png`, mime: "image/png", bytes: 12, sha256: "a".repeat(64), width: 1, height: 1, duration_ms: null, rights: {}, accepted_at: null, library_retained: false, state: "ready", created_at: "2026-01-01", updated_at: "2026-01-01" }],
    exports: [],
  };
  return {
    from(table: string) {
      let rows = tables[table] ?? [];
      let allowed: string[] | null = null;
      const projected = () => allowed ? rows.map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => allowed!.includes(key)))) : rows;
      const query = {
        select(columns: string) {
          allowed = columns.split(",");
          return query;
        },
        eq(column: string, value: unknown) {
          rows = rows.filter((row) => row[column] === value);
          return query;
        },
        then(resolve: (result: QueryResult) => unknown) { return Promise.resolve({ data: projected(), error: null }).then(resolve); },
        maybeSingle() { return Promise.resolve({ data: projected()[0] ?? null, error: null }); },
      };
      return query;
    },
  };
}

describe("T060 account preferences and data package", () => {
  it("accepts only bounded creation preferences", () => {
    expect(parseAccountPreferences({ language: "English", tone: "friendly", slideCount: 8, generationInstructions: "Use short lines" })).toEqual({ language: "English", tone: "friendly", slideCount: 8, generationInstructions: "Use short lines" });
    expect(() => parseAccountPreferences({ language: "English", tone: "friendly", slideCount: 99, generationInstructions: "" })).toThrow("invalid");
    expect(() => parseAccountPreferences({ language: "English", tone: "friendly", slideCount: 8, generationInstructions: "", apiKey: "secret" })).toThrow("invalid");
  });

  it("persists and reloads the owner's preferences", async () => {
    let stored: unknown = {};
    const store = {
      async load(ownerId: string) { expect(ownerId).toBe("owner-1"); return stored; },
      async save(ownerId: string, preferences: unknown) { expect(ownerId).toBe("owner-1"); stored = preferences; },
    };
    const saved = await saveAccountPreferences(store, "owner-1", { language: "Chinese", tone: "educational", slideCount: 10, generationInstructions: "Use examples" });
    expect(await loadAccountPreferences(store, "owner-1")).toEqual(saved);
  });

  it("packages allowlisted records for the owner without secrets, object keys, payments or foreign data", async () => {
    const ownerId = "11111111-1111-4111-8111-111111111111";
    const foreignOwnerId = "22222222-2222-4222-8222-222222222222";
    const result = await buildAccountDataPackage(clientFor(ownerId, foreignOwnerId) as never, ownerId, "2026-09-10T00:00:00.000Z");
    const zip = await JSZip.loadAsync(result.bytes);
    const json = await zip.file("account.json")!.async("string");
    const parsed = JSON.parse(json);
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.projects[0].title).toBe("Mine");
    expect(parsed.assets[0].object_key).toBeUndefined();
    expect(json).toContain("Owned copy");
    expect(json).not.toContain("Foreign secret");
    expect(json).not.toContain("private.png");
    expect(json).not.toMatch(/secret_key|api.?key|payment|credential/i);
  });
});
