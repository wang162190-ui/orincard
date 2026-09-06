import { randomUUID } from "node:crypto";

export type TextSourceKind = "topic" | "text";

export interface SourceSegment {
  readonly segmentId: string;
  readonly text: string;
}

export interface SourceRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: TextSourceKind;
  readonly metadata: { readonly characterCount: number };
  readonly segments: readonly SourceSegment[];
  readonly state: "ready";
  readonly expiresAt: string;
}

export interface SourceWriteInput extends Omit<SourceRecord, "id"> {}

export interface SourceStore {
  create(input: SourceWriteInput): Promise<SourceRecord>;
}

export type SourceServiceErrorCode =
  | "INVALID_REQUEST"
  | "EMPTY_SOURCE"
  | "AUTH_REQUIRED"
  | "SERVICE_UNAVAILABLE";

export class SourceServiceError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: SourceServiceErrorCode,
    message: string,
    readonly status: number,
    retryable = false,
  ) {
    super(message);
    this.name = "SourceServiceError";
    this.retryable = retryable;
  }
}

interface SourceRow {
  readonly id: string;
  readonly owner_id: string;
  readonly kind: TextSourceKind;
  readonly metadata: { readonly characterCount: number };
  readonly segments: readonly SourceSegment[];
  readonly state: "ready";
  readonly expires_at: string;
}

interface SourceDatabaseClient {
  from(table: string): {
    insert(values: Record<string, unknown>): {
      select(columns: string): {
        single(): PromiseLike<{ readonly data: unknown; readonly error: unknown }>;
      };
    };
  };
}

function fromRow(row: SourceRow): SourceRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    metadata: row.metadata,
    segments: row.segments,
    state: row.state,
    expiresAt: row.expires_at,
  };
}

export function createSupabaseSourceStore(
  client: SourceDatabaseClient,
): SourceStore {
  return {
    async create(input) {
      const { data, error } = await client
        .from("sources")
        .insert({
          owner_id: input.ownerId,
          kind: input.kind,
          metadata: input.metadata,
          segments: input.segments,
          state: input.state,
          expires_at: input.expiresAt,
        })
        .select("id,owner_id,kind,metadata,segments,state,expires_at")
        .single();
      if (error || !data) {
        throw error instanceof Error ? error : new Error("Source insert failed");
      }
      return fromRow(data as SourceRow);
    },
  };
}

function inputLimit(kind: TextSourceKind): number {
  return kind === "topic" ? 500 : 30_000;
}

function parseInput(body: {
  readonly kind?: unknown;
  readonly text?: unknown;
}): { readonly kind: TextSourceKind; readonly text: string } {
  if (body.kind !== "topic" && body.kind !== "text") {
    throw new SourceServiceError(
      "INVALID_REQUEST",
      "kind must be topic or text.",
      400,
    );
  }
  if (typeof body.text !== "string") {
    throw new SourceServiceError(
      "INVALID_REQUEST",
      "text must be a string.",
      400,
    );
  }
  const text = body.text.trim();
  if (!text) {
    throw new SourceServiceError(
      "EMPTY_SOURCE",
      "Enter a topic or paste text before continuing.",
      422,
    );
  }
  if (Array.from(text).length > inputLimit(body.kind)) {
    throw new SourceServiceError(
      "INVALID_REQUEST",
      `${body.kind === "topic" ? "Topic" : "Text"} exceeds the allowed length.`,
      400,
    );
  }
  return { kind: body.kind, text };
}

export function createTextSourceService(input: {
  readonly store: SourceStore;
  readonly now?: () => Date;
  readonly createId?: () => string;
}) {
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;

  return {
    async create(
      ownerId: string,
      body: { readonly kind?: unknown; readonly text?: unknown },
    ): Promise<SourceRecord> {
      if (!ownerId) {
        throw new SourceServiceError(
          "AUTH_REQUIRED",
          "Sign in before saving a source.",
          401,
        );
      }
      const source = parseInput(body);
      const expiresAt = new Date(now().getTime() + 7 * 24 * 60 * 60 * 1_000);
      try {
        return await input.store.create({
          ownerId,
          kind: source.kind,
          metadata: { characterCount: Array.from(source.text).length },
          segments: [{ segmentId: createId(), text: source.text }],
          state: "ready",
          expiresAt: expiresAt.toISOString(),
        });
      } catch (error) {
        if (error instanceof SourceServiceError) {
          throw error;
        }
        throw new SourceServiceError(
          "SERVICE_UNAVAILABLE",
          "Sources are temporarily unavailable. Your input was not saved.",
          503,
          true,
        );
      }
    },
  };
}

export function sourceErrorResponse(error: unknown, requestId: string): Response {
  const failure =
    error instanceof SourceServiceError
      ? error
      : new SourceServiceError(
          "SERVICE_UNAVAILABLE",
          "Sources are temporarily unavailable. Your input was not saved.",
          503,
          true,
        );
  return Response.json(
    {
      error: {
        code: failure.code,
        message: failure.message,
        retryable: failure.retryable,
      },
      requestId,
    },
    { status: failure.status },
  );
}
