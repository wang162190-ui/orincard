import { createHmac, randomUUID } from "node:crypto";

export type TextSourceKind = "topic" | "text";

// The six values public.source_kind already accepts. Text stays a subtype so the B04
// paths that only ever handle topic and text keep their narrower type.
export type SourceKind = TextSourceKind | "url" | "pdf" | "slides" | "video";

export type SourceState = "uploading" | "parsing" | "ready" | "failed" | "deleted";

// Page, slide or timestamp anchors let a citation point back at the original input.
export type SourceSegmentLocator =
  | { readonly kind: "page"; readonly page: number }
  | { readonly kind: "slide"; readonly slide: number }
  | { readonly kind: "time"; readonly startSeconds: number; readonly endSeconds: number };

export interface SourceSegment {
  readonly segmentId: string;
  readonly text: string;
  readonly locator?: SourceSegmentLocator;
}

// Safe metadata only: a title, a public URL, counts and durations. Raw input text lives
// in segments, which expire, and never in here.
export interface SourceMetadata {
  readonly characterCount: number;
  readonly title?: string;
  readonly publicUrl?: string;
  readonly pageCount?: number;
  readonly slideCount?: number;
  readonly durationSeconds?: number;
  readonly ocrPageCount?: number;
  readonly truncated?: boolean;
}

export interface SourceRecord {
  readonly id: string;
  readonly ownerId: string;
  readonly kind: SourceKind;
  readonly assetId?: string | null;
  readonly metadata: SourceMetadata;
  readonly segments: readonly SourceSegment[];
  readonly state: SourceState;
  readonly expiresAt: string;
}

export type SourceParseFailureCode =
  | "SOURCE_ENCRYPTED"
  | "SOURCE_NO_TEXT_LAYER"
  | "SOURCE_EMPTY"
  | "SOURCE_TOO_LARGE"
  | "SOURCE_UNSUPPORTED_FORMAT"
  | "SOURCE_MALFORMED"
  | "SOURCE_BLOCKED"
  | "SOURCE_UNAVAILABLE"
  | "SOURCE_TIMEOUT";

// AC-002 requires an invalid source to show a concrete alternative, not just an error.
export type SourceAlternativeAction =
  | "paste-text"
  | "upload-file"
  | "use-public-url"
  | "remove-pdf-protection"
  | "convert-to-pptx"
  | "use-smaller-file"
  | "split-input"
  | "retry-later";

export interface SourceParseFailure {
  readonly ok: false;
  readonly code: SourceParseFailureCode;
  readonly action: SourceAlternativeAction;
  readonly message: string;
}

export interface SourceParseSuccess {
  readonly ok: true;
  readonly segments: readonly SourceSegment[];
  readonly metadata: SourceMetadata;
}

export type SourceParseResult = SourceParseSuccess | SourceParseFailure;

export interface SourceParseLimits {
  readonly maxBytes: number;
  readonly maxSegments: number;
  readonly maxCharacters: number;
  readonly timeoutMs: number;
}

// Every parser takes a different input — a URL, a downloaded file, an asset row — so the
// input type stays open while the result contract does not.
export interface SourceParser<TInput> {
  readonly kind: SourceKind;
  parse(input: TInput, limits: SourceParseLimits): Promise<SourceParseResult>;
}

const FAILURE_DEFAULTS: Readonly<
  Record<SourceParseFailureCode, { readonly action: SourceAlternativeAction; readonly message: string }>
> = {
  SOURCE_ENCRYPTED: {
    action: "remove-pdf-protection",
    message: "This file is password protected. Remove the protection and upload it again.",
  },
  SOURCE_NO_TEXT_LAYER: {
    action: "paste-text",
    message: "No readable text was found in this file. Paste the text instead.",
  },
  SOURCE_EMPTY: {
    action: "paste-text",
    message: "This source has no text to work with. Paste the text instead.",
  },
  SOURCE_TOO_LARGE: {
    action: "use-smaller-file",
    message: "This source is over the size limit. Upload a smaller file.",
  },
  SOURCE_UNSUPPORTED_FORMAT: {
    action: "convert-to-pptx",
    message: "This format can't be imported. Convert it to .pptx and try again.",
  },
  SOURCE_MALFORMED: {
    action: "upload-file",
    message: "This file could not be read. Upload the original file again.",
  },
  SOURCE_BLOCKED: {
    action: "paste-text",
    message: "This link can't be imported. Paste the public text instead.",
  },
  SOURCE_UNAVAILABLE: {
    action: "use-public-url",
    message: "This source could not be reached. Use a public link instead.",
  },
  SOURCE_TIMEOUT: {
    action: "retry-later",
    message: "Reading this source took too long. Try again in a moment.",
  },
};

export function sourceParseFailure(
  code: SourceParseFailureCode,
  overrides: { readonly action?: SourceAlternativeAction; readonly message?: string } = {},
): SourceParseFailure {
  const fallback = FAILURE_DEFAULTS[code];
  return {
    ok: false,
    code,
    action: overrides.action ?? fallback.action,
    message: overrides.message ?? fallback.message,
  };
}

// AC-002 forbids a failed source from looking like an empty success, so parsers build
// their result here instead of assembling the object themselves: no text means a typed
// failure with an alternative action, never `ok: true` with nothing in it.
export function sourceParseResult(
  segments: readonly SourceSegment[],
  metadata: Omit<SourceMetadata, "characterCount">,
  emptyCode: SourceParseFailureCode = "SOURCE_EMPTY",
): SourceParseResult {
  const kept = segments.filter((segment) => segment.text.trim().length > 0);
  if (kept.length === 0) return sourceParseFailure(emptyCode);
  const characterCount = kept.reduce(
    (total, segment) => total + Array.from(segment.text).length,
    0,
  );
  return { ok: true, segments: kept, metadata: { ...metadata, characterCount } };
}

// Narrower than SourceRecord on purpose: this store is backed by
// server_create_text_source, which rejects anything that is not topic or text and is
// only ever handed an already parsed, ready source.
export interface SourceWriteInput extends Omit<SourceRecord, "id" | "kind" | "state"> {
  readonly kind: TextSourceKind;
  readonly state: "ready";
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
