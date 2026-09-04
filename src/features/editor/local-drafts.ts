import {
  parseCarouselDocument,
  type CarouselDocument,
} from "../../domain/document";

export const ANONYMOUS_DRAFT_TTL_MS = 24 * 60 * 60 * 1_000;

const DATABASE_NAME = "orincard-local-drafts";
const DATABASE_VERSION = 1;
const DRAFT_STORE = "drafts";
const OWNER_INDEX = "owner";

export type DraftOwner =
  | { readonly kind: "anonymous"; readonly sessionId: string }
  | { readonly kind: "account"; readonly userId: string };

export interface LocalDraft {
  readonly draftId: string;
  readonly owner: DraftOwner;
  readonly document: CarouselDocument;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly syncState: "local" | "pending";
}

interface StoredDraft extends LocalDraft {
  readonly key: string;
  readonly ownerKey: string;
}

interface LocalDraftStoreOptions {
  readonly databaseName?: string;
  readonly indexedDB?: IDBFactory;
  readonly now?: () => number;
}

interface MigrationRequest {
  readonly sessionId: string;
  readonly userId: string;
  readonly consent: boolean;
}

function identity(owner: DraftOwner): string {
  const value = owner.kind === "anonymous" ? owner.sessionId : owner.userId;
  if (!value.trim()) {
    throw new TypeError("Draft owner identity must not be empty.");
  }
  return value;
}

function ownerKey(owner: DraftOwner): string {
  return JSON.stringify([owner.kind, identity(owner)]);
}

function draftKey(owner: DraftOwner, draftId: string): string {
  if (!draftId.trim()) {
    throw new TypeError("Draft ID must not be empty.");
  }
  return JSON.stringify([owner.kind, identity(owner), draftId]);
}

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(request.error ?? new Error("IndexedDB request failed."));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  const completed = new Promise<void>((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(transaction.error ?? new Error("IndexedDB transaction was aborted."));
  });
  void completed.catch(() => undefined);
  return completed;
}

function isExpired(draft: StoredDraft, now: number): boolean {
  return (
    draft.owner.kind === "anonymous" &&
    now - draft.updatedAt >= ANONYMOUS_DRAFT_TTL_MS
  );
}

function publicDraft(draft: StoredDraft): LocalDraft {
  return {
    draftId: draft.draftId,
    owner: draft.owner,
    document: parseCarouselDocument(draft.document),
    createdAt: draft.createdAt,
    updatedAt: draft.updatedAt,
    syncState: draft.syncState,
  };
}

export class LocalDraftStore {
  private readonly databaseName: string;
  private readonly indexedDB: IDBFactory;
  private readonly now: () => number;
  private databasePromise?: Promise<IDBDatabase>;

  constructor(options: LocalDraftStoreOptions = {}) {
    const indexedDB = options.indexedDB ?? globalThis.indexedDB;
    if (!indexedDB) {
      throw new Error("IndexedDB is not available in this environment.");
    }

    this.databaseName = options.databaseName ?? DATABASE_NAME;
    this.indexedDB = indexedDB;
    this.now = options.now ?? Date.now;
  }

  async initialize(): Promise<{ readonly deleted: number }> {
    const database = await this.openDatabase();
    const transaction = database.transaction(DRAFT_STORE, "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore(DRAFT_STORE);
    const drafts = (await requestResult(store.getAll())) as StoredDraft[];
    const now = this.now();
    let deleted = 0;

    for (const draft of drafts) {
      if (isExpired(draft, now)) {
        store.delete(draft.key);
        deleted += 1;
      }
    }

    await completed;
    return { deleted };
  }

  async saveDraft(
    owner: DraftOwner,
    draftId: string,
    document: CarouselDocument,
  ): Promise<LocalDraft> {
    const database = await this.openDatabase();
    const transaction = database.transaction(DRAFT_STORE, "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore(DRAFT_STORE);
    const key = draftKey(owner, draftId);
    const existing = (await requestResult(store.get(key))) as
      | StoredDraft
      | undefined;
    const timestamp = this.now();
    const draft: StoredDraft = {
      key,
      ownerKey: ownerKey(owner),
      draftId,
      owner,
      document: parseCarouselDocument(document),
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
      syncState: owner.kind === "account" ? "pending" : "local",
    };

    store.put(draft);
    await completed;
    return publicDraft(draft);
  }

  async loadDraft(
    owner: DraftOwner,
    draftId: string,
  ): Promise<LocalDraft | null> {
    const database = await this.openDatabase();
    const transaction = database.transaction(DRAFT_STORE, "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore(DRAFT_STORE);
    const key = draftKey(owner, draftId);
    const draft = (await requestResult(store.get(key))) as StoredDraft | undefined;

    if (!draft) {
      await completed;
      return null;
    }

    if (isExpired(draft, this.now())) {
      store.delete(key);
      await completed;
      return null;
    }

    await completed;
    return publicDraft(draft);
  }

  async migrateAnonymousDrafts(
    request: MigrationRequest,
  ): Promise<{ readonly migrated: number }> {
    if (!request.consent) {
      return { migrated: 0 };
    }

    const sourceOwner: DraftOwner = {
      kind: "anonymous",
      sessionId: request.sessionId,
    };
    const targetOwner: DraftOwner = { kind: "account", userId: request.userId };
    const database = await this.openDatabase();
    const transaction = database.transaction(DRAFT_STORE, "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore(DRAFT_STORE);
    const drafts = (await requestResult(
      store.index(OWNER_INDEX).getAll(ownerKey(sourceOwner)),
    )) as StoredDraft[];
    let migrated = 0;

    for (const draft of drafts) {
      if (isExpired(draft, this.now())) {
        store.delete(draft.key);
        continue;
      }

      store.add({
        ...draft,
        key: draftKey(targetOwner, draft.draftId),
        ownerKey: ownerKey(targetOwner),
        owner: targetOwner,
        syncState: "pending",
      } satisfies StoredDraft);
      store.delete(draft.key);
      migrated += 1;
    }

    await completed;
    return { migrated };
  }

  async deleteAfterSync(owner: DraftOwner, draftId: string): Promise<boolean> {
    this.assertAccountOwner(owner);
    return this.deleteAccountDraft(owner, draftId);
  }

  async clearAccountDraft(
    owner: DraftOwner,
    draftId: string,
    options: { readonly confirmed: boolean },
  ): Promise<boolean> {
    this.assertAccountOwner(owner);
    if (!options.confirmed) {
      return false;
    }
    return this.deleteAccountDraft(owner, draftId);
  }

  async close(): Promise<void> {
    const databasePromise = this.databasePromise;
    if (!databasePromise) {
      return;
    }

    try {
      const database = await databasePromise;
      database.close();
    } finally {
      if (this.databasePromise === databasePromise) {
        this.databasePromise = undefined;
      }
    }
  }

  private async deleteAccountDraft(
    owner: DraftOwner,
    draftId: string,
  ): Promise<boolean> {
    const database = await this.openDatabase();
    const transaction = database.transaction(DRAFT_STORE, "readwrite");
    const completed = transactionCompletion(transaction);
    const store = transaction.objectStore(DRAFT_STORE);
    const key = draftKey(owner, draftId);
    const existing = await requestResult(store.getKey(key));

    if (existing !== undefined) {
      store.delete(key);
    }
    await completed;
    return existing !== undefined;
  }

  private assertAccountOwner(owner: DraftOwner): void {
    if (owner.kind !== "account") {
      throw new TypeError(
        "Only account drafts can be cleared after sync or confirmation.",
      );
    }
  }

  private openDatabase(): Promise<IDBDatabase> {
    if (this.databasePromise) {
      return this.databasePromise;
    }

    let databasePromise: Promise<IDBDatabase>;
    databasePromise = new Promise((resolve, reject) => {
      const request = this.indexedDB.open(this.databaseName, DATABASE_VERSION);
      let settled = false;

      const clearCachedPromise = () => {
        if (this.databasePromise === databasePromise) {
          this.databasePromise = undefined;
        }
      };

      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(DRAFT_STORE, {
          keyPath: "key",
        });
        store.createIndex(OWNER_INDEX, "ownerKey", { unique: false });
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => {
          database.close();
          clearCachedPromise();
        };
        if (settled) {
          database.close();
          return;
        }

        settled = true;
        resolve(database);
      };
      request.onerror = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearCachedPromise();
        reject(
          request.error ??
            new Error("Could not open the local draft database."),
        );
      };
      request.onblocked = () => {
        if (settled) {
          return;
        }

        settled = true;
        clearCachedPromise();
        reject(new Error("The local draft database upgrade is blocked."));
      };
    });
    this.databasePromise = databasePromise;

    return databasePromise;
  }
}
