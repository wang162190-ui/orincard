import { createHmac, randomUUID } from "node:crypto";
import type { CarouselDocument, Platform } from "../domain/document";
import type { ThemeId } from "../render/templates";
import type { AppEnvironment } from "./environment";
import type { GenerationOptions } from "./generation";
import type { SourceRecord, TextSourceKind } from "./sources";

export type GuestBeginOutcome =
  | { readonly outcome: "accepted"; readonly guardId: string }
  | {
      readonly outcome:
        | "result_not_retained"
        | "idempotency_conflict"
        | "rate_limited"
        | "budget_exceeded";
    };

export interface GuestGuardInput {
  readonly subjectHash: string;
  readonly operationKey: string;
  readonly requestHash: string;
  readonly windowStart: string;
  readonly expiresAt: string;
  readonly environment: AppEnvironment;
  readonly period: string;
  readonly reservedMicroUsd: number;
  readonly rateLimit: number;
}

export interface GuestGuardStore {
  begin(input: GuestGuardInput): Promise<GuestBeginOutcome>;
  finish(input: {
    readonly guardId: string;
    readonly outcome: "succeeded" | "failed";
  }): Promise<void>;
}

interface RpcClient {
  rpc(
    name: string,
    parameters: Readonly<Record<string, unknown>>,
  ): PromiseLike<{ readonly data: unknown; readonly error: unknown }>;
}

export class GuestGenerationError extends Error {
  constructor(
    readonly code:
      | "INVALID_REQUEST"
      | "RESULT_NOT_RETAINED"
      | "IDEMPOTENCY_CONFLICT"
      | "RATE_LIMITED"
      | "BUDGET_EXCEEDED"
      | "PROVIDER_FAILED"
      | "SERVICE_UNAVAILABLE",
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GuestGenerationError";
  }
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const OPERATION_KEY_PATTERN = /^[\x21-\x7e]{8,200}$/;
const SESSION_NONCE_PATTERN = /^[A-Za-z0-9_-]{16,200}$/;
const BEGIN_OUTCOMES = new Set([
  "accepted",
  "result_not_retained",
  "idempotency_conflict",
  "rate_limited",
  "budget_exceeded",
]);

function serviceUnavailable(): GuestGenerationError {
  return new GuestGenerationError(
    "SERVICE_UNAVAILABLE",
    "Guest generation is temporarily unavailable. Your text was not saved.",
    503,
    true,
  );
}

function rpcResult(value: unknown): GuestBeginOutcome {
  const row = Array.isArray(value) ? value[0] : value;
  if (typeof row !== "object" || row === null || !("outcome" in row)) {
    throw serviceUnavailable();
  }
  const outcome = String(row.outcome);
  if (!BEGIN_OUTCOMES.has(outcome)) {
    throw serviceUnavailable();
  }
  if (outcome === "accepted") {
    const guardId = "guardId" in row ? row.guardId : "guard_id" in row ? row.guard_id : null;
    if (typeof guardId !== "string" || !UUID_PATTERN.test(guardId)) {
      throw serviceUnavailable();
    }
    return { outcome, guardId };
  }
  return { outcome } as GuestBeginOutcome;
}

export function createSupabaseGuestGuardStore(client: RpcClient): GuestGuardStore {
  return {
    async begin(input) {
      const { data, error } = await client.rpc("server_begin_guest_generation", {
        p_environment: input.environment,
        p_expires_at: input.expiresAt,
        p_operation_key: input.operationKey,
        p_period: input.period,
        p_rate_limit: input.rateLimit,
        p_request_hash: input.requestHash,
        p_reserved_micro_usd: input.reservedMicroUsd,
        p_subject_hash: input.subjectHash,
        p_window_start: input.windowStart,
      });
      if (error) {
        throw serviceUnavailable();
      }
      return rpcResult(data);
    },

    async finish(input) {
      const { error } = await client.rpc("server_finish_guest_generation", {
        p_guard_id: input.guardId,
        p_outcome: input.outcome,
      });
      if (error) {
        throw serviceUnavailable();
      }
    },
  };
}

export interface GuestGenerationBody extends GenerationOptions {
  readonly kind: TextSourceKind;
  readonly text: string;
  readonly sessionNonce: string;
}

interface ParsedGuestInput {
  readonly source: SourceRecord;
  readonly options: GenerationOptions;
  readonly sessionNonce: string;
}

function invalid(message: string): never {
  throw new GuestGenerationError("INVALID_REQUEST", message, 400, false);
}

function parseBody(body: GuestGenerationBody): ParsedGuestInput {
  if (body.kind !== "topic" && body.kind !== "text") {
    invalid("kind must be topic or text.");
  }
  if (typeof body.text !== "string" || !body.text.trim()) {
    invalid("Enter a topic or paste text before continuing.");
  }
  const text = body.text.trim();
  const characterCount = Array.from(text).length;
  if (characterCount > (body.kind === "topic" ? 500 : 30_000)) {
    invalid(`${body.kind === "topic" ? "Topic" : "Text"} exceeds the allowed length.`);
  }
  if (
    typeof body.sessionNonce !== "string" ||
    !SESSION_NONCE_PATTERN.test(body.sessionNonce)
  ) {
    invalid("sessionNonce must be a browser-generated opaque value.");
  }
  return {
    sessionNonce: body.sessionNonce,
    source: {
      id: randomUUID(),
      ownerId: "guest",
      kind: body.kind,
      metadata: { characterCount },
      segments: [{ segmentId: randomUUID(), text }],
      state: "ready",
      expiresAt: new Date(0).toISOString(),
    },
    options: {
      language: body.language,
      format: body.format,
      pageCount: body.pageCount,
      instructions: body.instructions,
      templateId: body.templateId,
      platform: body.platform,
    },
  };
}

function hmac(secret: string, value: unknown): string {
  return createHmac("sha256", secret).update(JSON.stringify(value)).digest("hex");
}

function outcomeError(outcome: Exclude<GuestBeginOutcome, { outcome: "accepted" }>): never {
  if (outcome.outcome === "result_not_retained") {
    throw new GuestGenerationError(
      "RESULT_NOT_RETAINED",
      "This guest result is not stored. Use your local result or start a new request.",
      410,
      false,
    );
  }
  if (outcome.outcome === "idempotency_conflict") {
    throw new GuestGenerationError(
      "IDEMPOTENCY_CONFLICT",
      "This operation key was already used for different input.",
      409,
      false,
    );
  }
  if (outcome.outcome === "budget_exceeded") {
    throw new GuestGenerationError(
      "BUDGET_EXCEEDED",
      "Guest generation has reached its current budget.",
      429,
      false,
    );
  }
  throw new GuestGenerationError(
    "RATE_LIMITED",
    "Too many guest generation requests. Try again later.",
    429,
    true,
  );
}

export function createGuestGenerationService(input: {
  readonly store: GuestGuardStore;
  readonly generate: (input: {
    readonly source: SourceRecord;
    readonly options: GenerationOptions;
  }) => Promise<CarouselDocument | Readonly<Record<string, unknown>>>;
  readonly hashSecret: string;
  readonly environment?: AppEnvironment;
  readonly now?: () => Date;
  /**
   * 成本记账钩子。guardId 只在这个函数内部存在，所以登记与结算必须在这里回调，
   * 而不是由路由在外面拼。`register` 在供应商调用前跑，失败即中止（没有预留就不该发起调用）；
   * `settle` 成功与失败都跑一次，且都在 `store.finish` 之前——token 是照烧的。
   */
  readonly cost?: {
    readonly register: (guardId: string) => Promise<void>;
    readonly settle: (guardId: string) => Promise<void>;
  };
}) {
  if (!input.hashSecret) {
    throw new Error("A server-only guest HMAC secret is required.");
  }
  const now = input.now ?? (() => new Date());
  const environment = input.environment ?? "development";

  return {
    async generate(
      body: GuestGenerationBody,
      context: { readonly operationKey: string; readonly networkSubject: string },
    ) {
      if (!OPERATION_KEY_PATTERN.test(context.operationKey)) {
        invalid("Idempotency-Key must contain 8 to 200 visible ASCII characters.");
      }
      if (!context.networkSubject) {
        invalid("Guest request metadata is incomplete.");
      }
      const parsed = parseBody(body);
      const requestedAt = now();
      const windowStart = new Date(requestedAt);
      windowStart.setUTCMinutes(0, 0, 0);
      let begun: GuestBeginOutcome;
      try {
        begun = await input.store.begin({
          subjectHash: hmac(input.hashSecret, {
            environment,
            networkSubject: context.networkSubject,
            sessionNonce: parsed.sessionNonce,
          }),
          operationKey: context.operationKey,
          requestHash: hmac(input.hashSecret, {
            kind: parsed.source.kind,
            text: parsed.source.segments[0]?.text,
            options: parsed.options,
          }),
          windowStart: windowStart.toISOString(),
          expiresAt: new Date(requestedAt.getTime() + 24 * 60 * 60 * 1_000).toISOString(),
          environment,
          period: requestedAt.toISOString().slice(0, 7),
          reservedMicroUsd: 2_000,
          rateLimit: 3,
        });
      } catch (error) {
        if (error instanceof GuestGenerationError) throw error;
        throw serviceUnavailable();
      }
      if (begun.outcome !== "accepted") {
        outcomeError(begun);
      }

      if (input.cost) {
        // 登记失败说明预留不在，此时发起供应商调用等于绕过预算，所以中止并把 guard 收掉。
        try {
          await input.cost.register(begun.guardId);
        } catch {
          try {
            await input.store.finish({ guardId: begun.guardId, outcome: "failed" });
          } catch {
            // 响应仍然失败关闭；对账巡检负责回收这条 guard。
          }
          throw serviceUnavailable();
        }
      }

      try {
        const document = await input.generate({
          source: parsed.source,
          options: parsed.options,
        });
        if (input.cost) await input.cost.settle(begun.guardId);
        await input.store.finish({ guardId: begun.guardId, outcome: "succeeded" });
        return document;
      } catch (error) {
        try {
          if (input.cost) await input.cost.settle(begun.guardId);
          await input.store.finish({ guardId: begun.guardId, outcome: "failed" });
        } catch {
          // The response still fails closed; reconciliation must settle the guard.
        }
        if (error instanceof GuestGenerationError) throw error;
        throw new GuestGenerationError(
          "PROVIDER_FAILED",
          "AI generation is temporarily unavailable. Your text was not saved.",
          502,
          true,
        );
      }
    },
  };
}

export function guestErrorResponse(error: unknown, requestId: string): Response {
  const failure = error instanceof GuestGenerationError ? error : serviceUnavailable();
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
