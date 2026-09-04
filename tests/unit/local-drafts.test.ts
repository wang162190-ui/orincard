import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import baseDocument from "../fixtures/base-document.json";
import { parseCarouselDocument } from "../../src/domain/document";
import {
  ANONYMOUS_DRAFT_TTL_MS,
  LocalDraftStore,
  type DraftOwner,
} from "../../src/features/editor/local-drafts";

const anonymous = (sessionId: string): DraftOwner => ({
  kind: "anonymous",
  sessionId,
});

const account = (userId: string): DraftOwner => ({ kind: "account", userId });

function createDocument(title: string) {
  return parseCarouselDocument({
    ...structuredClone(baseDocument),
    title,
  });
}

function createStore(
  indexedDB: IDBFactory,
  databaseName: string,
  now: () => number,
) {
  return new LocalDraftStore({ databaseName, indexedDB, now });
}

describe("local drafts", () => {
  it("expires and deletes anonymous drafts at the exact 24-hour boundary", async () => {
    const indexedDB = new IDBFactory();
    let currentTime = 1_000;
    const store = createStore(indexedDB, "expiry", () => currentTime);
    const owner = anonymous("session-a");

    await store.saveDraft(owner, "local-draft", createDocument("Anonymous"));

    currentTime += ANONYMOUS_DRAFT_TTL_MS - 1;
    expect((await store.loadDraft(owner, "local-draft"))?.document.title).toBe(
      "Anonymous",
    );

    currentTime += 1;
    expect(await store.loadDraft(owner, "local-draft")).toBeNull();

    currentTime = 1_000;
    expect(await store.loadDraft(owner, "local-draft")).toBeNull();
  });

  it("isolates identical draft IDs by anonymous session and account user", async () => {
    const indexedDB = new IDBFactory();
    const store = createStore(indexedDB, "isolation", () => 1_000);
    const owners = [
      anonymous("session-a"),
      anonymous("session-b"),
      account("user-a"),
      account("user-b"),
    ] as const;

    await Promise.all(
      owners.map((owner, index) =>
        store.saveDraft(
          owner,
          "local-shared-id",
          createDocument(`Owner ${index + 1}`),
        ),
      ),
    );

    await expect(
      Promise.all(
        owners.map(async (owner) =>
          (await store.loadDraft(owner, "local-shared-id"))?.document.title,
        ),
      ),
    ).resolves.toEqual(["Owner 1", "Owner 2", "Owner 3", "Owner 4"]);
  });

  it("does not migrate anonymous drafts without explicit consent", async () => {
    const indexedDB = new IDBFactory();
    const store = createStore(indexedDB, "no-consent", () => 1_000);

    await store.saveDraft(
      anonymous("session-a"),
      "local-draft",
      createDocument("Private draft"),
    );

    await expect(
      store.migrateAnonymousDrafts({
        sessionId: "session-a",
        userId: "user-a",
        consent: false,
      }),
    ).resolves.toEqual({ migrated: 0 });
    expect(
      await store.loadDraft(anonymous("session-a"), "local-draft"),
    ).not.toBeNull();
    expect(await store.loadDraft(account("user-a"), "local-draft")).toBeNull();
  });

  it("rolls back every write and deletion when an atomic migration conflicts", async () => {
    const indexedDB = new IDBFactory();
    const store = createStore(indexedDB, "atomic-migration", () => 1_000);
    const source = anonymous("session-a");
    const target = account("user-a");

    await store.saveDraft(source, "local-first", createDocument("First"));
    await store.saveDraft(source, "local-second", createDocument("Second"));
    await store.saveDraft(target, "local-second", createDocument("Existing"));

    await expect(
      store.migrateAnonymousDrafts({
        sessionId: "session-a",
        userId: "user-a",
        consent: true,
      }),
    ).rejects.toMatchObject({ name: "ConstraintError" });

    expect(await store.loadDraft(source, "local-first")).not.toBeNull();
    expect(await store.loadDraft(source, "local-second")).not.toBeNull();
    expect(await store.loadDraft(target, "local-first")).toBeNull();
    expect((await store.loadDraft(target, "local-second"))?.document.title).toBe(
      "Existing",
    );
  });

  it("moves every anonymous draft in one migration and marks it pending sync", async () => {
    const indexedDB = new IDBFactory();
    const store = createStore(indexedDB, "migration", () => 1_000);
    const source = anonymous("session-a");
    const target = account("user-a");

    await store.saveDraft(source, "local-first", createDocument("First"));
    await store.saveDraft(source, "local-second", createDocument("Second"));

    await expect(
      store.migrateAnonymousDrafts({
        sessionId: "session-a",
        userId: "user-a",
        consent: true,
      }),
    ).resolves.toEqual({ migrated: 2 });

    expect(await store.loadDraft(source, "local-first")).toBeNull();
    expect(await store.loadDraft(source, "local-second")).toBeNull();
    expect(await store.loadDraft(target, "local-first")).toMatchObject({
      syncState: "pending",
      document: { title: "First" },
    });
    expect(await store.loadDraft(target, "local-second")).toMatchObject({
      syncState: "pending",
      document: { title: "Second" },
    });
  });

  it("retains an account draft across a store refresh until sync succeeds", async () => {
    const indexedDB = new IDBFactory();
    const owner = account("user-a");
    const firstVisit = createStore(indexedDB, "refresh", () => 1_000);

    await firstVisit.saveDraft(
      owner,
      "local-unsynced",
      createDocument("Unsynced"),
    );
    await firstVisit.close();

    const refreshedVisit = createStore(indexedDB, "refresh", () => 90_000_000);
    expect(await refreshedVisit.loadDraft(owner, "local-unsynced")).toMatchObject(
      {
        syncState: "pending",
        document: { title: "Unsynced" },
      },
    );

    await refreshedVisit.deleteAfterSync(owner, "local-unsynced");
    expect(await refreshedVisit.loadDraft(owner, "local-unsynced")).toBeNull();
  });

  it("requires confirmation before clearing an unsynced account draft", async () => {
    const indexedDB = new IDBFactory();
    const store = createStore(indexedDB, "confirmed-clear", () => 1_000);
    const owner = account("user-a");

    await store.saveDraft(owner, "local-draft", createDocument("Keep me"));

    await expect(
      store.clearAccountDraft(owner, "local-draft", { confirmed: false }),
    ).resolves.toBe(false);
    expect(await store.loadDraft(owner, "local-draft")).not.toBeNull();

    await expect(
      store.clearAccountDraft(owner, "local-draft", { confirmed: true }),
    ).resolves.toBe(true);
    expect(await store.loadDraft(owner, "local-draft")).toBeNull();
  });
});
