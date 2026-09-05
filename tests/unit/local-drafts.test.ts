import { forceCloseDatabase, IDBFactory } from "fake-indexeddb";
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

function instrumentDatabaseOpen(
  indexedDB: IDBFactory,
  instrument: (request: IDBOpenDBRequest) => void,
): IDBFactory {
  return new Proxy(indexedDB, {
    get(target, property) {
      if (property !== "open") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (...arguments_: Parameters<IDBFactory["open"]>) => {
        const request = target.open(...arguments_);
        instrument(request);
        return request;
      };
    },
  });
}

function abortReadwriteTransactions(indexedDB: IDBFactory): IDBFactory {
  return instrumentDatabaseOpen(indexedDB, (request) => {
    request.addEventListener(
      "success",
      () => {
        const database = request.result;
        const transaction = database.transaction.bind(database);
        database.transaction = (
          ...arguments_: Parameters<IDBDatabase["transaction"]>
        ) => {
          const result = transaction(...arguments_);
          if (result.mode === "readwrite") {
            queueMicrotask(() => result.abort());
          }
          return result;
        };
      },
      { once: true },
    );
  });
}

function blockFirstOpen(indexedDB: IDBFactory): {
  readonly factory: IDBFactory;
  readonly lateConnection: () => IDBDatabase | undefined;
} {
  let firstOpen = true;
  let lateConnection: IDBDatabase | undefined;
  const factory = instrumentDatabaseOpen(indexedDB, (request) => {
    request.addEventListener("success", () => {
      lateConnection = request.result;
    });
    if (firstOpen) {
      firstOpen = false;
      queueMicrotask(() => {
        request.onblocked?.call(
          request,
          new Event("blocked") as IDBVersionChangeEvent,
        );
      });
    }
  });

  return { factory, lateConnection: () => lateConnection };
}

function throwFirstOpen(indexedDB: IDBFactory): IDBFactory {
  let firstOpen = true;

  return new Proxy(indexedDB, {
    get(target, property) {
      if (property !== "open") {
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      }

      return (...arguments_: Parameters<IDBFactory["open"]>) => {
        if (firstOpen) {
          firstOpen = false;
          throw new DOMException("Storage access is denied.", "SecurityError");
        }
        return target.open(...arguments_);
      };
    },
  });
}

describe("local drafts", () => {
  it("cleans every expired anonymous draft on app initialization without deleting account drafts", async () => {
    const indexedDB = new IDBFactory();
    let currentTime = 1_000;
    const firstVisit = createStore(indexedDB, "startup-cleanup", () => currentTime);

    await firstVisit.saveDraft(
      anonymous("expired-session"),
      "local-expired",
      createDocument("Expired"),
    );
    await firstVisit.saveDraft(
      account("user-a"),
      "local-account",
      createDocument("Account"),
    );
    currentTime += ANONYMOUS_DRAFT_TTL_MS - 1;
    await firstVisit.saveDraft(
      anonymous("fresh-session"),
      "local-fresh",
      createDocument("Fresh"),
    );
    await firstVisit.close();

    currentTime += 1;
    const reopened = createStore(indexedDB, "startup-cleanup", () => currentTime);
    await expect(reopened.initialize()).resolves.toEqual({ deleted: 1 });
    expect(
      await reopened.loadDraft(anonymous("expired-session"), "local-expired"),
    ).toBeNull();
    expect(
      await reopened.loadDraft(anonymous("fresh-session"), "local-fresh"),
    ).not.toBeNull();
    expect(await reopened.loadDraft(account("user-a"), "local-account"))
      .not.toBeNull();
  });

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

  it("does not leave an unhandled transaction rejection when a request aborts", async () => {
    const indexedDB = abortReadwriteTransactions(new IDBFactory());
    const store = createStore(indexedDB, "request-abort", () => 1_000);
    const unhandled: unknown[] = [];
    const listener = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", listener);

    try {
      await expect(
        store.saveDraft(
          anonymous("session-a"),
          "local-draft",
          createDocument("Aborted"),
        ),
      ).rejects.toMatchObject({ name: "AbortError" });
      await new Promise((resolve) => setTimeout(resolve, 0));
    } finally {
      process.off("unhandledRejection", listener);
    }

    expect(unhandled).toEqual([]);
  });

  it("closes a late connection after a blocked open and allows a retry", async () => {
    const controlled = blockFirstOpen(new IDBFactory());
    const store = createStore(controlled.factory, "blocked-open", () => 1_000);

    await expect(store.initialize()).rejects.toThrow(
      "The local draft database upgrade is blocked.",
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    let closedConnectionError: unknown;
    try {
      controlled.lateConnection()?.transaction("drafts");
    } catch (error) {
      closedConnectionError = error;
    }
    expect(closedConnectionError).toMatchObject({ name: "InvalidStateError" });
    await expect(store.initialize()).resolves.toEqual({ deleted: 0 });
  });

  it("closes its connection when another context requests a database upgrade", async () => {
    const indexedDB = new IDBFactory();
    const store = createStore(indexedDB, "version-change", () => 1_000);
    await store.initialize();

    const outcome = await new Promise<"blocked" | "upgraded">((resolve) => {
      const request = indexedDB.open("version-change", 2);
      request.onblocked = () => resolve("blocked");
      request.onsuccess = () => {
        request.result.close();
        resolve("upgraded");
      };
    });

    expect(outcome).toBe("upgraded");
  });

  it("reopens after the browser unexpectedly closes the cached connection", async () => {
    const indexedDB = new IDBFactory();
    let openCount = 0;
    let openedDatabase: IDBDatabase | undefined;
    const instrumented = instrumentDatabaseOpen(indexedDB, (request) => {
      openCount += 1;
      request.addEventListener(
        "success",
        () => {
          openedDatabase = request.result;
        },
        { once: true },
      );
    });
    const store = createStore(instrumented, "forced-close", () => 1_000);

    await store.initialize();
    if (!openedDatabase) {
      throw new Error("Expected the initial database connection to open.");
    }
    const closedDatabase = openedDatabase;
    const staleCloseHandler = closedDatabase.onclose;
    const closed = new Promise<void>((resolve) => {
      closedDatabase.addEventListener("close", () => resolve(), { once: true });
    });
    forceCloseDatabase(
      closedDatabase as unknown as Parameters<typeof forceCloseDatabase>[0],
    );
    await closed;

    await expect(store.initialize()).resolves.toEqual({ deleted: 0 });
    expect(openCount).toBe(2);
    staleCloseHandler?.call(closedDatabase, new Event("close"));
    await expect(store.initialize()).resolves.toEqual({ deleted: 0 });
    expect(openCount).toBe(2);
    await expect(
      store.saveDraft(
        anonymous("session-a"),
        "local-draft",
        createDocument("Recovered"),
      ),
    ).resolves.toMatchObject({ document: { title: "Recovered" } });
  });

  it("does not cache a synchronous database open failure", async () => {
    const indexedDB = throwFirstOpen(new IDBFactory());
    const store = createStore(indexedDB, "synchronous-open-error", () => 1_000);

    await expect(store.initialize()).rejects.toMatchObject({
      name: "SecurityError",
    });
    await expect(store.initialize()).resolves.toEqual({ deleted: 0 });
  });
});
