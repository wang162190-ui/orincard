import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const migration = new URL("../../supabase/migrations/20260909220000_b07_project_library.sql", import.meta.url);

describe("T058 project library database contract", () => {
  it("uses owner-scoped CAS operations with idempotent receipts and restricted wrappers", async () => {
    const sql = await readFile(migration, "utf8");
    expect(sql).toContain("owner_id = p_owner_id");
    expect(sql).toContain("source.revision <> p_expected_revision");
    expect(sql).toContain("target.revision <> p_expected_revision");
    expect(sql.match(/private\.operation_receipts/g)?.length).toBeGreaterThanOrEqual(4);
    expect(sql).toContain("receipt.request_hash <> p_request_hash");
    expect(sql).toContain("insert into public.project_versions");
    expect(sql).toContain("insert into public.project_asset_refs");
    expect(sql).toContain("revoke execute on function public.server_duplicate_project");
    expect(sql).toContain("revoke execute on function public.server_archive_project");
    expect(sql.match(/comment on function/g)).toHaveLength(4);
  });
});
