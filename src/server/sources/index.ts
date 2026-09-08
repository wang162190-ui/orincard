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
  // A BCP 47 tag the user picked for a recording, read back by the transcription path. A
  // language name is not content, which is why this one is allowed to live here.
  readonly language?: string;
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

// A parse failure is a service error too: the request was well formed, the source was not
// usable. Carrying the parser's own code out to the wire is what lets the page show the
// alternative action AC-002 requires instead of a generic message.
export type SourceServiceErrorCode =
  | "INVALID_REQUEST"
  | "EMPTY_SOURCE"
  | "AUTH_REQUIRED"
  | "IDEMPOTENCY_CONFLICT"
  | "OPERATION_EXPIRED"
  | "SERVICE_UNAVAILABLE"
  | SourceParseFailureCode;

export class SourceServiceError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: SourceServiceErrorCode,
    message: string,
    readonly status: number,
    retryable = false,
    readonly action?: SourceAlternativeAction,
  ) {
    super(message);
    this.name = "SourceServiceError";
    this.retryable = retryable;
  }
}

// 422 rather than 400: nothing about the request needs fixing, the source itself does.
export function sourceParseServiceError(failure: SourceParseFailure): SourceServiceError {
  return new SourceServiceError(
    failure.code,
    failure.message,
    failure.code === "SOURCE_TIMEOUT" || failure.code === "SOURCE_UNAVAILABLE" ? 503 : 422,
    failure.code === "SOURCE_TIMEOUT" || failure.code === "SOURCE_UNAVAILABLE",
    failure.action,
  );
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

// T043. The other two ways a source comes into being. Text arrives already readable, a URL
// is fetched and parsed inside the request that creates it, and a file is registered in
// `parsing` and handed to a worker. All three end at the same SourceRecord.

export type FileSourceKind = Extract<SourceKind, "pdf" | "slides" | "video">;

const FILE_SOURCE_KINDS: readonly FileSourceKind[] = ["pdf", "slides", "video"];

// A public page is small and the fetch happens inside an HTTP request, so the ceiling is
// far below the file limits: this budget has to fit in a response, not in a worker.
export const URL_PARSE_LIMITS: SourceParseLimits = {
  maxBytes: 2_000_000,
  maxSegments: 200,
  maxCharacters: 200_000,
  timeoutMs: 10_000,
};

const SOURCE_LIFETIME_MS = 7 * 24 * 60 * 60 * 1_000;

interface SourceRpcResponse {
  readonly sourceId: string;
  readonly expiresAt: string;
  readonly state: SourceState;
}

function readSourceRpcResponse(data: unknown): SourceRpcResponse {
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
  const state = response.state;
  return {
    sourceId: id,
    expiresAt,
    state: typeof state === "string" ? (state as SourceState) : "ready",
  };
}

// Both RPCs raise the same three SQLSTATEs for the same three situations, so the
// translation lives in one place rather than being repeated per store.
function sourceRpcError(error: unknown): SourceServiceError | undefined {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String((error as { code: unknown }).code)
      : "";
  if (code === "23505") {
    return new SourceServiceError(
      "IDEMPOTENCY_CONFLICT",
      "This Idempotency-Key was already used for a different source.",
      409,
    );
  }
  if (code === "55000") {
    return new SourceServiceError(
      "OPERATION_EXPIRED",
      "This source operation has expired. Start a new request.",
      410,
    );
  }
  if (code === "42501") {
    return new SourceServiceError(
      "SOURCE_UNAVAILABLE",
      "This file is not available to use as a source. Upload it again.",
      403,
      false,
      "upload-file",
    );
  }
  return undefined;
}

export interface UrlSourceWriteInput {
  readonly ownerId: string;
  readonly metadata: SourceMetadata;
  readonly segments: readonly SourceSegment[];
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface UrlSourceStore {
  create(input: UrlSourceWriteInput): Promise<SourceRecord>;
}

export function createSupabaseUrlSourceStore(
  client: SourceDatabaseClient,
): UrlSourceStore {
  return {
    async create(input) {
      const { data, error } = await client.rpc("server_create_url_source", {
        p_owner_id: input.ownerId,
        p_metadata: input.metadata,
        p_segments: input.segments,
        p_expires_at: input.expiresAt,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
      });
      if (error || !data) {
        const translated = sourceRpcError(error);
        if (translated) throw translated;
        throw error instanceof Error ? error : new Error("URL source insert failed");
      }
      const response = readSourceRpcResponse(data);
      return {
        id: response.sourceId,
        ownerId: input.ownerId,
        kind: "url",
        metadata: input.metadata,
        segments: input.segments,
        state: response.state,
        expiresAt: response.expiresAt,
      };
    },
  };
}

export interface FileSourceWriteInput {
  readonly ownerId: string;
  readonly kind: FileSourceKind;
  readonly assetId: string;
  readonly metadata: SourceMetadata;
  readonly expiresAt: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface FileSourceStore {
  create(input: FileSourceWriteInput): Promise<SourceRecord>;
}

export function createSupabaseFileSourceStore(
  client: SourceDatabaseClient,
): FileSourceStore {
  return {
    async create(input) {
      const { data, error } = await client.rpc("server_create_file_source", {
        p_owner_id: input.ownerId,
        p_kind: input.kind,
        p_asset_id: input.assetId,
        p_metadata: input.metadata,
        p_expires_at: input.expiresAt,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
      });
      if (error || !data) {
        const translated = sourceRpcError(error);
        if (translated) throw translated;
        throw error instanceof Error ? error : new Error("File source insert failed");
      }
      const response = readSourceRpcResponse(data);
      return {
        id: response.sourceId,
        ownerId: input.ownerId,
        kind: input.kind,
        assetId: input.assetId,
        metadata: input.metadata,
        segments: [],
        state: response.state,
        expiresAt: response.expiresAt,
      };
    },
  };
}

function requireIdempotencyKey(key: string): void {
  if (!/^[\x21-\x7e]{8,200}$/.test(key)) {
    throw new SourceServiceError(
      "INVALID_REQUEST",
      "A valid Idempotency-Key is required.",
      400,
    );
  }
}

function requireOwner(ownerId: string): void {
  if (!ownerId) {
    throw new SourceServiceError("AUTH_REQUIRED", "Sign in before saving a source.", 401);
  }
}

function requestHashOf(secret: string, value: unknown): string {
  return createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
}

// Only what a browser would follow to a public page. Everything the fetcher itself refuses
// — private addresses, redirects that leave the allowed ports — is decided later, on the
// resolved address rather than on the text of the URL.
function parseUrlInput(body: { readonly url?: unknown }): string {
  if (typeof body.url !== "string" || body.url.trim().length === 0) {
    throw new SourceServiceError("INVALID_REQUEST", "url is required.", 400);
  }
  const value = body.url.trim();
  if (value.length > 2_048) {
    throw new SourceServiceError("INVALID_REQUEST", "This URL is too long.", 400);
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SourceServiceError("INVALID_REQUEST", "Enter a complete https:// link.", 400);
  }
  if (parsed.protocol !== "https:") {
    throw new SourceServiceError(
      "SOURCE_BLOCKED",
      "Only https links can be imported. Paste the text instead.",
      422,
      false,
      "paste-text",
    );
  }
  return parsed.toString();
}

export function createUrlSourceService(input: {
  readonly store: UrlSourceStore;
  readonly parser: SourceParser<string>;
  readonly requestHashSecret: string;
  readonly limits?: SourceParseLimits;
  readonly now?: () => Date;
}) {
  if (!input.requestHashSecret) {
    throw new Error("A server-only request hash secret is required");
  }
  const now = input.now ?? (() => new Date());
  const limits = input.limits ?? URL_PARSE_LIMITS;

  return {
    async create(
      ownerId: string,
      body: { readonly url?: unknown },
      idempotencyKey: string,
    ): Promise<SourceRecord> {
      requireOwner(ownerId);
      requireIdempotencyKey(idempotencyKey);
      const url = parseUrlInput(body);
      const parsed = await input.parser.parse(url, limits);
      // A page we could not read is never saved as an empty source; the caller gets the
      // parser's own alternative action instead.
      if (!parsed.ok) throw sourceParseServiceError(parsed);
      try {
        return await input.store.create({
          ownerId,
          metadata: { ...parsed.metadata, publicUrl: url },
          segments: parsed.segments,
          expiresAt: new Date(now().getTime() + SOURCE_LIFETIME_MS).toISOString(),
          idempotencyKey,
          requestHash: requestHashOf(input.requestHashSecret, { kind: "url", url }),
        });
      } catch (error) {
        if (error instanceof SourceServiceError) throw error;
        throw new SourceServiceError(
          "SERVICE_UNAVAILABLE",
          "Sources are temporarily unavailable. Your link was not saved.",
          503,
          true,
        );
      }
    },
  };
}

export interface SourceParseDispatchPayload {
  readonly sourceId: string;
  readonly schemaVersion: 1;
  readonly requestId: string;
}

// Reference-only, like every other worker payload in this codebase: the file stays in the
// bucket and the worker reads the row to learn what to do with it.
export interface SourceParseDispatcher {
  trigger(payload: SourceParseDispatchPayload, idempotencyKey: string): Promise<unknown>;
}

// Both imports are deferred so that a route which only ever creates a text source does not
// carry the Trigger SDK, and through it the parsers, into its bundle.
export const sourceParseDispatcher: SourceParseDispatcher = {
  async trigger(payload, key) {
    const [{ idempotencyKeys, tasks }, { PARSE_SOURCE_TASK_ID }] = await Promise.all([
      import("@trigger.dev/sdk"),
      import("../../trigger/dispatch"),
    ]);
    const idempotencyKey = await idempotencyKeys.create(key, { scope: "global" });
    return tasks.trigger(PARSE_SOURCE_TASK_ID, payload, { idempotencyKey });
  },
};

function parseFileInput(body: {
  readonly kind?: unknown;
  readonly assetId?: unknown;
  readonly title?: unknown;
  readonly language?: unknown;
}): {
  readonly kind: FileSourceKind;
  readonly assetId: string;
  readonly metadata: SourceMetadata;
} {
  if (!FILE_SOURCE_KINDS.includes(body.kind as FileSourceKind)) {
    throw new SourceServiceError("INVALID_REQUEST", "kind must be pdf, slides or video.", 400);
  }
  if (
    typeof body.assetId !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.assetId)
  ) {
    throw new SourceServiceError("INVALID_REQUEST", "assetId must be an uploaded file.", 400);
  }
  const title =
    typeof body.title === "string" && body.title.trim() ? body.title.trim().slice(0, 200) : undefined;
  if (body.language !== undefined && typeof body.language !== "string") {
    throw new SourceServiceError("INVALID_REQUEST", "language must be a string.", 400);
  }
  const language =
    typeof body.language === "string" && /^[a-z]{2}(-[A-Za-z0-9]{2,8})?$/.test(body.language)
      ? body.language
      : undefined;
  return {
    kind: body.kind as FileSourceKind,
    assetId: body.assetId,
    // characterCount is 0 until a parser finishes; the row is not readable until then, so
    // this is a placeholder rather than a claim about the file.
    metadata: {
      characterCount: 0,
      ...(title ? { title } : {}),
      ...(language ? { language } : {}),
    },
  };
}

export function createFileSourceService(input: {
  readonly store: FileSourceStore;
  readonly dispatcher: SourceParseDispatcher;
  readonly requestHashSecret: string;
  readonly now?: () => Date;
}) {
  if (!input.requestHashSecret) {
    throw new Error("A server-only request hash secret is required");
  }
  const now = input.now ?? (() => new Date());

  return {
    async create(
      ownerId: string,
      body: Record<string, unknown>,
      idempotencyKey: string,
      requestId: string,
    ): Promise<SourceRecord> {
      requireOwner(ownerId);
      requireIdempotencyKey(idempotencyKey);
      const file = parseFileInput(body);
      let source: SourceRecord;
      try {
        source = await input.store.create({
          ownerId,
          kind: file.kind,
          assetId: file.assetId,
          metadata: file.metadata,
          expiresAt: new Date(now().getTime() + SOURCE_LIFETIME_MS).toISOString(),
          idempotencyKey,
          requestHash: requestHashOf(input.requestHashSecret, {
            kind: file.kind,
            assetId: file.assetId,
          }),
        });
      } catch (error) {
        if (error instanceof SourceServiceError) throw error;
        throw new SourceServiceError(
          "SERVICE_UNAVAILABLE",
          "Sources are temporarily unavailable. Your file was not registered.",
          503,
          true,
        );
      }
      // The row exists before the worker is asked to do anything, so a failed dispatch
      // leaves a source stuck in `parsing` rather than a worker with nothing to read. A
      // replayed request re-uses the same key and does not queue a second parse.
      if (source.state === "parsing") {
        try {
          await input.dispatcher.trigger(
            { sourceId: source.id, schemaVersion: 1, requestId },
            `source:${source.id}:parse`,
          );
        } catch {
          throw new SourceServiceError(
            "SERVICE_UNAVAILABLE",
            "This file was saved but could not be queued for reading. Try again in a moment.",
            503,
            true,
          );
        }
      }
      return source;
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
        // Present only when there is something concrete for the reader to do instead.
        ...(failure.action ? { action: failure.action } : {}),
      },
      requestId,
    },
    { status: failure.status },
  );
}
