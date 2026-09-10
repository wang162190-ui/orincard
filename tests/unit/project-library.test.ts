import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createProjectLibraryService } from "../../src/server/project-library";

const ownerId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";

function service(rpc: ReturnType<typeof vi.fn>) {
  return createProjectLibraryService({ client: { rpc } as unknown as SupabaseClient, requestHashSecret: "test-secret" });
}

describe("project library operations", () => {
  it("sends owner, revision, operation key, and a stable request hash", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: { projectId, revision: 1, state: "draft" }, error: null });
    const library = service(rpc);
    await library.duplicate(ownerId, projectId, 4, "duplicate-key-1");
    await library.duplicate(ownerId, projectId, 4, "duplicate-key-1");
    expect(rpc).toHaveBeenCalledTimes(2);
    expect(rpc.mock.calls[0]).toEqual(rpc.mock.calls[1]);
    expect(rpc.mock.calls[0][0]).toBe("server_duplicate_project");
    expect(rpc.mock.calls[0][1]).toMatchObject({ p_owner_id: ownerId, p_project_id: projectId, p_expected_revision: 4, p_idempotency_key: "duplicate-key-1", p_request_hash: expect.stringMatching(/^[a-f0-9]{64}$/) });
  });

  it.each([
    ["PT409", "VERSION_CONFLICT", 409],
    // 40001 no longer comes from the RPCs, but a genuine serialization failure from
    // Postgres itself still means "re-read and retry", not "service unavailable".
    ["40001", "VERSION_CONFLICT", 409],
    ["42501", "NOT_FOUND", 404],
    ["23505", "IDEMPOTENCY_CONFLICT", 409],
    ["55000", "OPERATION_EXPIRED", 410],
  ] as const)("maps database error %s without exposing another owner's project", async (databaseCode, code, status) => {
    const library = service(vi.fn().mockResolvedValue({ data: null, error: { code: databaseCode } }));
    await expect(library.archive(ownerId, projectId, 1, "archive-key-1")).rejects.toMatchObject({ code, status });
  });

  it("rejects malformed revisions and short idempotency keys before the database call", async () => {
    const rpc = vi.fn();
    const library = service(rpc);
    await expect(library.archive(ownerId, projectId, 0, "archive-key-1")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(library.archive(ownerId, projectId, 1, "short")).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(rpc).not.toHaveBeenCalled();
  });
});
