import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { createDeletionService, type DeletionStore, runDeletionCleanup } from "../../src/server/deletion";
import { validateCleanupPayload } from "../../src/trigger/cleanup";

const OWNER = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const REQUEST = "33333333-3333-4333-8333-333333333333";

function store(overrides: Partial<DeletionStore> = {}): DeletionStore {
  return {
    requestProject: vi.fn().mockResolvedValue(REQUEST),
    requestAccount: vi.fn().mockResolvedValue(REQUEST),
    claim: vi.fn().mockResolvedValue({ id: REQUEST, ownerId: OWNER, scope: "project", projectId: PROJECT }),
    cleanup: vi.fn().mockResolvedValue(undefined),
    fail: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("T059 staged deletion", () => {
  it("requests project deletion with owner before dispatch", async () => {
    const data = store();
    await expect(createDeletionService(data).requestProject(OWNER, PROJECT)).resolves.toBe(REQUEST);
    expect(data.requestProject).toHaveBeenCalledWith(OWNER, PROJECT);
  });

  it("does not reveal a foreign project", async () => {
    const data = store({ requestProject: vi.fn().mockRejectedValue({ code: "42501" }) });
    await expect(createDeletionService(data).requestProject(OWNER, PROJECT)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(createDeletionService(data).requestProject(OWNER, "not-a-uuid")).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("cleans a claimed request and records a retryable failure", async () => {
    const good = store();
    await expect(runDeletionCleanup(good, REQUEST)).resolves.toEqual({ requestId: REQUEST, state: "completed" });
    expect(good.cleanup).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, projectId: PROJECT }));

    const bad = store({ cleanup: vi.fn().mockRejectedValue(new Error("storage unavailable")) });
    await expect(runDeletionCleanup(bad, REQUEST)).rejects.toThrow("storage unavailable");
    expect(bad.fail).toHaveBeenCalledWith(REQUEST, "CLEANUP_FAILED");
  });

  it("validates cleanup payloads", () => {
    expect(validateCleanupPayload({ jobId: REQUEST, schemaVersion: 1, requestId: "trace" })).toEqual({ deletionId: REQUEST });
    expect(() => validateCleanupPayload({ requestId: REQUEST })).toThrow("Invalid cleanup payload");
  });

  it("cuts authorization before cleanup, rejects late success, and preserves live shared references", async () => {
    const sql = await readFile(new URL("../../supabase/definitions/deletion.sql", import.meta.url), "utf8");
    expect(sql).toMatch(/update public\.projects set state = 'deleting'[\s\S]+where id = p_project_id and owner_id = p_owner_id/);
    expect(sql).toMatch(/update public\.profiles set status = 'deleting'[\s\S]+where id = p_owner_id and status = 'active'/);
    expect(sql).toContain("deleted owner cannot receive job results");
    expect(sql).toContain("jobs_reject_deleted_owner_writeback");

    const implementation = await readFile(new URL("../../src/server/deletion.ts", import.meta.url), "utf8");
    expect(implementation).toContain('.in("projects.state", ["draft", "archived"])');
    expect(implementation).toContain('.eq("brand_kits.state", "active")');
    expect(implementation).toContain("const unused = ids.filter((id) => !live.has(id))");
  });

  it("comments every new table, field and function", async () => {
    const sql = await readFile(new URL("../../supabase/definitions/deletion.sql", import.meta.url), "utf8");
    expect(sql.match(/comment on column public\.deletion_requests\./g)).toHaveLength(9);
    expect(sql).toContain("comment on table public.deletion_requests");
    for (const name of ["server_request_project_deletion", "server_request_account_deletion", "reject_deleted_owner_job_writeback"]) expect(sql).toContain(`comment on function ${name.startsWith("reject") ? "private" : "public"}.${name}`);
  });
});
