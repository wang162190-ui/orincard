import { createHash, randomUUID } from "node:crypto";
import OpenAI from "openai";

export const AI_IMAGE_KINDS = ["ai_image", "portrait"] as const;
export type AiImageKind = (typeof AI_IMAGE_KINDS)[number];
export const AI_IMAGE_MAX_PROMPT_LENGTH = 1_000;

export class AiAssetError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "QUOTA_EXCEEDED" | "BUDGET_EXCEEDED" | "PROVIDER_FAILED" | "SERVICE_UNAVAILABLE",
    message: string,
    readonly status: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "AiAssetError";
  }
}

export type GeneratedImage = Readonly<{ bytes: Uint8Array; mime: "image/png"; providerOperationId: string | null }>;

export interface AiImageProvider {
  generate(input: { readonly kind: AiImageKind; readonly prompt: string; readonly reference?: Uint8Array }): Promise<GeneratedImage>;
}

export interface AiCandidateStore {
  findReference(ownerId: string, assetId: string): Promise<{ readonly id: string; readonly bucket: string; readonly objectKey: string; readonly mime: string } | null>;
  reserve(ownerId: string): Promise<"reserved" | "quota_exceeded" | "budget_exceeded">;
  release(ownerId: string): Promise<void>;
  create(input: Readonly<Record<string, unknown>>): Promise<{ readonly id: string }>;
}

function parse(input: unknown): { readonly kind: AiImageKind; readonly prompt: string; readonly referenceAssetId: string | null } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) throw new AiAssetError("INVALID_REQUEST", "Request body must be an object.", 400);
  const value = input as Record<string, unknown>;
  const kind = value.kind;
  const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
  const referenceAssetId = typeof value.referenceAssetId === "string" ? value.referenceAssetId : null;
  if (!AI_IMAGE_KINDS.includes(kind as AiImageKind) || !prompt || prompt.length > AI_IMAGE_MAX_PROMPT_LENGTH) {
    throw new AiAssetError("INVALID_REQUEST", "Choose image or portrait and provide a prompt up to 1,000 characters.", 400);
  }
  if (referenceAssetId !== null && !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(referenceAssetId)) {
    throw new AiAssetError("INVALID_REQUEST", "Reference assets must be valid asset IDs.", 400);
  }
  if (kind === "portrait" && !referenceAssetId) throw new AiAssetError("INVALID_REQUEST", "A portrait requires an authorized reference image.", 400);
  if (kind === "ai_image" && referenceAssetId) throw new AiAssetError("INVALID_REQUEST", "Only portraits can use a reference image.", 400);
  return { kind: kind as AiImageKind, prompt, referenceAssetId };
}

export function createAiCandidateService(input: { readonly store: AiCandidateStore; readonly now?: () => Date; readonly createId?: () => string }) {
  const now = input.now ?? (() => new Date());
  const createId = input.createId ?? randomUUID;
  return {
    async submit(ownerId: string, body: unknown) {
      if (!ownerId) throw new AiAssetError("NOT_FOUND", "Account not found.", 404);
      const request = parse(body);
      if (request.referenceAssetId) {
        const reference = await input.store.findReference(ownerId, request.referenceAssetId);
        if (!reference || reference.bucket !== "assets" || !["image/png", "image/jpeg", "image/webp"].includes(reference.mime)) {
          throw new AiAssetError("NOT_FOUND", "Reference image not found.", 404);
        }
      }
      const reservation = await input.store.reserve(ownerId);
      if (reservation === "quota_exceeded") throw new AiAssetError("QUOTA_EXCEEDED", "No image credit is available for this request.", 429);
      if (reservation === "budget_exceeded") throw new AiAssetError("BUDGET_EXCEEDED", "Image generation is temporarily paused.", 429);
      const assetId = createId();
      try {
        await input.store.create({
          id: assetId, owner_id: ownerId, kind: request.kind, purpose: "media", bucket: "assets",
          object_key: `${ownerId}/${assetId}/pending.png`, mime: "image/png", bytes: 0, sha256: "0".repeat(64),
          rights: { provider: "openai", model: "gpt-image-1", prompt: request.prompt, candidate: true, referenceAssetId: request.referenceAssetId, userAcceptedRequired: true, requestedAt: now().toISOString() },
          state: "pending_upload", library_retained: false,
        });
      } catch (error) {
        await input.store.release(ownerId).catch(() => undefined);
        throw error;
      }
      return { assetId, state: "pending_upload" as const };
    },
  };
}

export function createOpenAiImageProvider(apiKey: string): AiImageProvider {
  if (!apiKey.trim()) throw new Error("OPENAI_API_KEY is required.");
  const client = new OpenAI({ apiKey });
  return {
    async generate(input) {
      try {
        // gpt-image-1 returns base64 image data; the request remains server-side and no
        // generated or reference image URL is exposed to the browser.
        const response = input.reference
          ? await client.images.edit({ model: "gpt-image-1", image: new File([Buffer.from(input.reference)], "reference.png", { type: "image/png" }), prompt: input.prompt, size: "1024x1024", quality: "low" })
          : await client.images.generate({ model: "gpt-image-1", prompt: input.prompt, size: "1024x1024", quality: "low" });
        const encoded = response.data?.[0]?.b64_json;
        if (!encoded) throw new Error("provider returned no image data");
        return { bytes: Buffer.from(encoded, "base64"), mime: "image/png", providerOperationId: null };
      } catch {
        throw new AiAssetError("PROVIDER_FAILED", "Image generation is temporarily unavailable.", 503, true);
      }
    },
  };
}

export function generatedMetadata(bytes: Uint8Array) {
  if (bytes.byteLength < 24 || bytes.byteLength > 50 * 1024 * 1024) throw new AiAssetError("PROVIDER_FAILED", "Image generation returned an invalid image.", 503, true);
  const buffer = Buffer.from(bytes);
  if (!buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) throw new AiAssetError("PROVIDER_FAILED", "Image generation returned an invalid image.", 503, true);
  return { bytes: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"), width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}
