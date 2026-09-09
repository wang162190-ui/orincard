import { createHash, randomUUID } from "node:crypto";
import { Agent, ProxyAgent, fetch as undiciFetch } from "undici";

export const AI_IMAGE_KINDS = ["ai_image", "portrait"] as const;
export type AiImageKind = (typeof AI_IMAGE_KINDS)[number];
export const AI_IMAGE_MAX_PROMPT_LENGTH = 1_000;

export class AiAssetError extends Error {
  constructor(
    readonly code: "INVALID_REQUEST" | "AUTH_REQUIRED" | "NOT_FOUND" | "QUOTA_EXCEEDED" | "BUDGET_EXCEEDED" | "PROVIDER_FAILED" | "SERVICE_UNAVAILABLE",
    message: string,
    readonly status: number,
    readonly retryable = false,
    readonly internalCode: string | null = null,
  ) {
    super(message);
    this.name = "AiAssetError";
  }
}

export type GeneratedImage = Readonly<{ bytes: Uint8Array; mime: "image/png"; providerOperationId: string | null; providerCostUsd: number | null }>;

export interface AiImageProvider {
  generate(input: { readonly kind: AiImageKind; readonly prompt: string; readonly reference?: Uint8Array; readonly referenceMime?: string }): Promise<GeneratedImage>;
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
          rights: { provider: "apimart", model: "gpt-image-2", resolution: "1k", prompt: request.prompt, candidate: true, referenceAssetId: request.referenceAssetId, userAcceptedRequired: true, requestedAt: now().toISOString() },
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

type ApiMartTask = Readonly<{ status: string; cost?: number; result?: { images?: Array<{ url?: string[] }> } }>;

const apiMartProxy = process.env.HTTPS_PROXY?.trim() || process.env.https_proxy?.trim();
const apiMartImageHosts = new Set(["upload.apimart.ai", "getapib.org"]);
const apiMartDispatcher = apiMartProxy
  ? new ProxyAgent(apiMartProxy)
  : new Agent({ connect: { family: 4 } });
const defaultApiMartFetch: typeof fetch = (input, init) => undiciFetch(input as Parameters<typeof undiciFetch>[0], {
  ...init,
  dispatcher: apiMartDispatcher,
} as Parameters<typeof undiciFetch>[1]) as unknown as ReturnType<typeof fetch>;

function providerFailure(message = "Image generation is temporarily unavailable.", internalCode: string | null = null): AiAssetError {
  return new AiAssetError("PROVIDER_FAILED", message, 503, true, internalCode);
}

async function responseJson(response: Response, step: string): Promise<Record<string, unknown>> {
  const value: unknown = await response.json().catch(() => null);
  if (!response.ok || typeof value !== "object" || value === null || Array.isArray(value)) {
    console.error("[apimart] invalid response", { step, status: response.status });
    throw providerFailure(undefined, `APIMART_${step.toUpperCase()}_RESPONSE`);
  }
  return value as Record<string, unknown>;
}

export function createApiMartImageProvider(apiKey: string, fetcher: typeof fetch = defaultApiMartFetch, sleep = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds))): AiImageProvider {
  if (!apiKey.trim()) throw new Error("APIMART_API_KEY is required.");
  const headers = { authorization: `Bearer ${apiKey}`, "content-type": "application/json" };
  const requestTimeout = () => AbortSignal.timeout(20_000);
  const request = async (step: string, url: string | URL, init: RequestInit) => {
    try {
      return await fetcher(url, init);
    } catch (error) {
      const failure = error as Error & { code?: string; cause?: { code?: string } };
      console.error("[apimart] request failed", { step, error: failure.name, code: failure.code ?? failure.cause?.code ?? null });
      throw providerFailure(undefined, `APIMART_${step.toUpperCase()}_${failure.name === "TimeoutError" ? "TIMEOUT" : "NETWORK"}`);
    }
  };
  return {
    async generate(input) {
      try {
        const payload: Record<string, unknown> = { model: "gpt-image-2", prompt: input.prompt, n: 1, size: "1:1", resolution: "1k" };
        if (input.reference) payload.image_urls = [`data:${input.referenceMime ?? "image/png"};base64,${Buffer.from(input.reference).toString("base64")}`];
        const submitted = await responseJson(await request("submit", "https://api.apimart.ai/v1/images/generations", { method: "POST", headers, body: JSON.stringify(payload), signal: requestTimeout() }), "submit");
        const taskId = Array.isArray(submitted.data) && typeof submitted.data[0] === "object" && submitted.data[0] !== null && typeof (submitted.data[0] as Record<string, unknown>).task_id === "string"
          ? (submitted.data[0] as Record<string, unknown>).task_id as string : null;
        if (!taskId) throw providerFailure();

        const deadline = Date.now() + 240_000;
        while (Date.now() < deadline) {
          await sleep(2_000);
          const queried = await responseJson(await request("poll", `https://api.apimart.ai/v1/tasks/${encodeURIComponent(taskId)}?language=en`, { headers, signal: requestTimeout() }), "poll");
          const task = queried.data as ApiMartTask | undefined;
          if (task?.status === "failed") throw providerFailure();
          const completedTask = task?.status === "completed" ? task : undefined;
          const url = completedTask?.result?.images?.[0]?.url?.[0];
          if (!url) continue;
          const imageUrl = new URL(url);
          if (imageUrl.protocol !== "https:" || !apiMartImageHosts.has(imageUrl.hostname)) {
            console.error("[apimart] unexpected result host", { hostname: imageUrl.hostname });
            throw providerFailure(undefined, "APIMART_RESULT_HOST");
          }
          const imageResponse = await request("download", imageUrl, { headers: { accept: "image/png" }, redirect: "error", signal: requestTimeout() });
          if (!imageResponse.ok) throw providerFailure();
          const bytes = new Uint8Array(await imageResponse.arrayBuffer());
          return { bytes, mime: "image/png", providerOperationId: taskId, providerCostUsd: typeof completedTask.cost === "number" ? completedTask.cost : null };
        }
        throw providerFailure("Image generation timed out.");
      } catch (error) {
        if (error instanceof AiAssetError) throw error;
        throw providerFailure();
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
