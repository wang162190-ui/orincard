import type { CarouselDocument } from "../../domain/document";

export type AutosaveStatus =
  | "idle"
  | "dirty"
  | "saving"
  | "saved"
  | "offline"
  | "conflict"
  | "error";

export interface AutosaveConflict {
  readonly localDocument: CarouselDocument;
  readonly cloudDocument: CarouselDocument;
  readonly cloudRevision: number;
}

export interface AutosaveSnapshot {
  readonly status: AutosaveStatus;
  readonly document: CarouselDocument;
  readonly revision: number;
  readonly savedAt?: string;
  readonly conflict?: AutosaveConflict;
}

export interface AutosaveSaveInput {
  readonly expectedRevision: number;
  readonly document: CarouselDocument;
  readonly idempotencyKey: string;
}

export function createAutosaveController(input: {
  readonly initialDocument: CarouselDocument;
  readonly initialRevision: number;
  readonly delayMs?: number;
  readonly readCloud: () => Promise<{
    readonly document: CarouselDocument;
    readonly revision: number;
  }>;
  readonly save: (input: AutosaveSaveInput) => Promise<{
    readonly revision: number;
    readonly savedAt: string;
  }>;
  readonly persistLocal: (document: CarouselDocument) => void | Promise<void>;
  readonly createOperationKey?: () => string;
  readonly onChange?: (snapshot: AutosaveSnapshot) => void;
}) {
  const delayMs = input.delayMs ?? 1_000;
  let snapshot: AutosaveSnapshot = {
    status: "idle",
    document: input.initialDocument,
    revision: input.initialRevision,
  };
  let online = true;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  let saving = false;
  let editVersion = 0;
  let savedEditVersion = 0;
  let lastEditAt = Date.now();
  let pendingOperation:
    | { readonly editVersion: number; readonly idempotencyKey: string }
    | undefined;

  const notify = (next: AutosaveSnapshot) => {
    snapshot = next;
    input.onChange?.(snapshot);
  };

  const persist = (document: CarouselDocument) => {
    void Promise.resolve(input.persistLocal(document)).catch(() => {
      if (!disposed) {
        notify({ ...snapshot, status: "error", document });
      }
    });
  };

  const clearTimer = () => {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };

  const operationKey = () =>
    input.createOperationKey?.() ?? globalThis.crypto.randomUUID();

  const schedule = (wait = delayMs) => {
    clearTimer();
    if (disposed || !online || snapshot.status === "conflict") {
      return;
    }
    timer = setTimeout(() => {
      timer = undefined;
      void flush();
    }, wait);
  };

  const flush = async (): Promise<void> => {
    if (
      disposed ||
      saving ||
      !online ||
      snapshot.status === "conflict" ||
      editVersion === savedEditVersion
    ) {
      return;
    }

    const savingEditVersion = editVersion;
    const savingDocument = snapshot.document;
    if (!pendingOperation || pendingOperation.editVersion !== savingEditVersion) {
      pendingOperation = {
        editVersion: savingEditVersion,
        idempotencyKey: operationKey(),
      };
    }
    const idempotencyKey = pendingOperation.idempotencyKey;
    saving = true;
    notify({ ...snapshot, status: "saving", conflict: undefined });

    try {
      const result = await input.save({
        expectedRevision: snapshot.revision,
        document: savingDocument,
        idempotencyKey,
      });
      if (disposed) {
        return;
      }
      savedEditVersion = savingEditVersion;
      pendingOperation = undefined;
      const hasNewerEdit = editVersion !== savingEditVersion;
      notify({
        ...snapshot,
        status: hasNewerEdit ? "dirty" : "saved",
        revision: result.revision,
        savedAt: result.savedAt,
        conflict: undefined,
      });
      saving = false;
      if (hasNewerEdit) {
        schedule(Math.max(0, lastEditAt + delayMs - Date.now()));
      }
    } catch (error) {
      if (
        !disposed &&
        online &&
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "VERSION_CONFLICT"
      ) {
        try {
          const cloud = await input.readCloud();
          if (!disposed) {
            notify({
              ...snapshot,
              status: "conflict",
              conflict: {
                localDocument: snapshot.document,
                cloudDocument: cloud.document,
                cloudRevision: cloud.revision,
              },
            });
          }
        } catch {
          if (!disposed) {
            notify({ ...snapshot, status: "error", conflict: undefined });
          }
        }
      } else if (!disposed) {
        notify({
          ...snapshot,
          status: online ? "error" : "offline",
          conflict: undefined,
        });
      }
    } finally {
      saving = false;
    }
  };

  return {
    getSnapshot: () => snapshot,

    updateDocument(document: CarouselDocument): void {
      if (disposed) {
        return;
      }
      editVersion += 1;
      lastEditAt = Date.now();
      pendingOperation = undefined;
      notify({
        ...snapshot,
        status: online ? "dirty" : "offline",
        document,
        conflict: undefined,
      });
      persist(document);
      schedule();
    },

    async setOnline(nextOnline: boolean): Promise<void> {
      if (disposed || online === nextOnline) {
        return;
      }
      online = nextOnline;
      clearTimer();
      if (!online) {
        notify({ ...snapshot, status: "offline", conflict: undefined });
        return;
      }

      try {
        const cloud = await input.readCloud();
        if (disposed) {
          return;
        }
        const hasLocalChanges = editVersion !== savedEditVersion;
        if (cloud.revision !== snapshot.revision && hasLocalChanges) {
          notify({
            ...snapshot,
            status: "conflict",
            conflict: {
              localDocument: snapshot.document,
              cloudDocument: cloud.document,
              cloudRevision: cloud.revision,
            },
          });
          return;
        }
        if (cloud.revision !== snapshot.revision) {
          editVersion += 1;
          savedEditVersion = editVersion;
          notify({
            status: "saved",
            document: cloud.document,
            revision: cloud.revision,
          });
          persist(cloud.document);
          return;
        }
        notify({ ...snapshot, status: hasLocalChanges ? "dirty" : "saved" });
        if (hasLocalChanges) {
          await flush();
        }
      } catch {
        if (!disposed) {
          online = false;
          notify({ ...snapshot, status: "offline", conflict: undefined });
        }
      }
    },

    async flush(): Promise<void> {
      clearTimer();
      await flush();
    },

    useCloudVersion(): void {
      if (snapshot.status !== "conflict" || !snapshot.conflict) {
        return;
      }
      editVersion += 1;
      savedEditVersion = editVersion;
      const cloud = snapshot.conflict;
      notify({
        status: "saved",
        document: cloud.cloudDocument,
        revision: cloud.cloudRevision,
      });
      persist(cloud.cloudDocument);
    },

    dispose(): void {
      disposed = true;
      clearTimer();
    },
  };
}
