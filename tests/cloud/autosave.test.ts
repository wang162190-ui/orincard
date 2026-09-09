import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import {
  ProjectServiceError,
  createProjectService,
  createSupabaseProjectStore,
  type ProjectRecord,
  type ProjectStore,
} from "../../src/server/projects";
import { createAutosaveController } from "../../src/features/editor/autosave";

async function fixture(): Promise<CarouselDocument> {
  return JSON.parse(
    await readFile(
      new URL("../fixtures/base-document.json", import.meta.url),
      "utf8",
    ),
  ) as CarouselDocument;
}

function project(document: CarouselDocument, revision = 1): ProjectRecord {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    title: document.title,
    platform: document.platform,
    document,
    revision,
    state: "draft",
    updatedAt: "2026-09-06T00:00:00.000Z",
  };
}

function store(overrides: Partial<ProjectStore> = {}): ProjectStore {
  return {
    create: vi.fn(),
    get: vi.fn(),
    list: vi.fn(),
    save: vi.fn(),
    listVersions: vi.fn(),
    restore: vi.fn(),
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("T023 project service", () => {
  it("creates an owner-bound project only after explicit local draft consent", async () => {
    const document = await fixture();
    const create = vi.fn().mockResolvedValue(project(document));
    const service = createProjectService({
      store: store({ create }),
      requestHashSecret: "test-only-request-hash-secret",
    });

    await expect(
      service.create(
        "owner-1",
        { document, localDraftId: "local-draft-1", explicitMigrationConsent: false },
        "create-operation-1",
      ),
    ).rejects.toMatchObject({ code: "MIGRATION_CONSENT_REQUIRED", status: 400 });
    expect(create).not.toHaveBeenCalled();

    await service.create(
      "owner-1",
      { document, localDraftId: "local-draft-1", explicitMigrationConsent: true },
      "create-operation-1",
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-1",
        title: document.title,
        platform: document.platform,
        document,
        idempotencyKey: "create-operation-1",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("rejects invalid documents before any database write", async () => {
    const save = vi.fn();
    const service = createProjectService({
      store: store({ save }),
      requestHashSecret: "test-only-request-hash-secret",
    });

    await expect(
      service.save(
        "owner-1",
        "00000000-0000-4000-8000-000000000001",
        { expectedRevision: 1, document: { schemaVersion: 99 } },
        "save-operation-1",
      ),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 422 });
    expect(save).not.toHaveBeenCalled();
  });

  it("passes CAS and idempotency data to the atomic save operation", async () => {
    const document = await fixture();
    const save = vi.fn().mockResolvedValue(project(document, 2));
    const service = createProjectService({
      store: store({ save }),
      requestHashSecret: "test-only-request-hash-secret",
    });

    const result = await service.save(
      "owner-1",
      "00000000-0000-4000-8000-000000000001",
      { expectedRevision: 1, document },
      "save-operation-1",
    );

    expect(result.revision).toBe(2);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        ownerId: "owner-1",
        expectedRevision: 1,
        idempotencyKey: "save-operation-1",
        requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      }),
    );
  });

  it("maps database conflicts without exposing database details", async () => {
    const document = await fixture();
    const service = createProjectService({
      store: store({
        save: vi.fn().mockRejectedValue(
          Object.assign(new Error("project revision conflict"), { code: "40001" }),
        ),
      }),
      requestHashSecret: "test-only-request-hash-secret",
    });

    await expect(
      service.save(
        "owner-1",
        "00000000-0000-4000-8000-000000000001",
        { expectedRevision: 1, document },
        "save-operation-1",
      ),
    ).rejects.toEqual(
      new ProjectServiceError(
        "VERSION_CONFLICT",
        "This project changed in another tab. Keep your local copy or load the cloud version.",
        409,
      ),
    );
  });

  it("uses only the service-role wrapper RPCs for project writes", async () => {
    const document = await fixture();
    const row = {
      id: "00000000-0000-4000-8000-000000000001",
      title: document.title,
      platform: document.platform,
      document,
      revision: 2,
      state: "draft",
      updated_at: "2026-09-06T00:00:02.000Z",
    };
    const query = {
      select: vi.fn(),
      eq: vi.fn(),
      in: vi.fn(),
      maybeSingle: vi.fn().mockResolvedValue({ data: row, error: null }),
    };
    query.select.mockReturnValue(query);
    query.eq.mockReturnValue(query);
    query.in.mockReturnValue(query);
    const client = {
      from: vi.fn().mockReturnValue(query),
      rpc: vi.fn().mockResolvedValue({
        data: { projectId: row.id, revision: 2 },
        error: null,
      }),
    };
    const projectStore = createSupabaseProjectStore(client as never);

    await projectStore.create({
      ownerId: "owner-1",
      title: document.title,
      platform: document.platform,
      document,
      idempotencyKey: "create-operation-1",
      requestHash: "a".repeat(64),
    });
    await projectStore.save({
      ownerId: "owner-1",
      projectId: row.id,
      expectedRevision: 1,
      title: document.title,
      platform: document.platform,
      document,
      idempotencyKey: "save-operation-1",
      requestHash: "b".repeat(64),
    });

    expect(client.rpc).toHaveBeenNthCalledWith(
      1,
      "server_create_project",
      expect.objectContaining({
        p_owner_id: "owner-1",
        p_idempotency_key: "create-operation-1",
        p_request_hash: "a".repeat(64),
      }),
    );
    expect(client.rpc).toHaveBeenNthCalledWith(
      2,
      "server_save_project",
      expect.objectContaining({
        p_owner_id: "owner-1",
        p_project_id: row.id,
        p_expected_revision: 1,
        p_idempotency_key: "save-operation-1",
        p_request_hash: "b".repeat(64),
      }),
    );
    expect(client.from).toHaveBeenCalledWith("projects");
  });
});

describe("T023 reliable autosave", () => {
  it("waits one second and reports saved only after the server confirms the write", async () => {
    vi.useFakeTimers();
    const initial = await fixture();
    const edited = { ...initial, title: "Edited once" };
    const pendingSave = deferred<{ revision: number; savedAt: string }>();
    const save = vi.fn().mockReturnValue(pendingSave.promise);
    const controller = createAutosaveController({
      initialDocument: initial,
      initialRevision: 1,
      delayMs: 1_000,
      readCloud: vi.fn(),
      save,
      persistLocal: vi.fn(),
      createOperationKey: () => "operation-1",
    });

    controller.updateDocument(edited);
    expect(controller.getSnapshot().status).toBe("dirty");
    await vi.advanceTimersByTimeAsync(999);
    expect(save).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(controller.getSnapshot().status).toBe("saving");

    pendingSave.resolve({ revision: 2, savedAt: "2026-09-06T00:00:01.000Z" });
    await vi.runAllTimersAsync();
    expect(controller.getSnapshot()).toMatchObject({
      status: "saved",
      revision: 2,
      document: edited,
    });
    controller.dispose();
    vi.useRealTimers();
  });

  it("queues edits made during a save for a second CAS write", async () => {
    vi.useFakeTimers();
    const initial = await fixture();
    const first = { ...initial, title: "First edit" };
    const second = { ...initial, title: "Second edit" };
    const firstSave = deferred<{ revision: number; savedAt: string }>();
    const save = vi
      .fn()
      .mockReturnValueOnce(firstSave.promise)
      .mockResolvedValueOnce({ revision: 3, savedAt: "2026-09-06T00:00:03.000Z" });
    let operation = 0;
    const controller = createAutosaveController({
      initialDocument: initial,
      initialRevision: 1,
      delayMs: 1_000,
      readCloud: vi.fn(),
      save,
      persistLocal: vi.fn(),
      createOperationKey: () => `operation-${++operation}`,
    });

    controller.updateDocument(first);
    await vi.advanceTimersByTimeAsync(1_000);
    controller.updateDocument(second);
    firstSave.resolve({ revision: 2, savedAt: "2026-09-06T00:00:02.000Z" });
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(save).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        expectedRevision: 2,
        document: second,
      }),
    );
    expect(controller.getSnapshot()).toMatchObject({ status: "saved", revision: 3 });
    controller.dispose();
    vi.useRealTimers();
  });

  it("reads the cloud revision on reconnect and preserves the local draft on conflict", async () => {
    vi.useFakeTimers();
    const initial = await fixture();
    const local = { ...initial, title: "Offline local edit" };
    const cloud = { ...initial, title: "Other tab edit" };
    const calls: string[] = [];
    const controller = createAutosaveController({
      initialDocument: initial,
      initialRevision: 1,
      delayMs: 1_000,
      readCloud: vi.fn(async () => {
        calls.push("read");
        return { document: cloud, revision: 2 };
      }),
      save: vi.fn(async () => {
        calls.push("save");
        return { revision: 3, savedAt: "2026-09-06T00:00:03.000Z" };
      }),
      persistLocal: vi.fn(),
      createOperationKey: () => "operation-1",
    });

    controller.setOnline(false);
    controller.updateDocument(local);
    await vi.advanceTimersByTimeAsync(1_000);
    await controller.setOnline(true);

    expect(calls).toEqual(["read"]);
    expect(controller.getSnapshot()).toMatchObject({
      status: "conflict",
      document: local,
      conflict: { localDocument: local, cloudDocument: cloud, cloudRevision: 2 },
    });
    controller.dispose();
    vi.useRealTimers();
  });

  it("loads the competing cloud document after a live CAS conflict", async () => {
    vi.useFakeTimers();
    const initial = await fixture();
    const local = { ...initial, title: "Unsaved local edit" };
    const cloud = { ...initial, title: "Saved in another tab" };
    const controller = createAutosaveController({
      initialDocument: initial,
      initialRevision: 1,
      delayMs: 1_000,
      readCloud: vi.fn().mockResolvedValue({ document: cloud, revision: 2 }),
      save: vi.fn().mockRejectedValue(
        Object.assign(new Error("conflict"), { code: "VERSION_CONFLICT" }),
      ),
      persistLocal: vi.fn(),
      createOperationKey: () => "operation-1",
    });

    controller.updateDocument(local);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(controller.getSnapshot()).toMatchObject({
      status: "conflict",
      document: local,
      conflict: { localDocument: local, cloudDocument: cloud, cloudRevision: 2 },
    });
    controller.dispose();
    vi.useRealTimers();
  });
});
