import { createHmac, randomUUID } from "node:crypto";

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

export interface SourceWriteInput extends Omit<SourceRecord, "id"> {
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface SourceStore {
  create(input: SourceWriteInput): Promise<SourceRecord>;
}

export type SourceServiceErrorCode =
  | "INVALID_REQUEST"
  | "EMPTY_SOURCE"
  | "AUTH_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "OPERATION_EXPIRED"
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

interface SourceDatabaseClient {
  rpc(
    name: string,
    parameters: Readonly<Record<string, unknown>>,
  ): PromiseLike<{ readonly data: unknown; readonly error: unknown }>;
}

export function createSupabaseSourceStore(
  client: SourceDatabaseClient,
): SourceStore {
  return {
    async create(input) {
      const { data, error } = await client.rpc("server_create_text_source", {
        p_owner_id: input.ownerId,
        p_kind: input.kind,
        p_metadata: input.metadata,
        p_segments: input.segments,
        p_expires_at: input.expiresAt,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
      });
      if (error || !data) {
        const code = typeof error === "object" && error !== null && "code" in error
          ? String(error.code)
          : "";
        if (code === "23505") {
          throw new SourceServiceError(
            "IDEMPOTENCY_CONFLICT",
            "This Idempotency-Key was already used for different source text.",
            409,
          );
        }
        if (code === "55000") {
          throw new SourceServiceError(
            "OPERATION_EXPIRED",
            "This source operation has expired. Start a new request.",
            410,
          );
        }
        throw error instanceof Error ? error : new Error("Source insert failed");
      }
      const value = Array.isArray(data) ? data[0] : data;
      if (typeof value !== "object" || value === null) {
        throw new Error("Source RPC returned no source");
      }
      const response = value as Record<string, unknown>;
      const id = response.sourceId ?? response.source_id ?? response.id;
      const expiresAt = response.expiresAt ?? response.expires_at;
      if (typeof id !== "string" || typeof expiresAt !== "string") {
        throw new Error("Source RPC returned an invalid source");
      }
      return {
        id,
        ownerId: input.ownerId,
        kind: input.kind,
        metadata: input.metadata,
        segments: input.segments,
        state: "ready",
        expiresAt,
      };
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
  readonly requestHashSecret: string;
  readonly now?: () => Date;
  readonly createId?: () => string;
}) {
  if (!input.requestHashSecret) {
    throw new Error("A server-only request hash secret is required");
  }
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;

  return {
    async create(
      ownerId: string,
      body: { readonly kind?: unknown; readonly text?: unknown },
      idempotencyKey: string,
    ): Promise<SourceRecord> {
      if (!ownerId) {
        throw new SourceServiceError(
          "AUTH_REQUIRED",
          "Sign in before saving a source.",
          401,
        );
      }
      if (!/^[\x21-\x7e]{8,200}$/.test(idempotencyKey)) {
        throw new SourceServiceError(
          "INVALID_REQUEST",
          "A valid Idempotency-Key is required.",
          400,
        );
      }
      const source = parseInput(body);
      const expiresAt = new Date(now().getTime() + 7 * 24 * 60 * 60 * 1_000);
      const requestHash = createHmac("sha256", input.requestHashSecret)
        .update(JSON.stringify(source))
        .digest("hex");
      try {
        return await input.store.create({
          ownerId,
          kind: source.kind,
          metadata: { characterCount: Array.from(source.text).length },
          segments: [{ segmentId: createId(), text: source.text }],
          state: "ready",
          expiresAt: expiresAt.toISOString(),
          idempotencyKey,
          requestHash,
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
