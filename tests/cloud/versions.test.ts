import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import { ProjectServiceError, createProjectService, createSupabaseProjectStore, type ProjectRecord, type ProjectStore } from "../../src/server/projects";

const OWNER = "00000000-0000-4000-8000-000000000001";
const PROJECT = "00000000-0000-4000-8000-000000000002";
const VERSION = "00000000-0000-4000-8000-000000000003";

async function fixture(): Promise<CarouselDocument> {
  return JSON.parse(await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8")) as CarouselDocument;
}

function record(document: CarouselDocument, revision = 3): ProjectRecord {
  return { id: PROJECT, title: document.title, platform: document.platform, document, revision, state: "draft", updatedAt: "2026-09-09T12:00:00.000Z" };
}

function store(overrides: Partial<ProjectStore> = {}): ProjectStore {
  return { create: vi.fn(), get: vi.fn(), list: vi.fn(), save: vi.fn(), listVersions: vi.fn(), restore: vi.fn(), ...overrides };
}

describe("T057 project versions and restore", () => {
  it("lists immutable version metadata only after owner-bound project lookup", async () => {
    const document = await fixture();
    const listVersions = vi.fn().mockResolvedValue([{ id: VERSION, revision: 2, reason: "manual", createdAt: "2026-09-09T10:00:00.000Z", documentHash: "a".repeat(64) }]);
    const service = createProjectService({ store: store({ get: vi.fn().mockResolvedValue(record(document)), listVersions }), requestHashSecret: "test-secret" });
    await expect(service.listVersions(OWNER, PROJECT, 200)).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: VERSION, revision: 2 })]));
    expect(listVersions).toHaveBeenCalledWith(OWNER, PROJECT, 50);
  });

  it("does not list versions for a missing or foreign project", async () => {
    const listVersions = vi.fn();
    const service = createProjectService({ store: store({ get: vi.fn().mockResolvedValue(null), listVersions }), requestHashSecret: "test-secret" });
    await expect(service.listVersions(OWNER, PROJECT)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(listVersions).not.toHaveBeenCalled();
  });

  it("restores by immutable version id into a new revision without mutating the source document", async () => {
    const source = await fixture();
    source.assetRefs = [{ id: "asset-history", kind: "generated", mimeType: "image/png", rightsStatus: "verified" }];
    const snapshot = structuredClone(source);
    const restore = vi.fn().mockResolvedValue(record(snapshot, 4));
    const service = createProjectService({ store: store({ restore }), requestHashSecret: "test-secret" });
    const result = await service.restore(OWNER, PROJECT, { versionId: VERSION, expectedRevision: 3 }, "restore-key-1");
    expect(result).toMatchObject({ revision: 4, document: { assetRefs: snapshot.assetRefs } });
    expect(snapshot).toEqual(source);
    expect(restore).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, projectId: PROJECT, versionId: VERSION, expectedRevision: 3, idempotencyKey: "restore-key-1", requestHash: expect.stringMatching(/^[a-f0-9]{64}$/) }));
  });

  it("rejects invalid identifiers before asking the database to restore", async () => {
    const restore = vi.fn();
    const service = createProjectService({ store: store({ restore }), requestHashSecret: "test-secret" });
    await expect(service.restore(OWNER, PROJECT, { versionId: "not-a-version", expectedRevision: 3 }, "restore-key-1")).rejects.toEqual(expect.any(ProjectServiceError));
    expect(restore).not.toHaveBeenCalled();
  });

  it("uses only the owner, project, version and CAS restore RPC", async () => {
    const document = await fixture();
    const query = { select: vi.fn(), eq: vi.fn(), in: vi.fn(), maybeSingle: vi.fn().mockResolvedValue({ data: { id: PROJECT, title: document.title, platform: document.platform, document, revision: 4, state: "draft", updated_at: "2026-09-09T12:00:00.000Z" }, error: null }) };
    query.select.mockReturnValue(query); query.eq.mockReturnValue(query); query.in.mockReturnValue(query);
    const client = { from: vi.fn().mockReturnValue(query), rpc: vi.fn().mockResolvedValue({ data: { projectId: PROJECT, revision: 4 }, error: null }) };
    const projectStore = createSupabaseProjectStore(client as never);
    await projectStore.restore({ ownerId: OWNER, projectId: PROJECT, versionId: VERSION, expectedRevision: 3, idempotencyKey: "restore-key-1", requestHash: "a".repeat(64) });
    expect(client.rpc).toHaveBeenCalledWith("server_restore_project", { p_owner_id: OWNER, p_project_id: PROJECT, p_version_id: VERSION, p_expected_revision: 3, p_idempotency_key: "restore-key-1", p_request_hash: "a".repeat(64) });
  });

  it("keeps the restore RPC commented, idempotent, and triple-bound in its undeployed migration", async () => {
    const migration = await readFile(new URL("../../supabase/migrations/20260909210000_b07_project_restore.sql", import.meta.url), "utf8");
    expect(migration).toContain("server_restore_project");
    expect(migration).toContain("id = p_version_id and project_id = p_project_id and owner_id = p_owner_id");
    expect(migration).toContain("insert into public.project_versions");
    expect(migration).toContain("'restore'");
    expect(migration).toContain("comment on function public.server_restore_project");
  });
});
