import { createHash, createHmac, randomUUID } from "node:crypto";

export type UploadPurpose = "source" | "media";

export type UploadBucket = "sources" | "assets";

// Development limit from the processing contract. Production stays here until a resource
// test says otherwise, so the number lives in one place instead of in each caller.
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;

// Declared and sniffed types are checked against the same table: a client that announces
// a type outside it is refused before an intent row exists, and a file whose real bytes
// fall outside it is refused before the asset can become ready.
const ALLOWED_MIME: Readonly<Record<UploadPurpose, readonly string[]>> = {
  source: [
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "video/mp4",
    "video/webm",
  ],
  media: ["image/png", "image/jpeg", "image/webp", "image/gif"],
};

export type UploadErrorCode =
  | "INVALID_REQUEST"
  | "AUTH_REQUIRED"
  | "NOT_FOUND"
  | "FILE_TOO_LARGE"
  | "UNSUPPORTED_FORMAT"
  | "IDEMPOTENCY_CONFLICT"
  | "OPERATION_EXPIRED"
  | "SERVICE_UNAVAILABLE";

export class AssetUploadError extends Error {
  readonly retryable: boolean;

  constructor(
    readonly code: UploadErrorCode,
    message: string,
    readonly status: number,
    retryable = false,
  ) {
    super(message);
    this.name = "AssetUploadError";
    this.retryable = retryable;
  }
}

export interface UploadAuthorization {
  readonly url: string;
  readonly token: string;
}

export interface UploadIntentWrite {
  readonly ownerId: string;
  readonly kind: "upload";
  readonly purpose: UploadPurpose;
  readonly bucket: UploadBucket;
  readonly objectKey: string;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
}

export interface UploadIntentRecord {
  readonly assetId: string;
  readonly bucket: UploadBucket;
  readonly objectKey: string;
  readonly state: "pending_upload";
}

export interface UploadIntent extends UploadIntentRecord {
  readonly upload: UploadAuthorization;
}

export interface UploadIntentStore {
  create(input: UploadIntentWrite): Promise<UploadIntentRecord>;
  signUpload(bucket: UploadBucket, objectKey: string): Promise<UploadAuthorization>;
}

interface UploadDatabaseClient {
  rpc(
    name: string,
    parameters: Readonly<Record<string, unknown>>,
  ): PromiseLike<{ readonly data: unknown; readonly error: unknown }>;
  storage: {
    from(bucket: string): {
      createSignedUploadUrl(
        objectKey: string,
      ): PromiseLike<{ readonly data: unknown; readonly error: unknown }>;
    };
  };
}

function errorCode(error: unknown): string {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code: unknown }).code)
    : "";
}

export function createSupabaseUploadIntentStore(
  client: UploadDatabaseClient,
): UploadIntentStore {
  return {
    async create(input) {
      const { data, error } = await client.rpc("server_create_upload_intent", {
        p_owner_id: input.ownerId,
        p_kind: input.kind,
        p_purpose: input.purpose,
        p_bucket: input.bucket,
        p_object_key: input.objectKey,
        p_mime: input.mime,
        p_bytes: input.bytes,
        p_sha256: input.sha256,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
      });
      if (error || !data) {
        const code = errorCode(error);
        if (code === "23505") {
          throw new AssetUploadError(
            "IDEMPOTENCY_CONFLICT",
            "This Idempotency-Key was already used for a different file.",
            409,
          );
        }
        if (code === "55000") {
          throw new AssetUploadError(
            "OPERATION_EXPIRED",
            "This upload has expired. Start a new upload.",
            410,
          );
        }
        throw error instanceof Error ? error : new Error("Upload intent failed");
      }
      const value = Array.isArray(data) ? data[0] : data;
      if (typeof value !== "object" || value === null) {
        throw new Error("Upload intent RPC returned no asset");
      }
      const response = value as Record<string, unknown>;
      const assetId = response.assetId;
      const bucket = response.bucket;
      const objectKey = response.objectKey;
      if (
        typeof assetId !== "string" ||
        (bucket !== "sources" && bucket !== "assets") ||
        typeof objectKey !== "string"
      ) {
        throw new Error("Upload intent RPC returned an invalid asset");
      }
      return { assetId, bucket, objectKey, state: "pending_upload" };
    },
    async signUpload(bucket, objectKey) {
      // No upsert: a replayed intent may be re-signed after the first authorization
      // expires, but the token must never let a second body overwrite a validated object.
      const { data, error } = await client.storage
        .from(bucket)
        .createSignedUploadUrl(objectKey);
      if (error || typeof data !== "object" || data === null) {
        throw new AssetUploadError(
          "SERVICE_UNAVAILABLE",
          "Uploads are temporarily unavailable. Nothing was uploaded.",
          503,
          true,
        );
      }
      const signed = data as Record<string, unknown>;
      const url = signed.signedUrl;
      const token = signed.token;
      if (typeof url !== "string" || typeof token !== "string") {
        throw new AssetUploadError(
          "SERVICE_UNAVAILABLE",
          "Uploads are temporarily unavailable. Nothing was uploaded.",
          503,
          true,
        );
      }
      return { url, token };
    },
  };
}

export interface UploadIntentInput {
  readonly originalName?: unknown;
  readonly declaredMime?: unknown;
  readonly size?: unknown;
  readonly sha256?: unknown;
  readonly purpose?: unknown;
  readonly rightsConfirmation?: unknown;
}

interface UploadDeclaration {
  readonly originalName: string;
  readonly declaredMime: string;
  readonly size: number;
  readonly sha256: string;
  readonly purpose: UploadPurpose;
}

function bucketFor(purpose: UploadPurpose): UploadBucket {
  return purpose === "source" ? "sources" : "assets";
}

// The database refuses an object key outside the owner prefix, so the file name only has
// to be reduced to something safe to store and to show back; it is never used to decide
// what the file is.
function safeName(originalName: string): string {
  const cleaned = originalName
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/-{2,}/g, "-")
    .slice(0, 100);
  return cleaned.length > 0 ? cleaned.toLowerCase() : "upload";
}

function parseDeclaration(body: UploadIntentInput): UploadDeclaration {
  if (body.purpose !== "source" && body.purpose !== "media") {
    throw new AssetUploadError("INVALID_REQUEST", "purpose must be source or media.", 400);
  }
  if (typeof body.originalName !== "string" || body.originalName.trim().length === 0) {
    throw new AssetUploadError("INVALID_REQUEST", "originalName is required.", 400);
  }
  if (body.originalName.length > 255) {
    throw new AssetUploadError("INVALID_REQUEST", "originalName is too long.", 400);
  }
  if (body.rightsConfirmation !== true) {
    throw new AssetUploadError(
      "INVALID_REQUEST",
      "Confirm you have the rights to use this file before uploading it.",
      400,
    );
  }
  if (typeof body.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(body.sha256)) {
    throw new AssetUploadError(
      "INVALID_REQUEST",
      "A lowercase SHA-256 checksum of the file is required.",
      400,
    );
  }
  if (typeof body.size !== "number" || !Number.isSafeInteger(body.size) || body.size <= 0) {
    throw new AssetUploadError("INVALID_REQUEST", "size must be a positive integer.", 400);
  }
  if (body.size > UPLOAD_MAX_BYTES) {
    throw new AssetUploadError(
      "FILE_TOO_LARGE",
      `Files must be ${Math.floor(UPLOAD_MAX_BYTES / (1024 * 1024))} MiB or smaller.`,
      413,
    );
  }
  if (
    typeof body.declaredMime !== "string" ||
    !ALLOWED_MIME[body.purpose].includes(body.declaredMime)
  ) {
    throw new AssetUploadError(
      "UNSUPPORTED_FORMAT",
      "This file type can't be uploaded here.",
      415,
    );
  }
  return {
    originalName: body.originalName,
    declaredMime: body.declaredMime,
    size: body.size,
    sha256: body.sha256,
    purpose: body.purpose,
  };
}

export function createUploadIntentService(input: {
  readonly store: UploadIntentStore;
  readonly requestHashSecret: string;
  readonly createId?: () => string;
}) {
  if (!input.requestHashSecret) {
    throw new Error("A server-only request hash secret is required");
  }
  const createId = input.createId ?? randomUUID;

  return {
    async create(
      ownerId: string,
      body: UploadIntentInput,
      idempotencyKey: string,
    ): Promise<UploadIntent> {
      if (!ownerId) {
        throw new AssetUploadError(
          "AUTH_REQUIRED",
          "Sign in before uploading a file.",
          401,
        );
      }
      if (!/^[\x21-\x7e]{8,200}$/.test(idempotencyKey)) {
        throw new AssetUploadError(
          "INVALID_REQUEST",
          "A valid Idempotency-Key is required.",
          400,
        );
      }
      const declaration = parseDeclaration(body);
      const bucket = bucketFor(declaration.purpose);
      // A per-intent uuid segment keeps the key unguessable and keeps two uploads of the
      // same file name from colliding on the unique (bucket, object_key) index.
      const objectKey = `${ownerId}/${createId()}/${safeName(declaration.originalName)}`;
      const requestHash = createHmac("sha256", input.requestHashSecret)
        .update(JSON.stringify(declaration))
        .digest("hex");
      let created: UploadIntentRecord;
      try {
        created = await input.store.create({
          ownerId,
          kind: "upload",
          purpose: declaration.purpose,
          bucket,
          objectKey,
          mime: declaration.declaredMime,
          bytes: declaration.size,
          sha256: declaration.sha256,
          idempotencyKey,
          requestHash,
        });
      } catch (error) {
        if (error instanceof AssetUploadError) throw error;
        throw new AssetUploadError(
          "SERVICE_UNAVAILABLE",
          "Uploads are temporarily unavailable. Nothing was uploaded.",
          503,
          true,
        );
      }
      // Signing uses the key the database returned, not the one just built: a replayed
      // intent has to refresh the authorization for the original object.
      const upload = await input.store.signUpload(created.bucket, created.objectKey);
      return { ...created, upload };
    },
  };
}

// Every code here is a fixed class the finalization RPC accepts and that is safe to show:
// no file name, no object key, no provider text.
export type AssetValidationFailureCode =
  | "FILE_MISSING"
  | "FILE_TOO_LARGE"
  | "SIZE_MISMATCH"
  | "DIGEST_MISMATCH"
  | "MIME_MISMATCH"
  | "UNSUPPORTED_FORMAT";

export type AssetValidationOutcome =
  | {
      readonly ok: true;
      readonly mime: string;
      readonly bytes: number;
      readonly sha256: string;
    }
  | { readonly ok: false; readonly code: AssetValidationFailureCode };

export interface DeclaredUpload {
  readonly purpose: UploadPurpose;
  readonly mime: string;
  readonly bytes: number;
  readonly sha256: string;
}

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  if (bytes.byteLength < offset + signature.length) return false;
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return Buffer.from(bytes.subarray(offset, offset + length)).toString("latin1");
}

// A container-only sniffer on purpose: it answers "is this really one of the types we
// accept", which is the question the declared media type cannot be trusted with. Deep
// structure checks belong to the parsers that will read the file later.
function sniffMime(bytes: Uint8Array): string | null {
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (ascii(bytes, 0, 6) === "GIF87a" || ascii(bytes, 0, 6) === "GIF89a") return "image/gif";
  if (ascii(bytes, 0, 4) === "RIFF" && ascii(bytes, 8, 4) === "WEBP") return "image/webp";
  if (ascii(bytes, 0, 5) === "%PDF-") return "application/pdf";
  if (startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3])) return "video/webm";
  if (ascii(bytes, 4, 4) === "ftyp") return "video/mp4";
  if (startsWith(bytes, [0x50, 0x4b, 0x03, 0x04])) {
    // A pptx is a zip; the presentation part names appear in the central directory, so a
    // plain zip of anything else stays unrecognised instead of passing as slides.
    return Buffer.from(bytes).includes("ppt/slides/")
      ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
      : null;
  }
  return null;
}

export function inspectUploadedObject(
  declared: DeclaredUpload,
  bytes: Uint8Array,
): AssetValidationOutcome {
  if (bytes.byteLength === 0) return { ok: false, code: "FILE_MISSING" };
  if (bytes.byteLength > UPLOAD_MAX_BYTES) return { ok: false, code: "FILE_TOO_LARGE" };
  if (bytes.byteLength !== declared.bytes) return { ok: false, code: "SIZE_MISMATCH" };
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (sha256 !== declared.sha256) return { ok: false, code: "DIGEST_MISMATCH" };
  const sniffed = sniffMime(bytes);
  if (sniffed === null || !ALLOWED_MIME[declared.purpose].includes(sniffed)) {
    return { ok: false, code: "UNSUPPORTED_FORMAT" };
  }
  if (sniffed !== declared.mime) return { ok: false, code: "MIME_MISMATCH" };
  return { ok: true, mime: sniffed, bytes: bytes.byteLength, sha256 };
}

// Reference-only, exactly like the job dispatch payload: the worker reads the object from
// Storage itself, so no signed URL and no file content ever enters the task queue.
export interface AssetValidationPayload {
  readonly assetId: string;
  readonly schemaVersion: 1;
  readonly requestId: string;
}

export interface AssetValidationDispatcher {
  trigger(
    payload: AssetValidationPayload,
    idempotencyKey: string,
  ): Promise<{ readonly id: string }>;
}

// The id lives next to the dispatcher rather than in the task module so that an API route
// can start a validation without pulling the worker's dependencies into its bundle.
export const VALIDATE_ASSET_TASK_ID = "orincard-validate-asset";

export const assetValidationDispatcher: AssetValidationDispatcher = {
  async trigger(payload, key) {
    const { idempotencyKeys, tasks } = await import("@trigger.dev/sdk");
    const idempotencyKey = await idempotencyKeys.create(key, { scope: "global" });
    return tasks.trigger(VALIDATE_ASSET_TASK_ID, payload, { idempotencyKey });
  },
};

export function uploadErrorResponse(error: unknown, requestId: string): Response {
  const failure =
    error instanceof AssetUploadError
      ? error
      : new AssetUploadError(
          "SERVICE_UNAVAILABLE",
          "Uploads are temporarily unavailable. Nothing was uploaded.",
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
    { status: failure.status, headers: { "Cache-Control": "private, no-store" } },
  );
}
