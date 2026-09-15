import { createHmac, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isPlatformKey } from "../../../../domain/document";
import { isGenerationLanguage, type GenerationOptions } from "../../../../server/generation";
import {
  createSupabaseJobStore,
  dispatchPendingJob,
  type JobRecord,
} from "../../../../server/jobs";
import { readServerEnvironment } from "../../../../server/environment";
import { createEntitlementProvisioner } from "../../../../server/billing/entitlement-grant";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "../../../../server/supabase";
import { generationTriggerDispatcher } from "../../../../trigger/generate";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,200}$/;
const ACTIVE_STATES = ["pending_dispatch", "queued", "running"];
const RESERVED_COST_MICRO_USD = 25_000;

export interface OwnedSource {
  readonly id: string;
  readonly ownerId: string;
  readonly state: string;
  readonly expiresAt: string;
}

export interface GenerationSubmitInput {
  readonly ownerId: string;
  readonly inputRef: {
    readonly sourceId: string;
    readonly options: GenerationOptions;
  };
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly units: 1;
  readonly submittedAt: string;
  readonly environment: string;
  readonly costPeriod: string;
  readonly reservedCostMicroUsd: number;
}

export interface GenerationSubmissionStore {
  findOwnedSource(ownerId: string, sourceId: string): Promise<OwnedSource | null>;
  hasActiveGeneration(ownerId: string, idempotencyKey: string): Promise<boolean>;
  submit(input: GenerationSubmitInput): Promise<JobRecord>;
}

export type GenerationJobErrorCode =
  | "INVALID_REQUEST"
  | "AUTH_REQUIRED"
  | "NOT_FOUND"
  | "IDEMPOTENCY_CONFLICT"
  | "QUOTA_EXCEEDED"
  | "BUDGET_EXCEEDED"
  | "CONCURRENCY_LIMIT"
  | "SERVICE_UNAVAILABLE";

export class GenerationJobError extends Error {
  constructor(
    readonly code: GenerationJobErrorCode,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "GenerationJobError";
  }
}

type JobRow = {
  id: string;
  owner_id: string;
  kind: string;
  state: JobRecord["state"];
  stage: string;
  progress: number;
  provider_run_id: string | null;
  attempt: number;
  heartbeat_at: string | null;
  result_ref: Readonly<Record<string, unknown>> | null;
  error_code: string | null;
  cancel_requested_at: string | null;
  updated_at: string;
  finished_at: string | null;
};

function job(row: JobRow): JobRecord {
  return {
    id: row.id,
    ownerId: row.owner_id,
    kind: row.kind,
    state: row.state,
    stage: row.stage,
    progress: row.progress,
    providerRunId: row.provider_run_id,
    attempt: row.attempt,
    heartbeatAt: row.heartbeat_at,
    resultRef: row.result_ref,
    errorCode: row.error_code,
    cancelRequestedAt: row.cancel_requested_at,
    updatedAt: row.updated_at,
    finishedAt: row.finished_at,
  };
}

function storeFailure(error: unknown): never {
  const code =
    typeof error === "object" && error !== null && "code" in error
      ? String(error.code)
      : "";
  const message =
    typeof error === "object" && error !== null && "message" in error
      ? String(error.message)
      : "";
  if (code === "23505" || code === "IDEMPOTENCY_CONFLICT") {
    throw new GenerationJobError(
      "IDEMPOTENCY_CONFLICT",
      "This Idempotency-Key was already used for different generation options.",
      409,
      false,
    );
  }
  if (code === "QUOTA_EXCEEDED" || (code === "22003" && !message.includes("budget"))) {
    throw new GenerationJobError(
      "QUOTA_EXCEEDED",
      "No generation credit is available for this request.",
      429,
      false,
    );
  }
  if (code === "BUDGET_EXCEEDED" || (code === "22003" && message.includes("budget"))) {
    throw new GenerationJobError(
      "BUDGET_EXCEEDED",
      "AI generation is paused because the development budget is exhausted.",
      429,
      false,
    );
  }
  throw new GenerationJobError(
    "SERVICE_UNAVAILABLE",
    "Generation jobs are temporarily unavailable.",
    503,
    true,
  );
}

export function createSupabaseGenerationSubmissionStore(
  client: SupabaseClient,
): GenerationSubmissionStore {
  return {
    async findOwnedSource(ownerId, sourceId) {
      const { data, error } = await client
        .from("sources")
        .select("id,owner_id,state,expires_at")
        .eq("id", sourceId)
        .eq("owner_id", ownerId)
        .maybeSingle();
      if (error) storeFailure(error);
      return data
        ? {
            id: data.id,
            ownerId: data.owner_id,
            state: data.state,
            expiresAt: data.expires_at,
          }
        : null;
    },

    async hasActiveGeneration(ownerId, idempotencyKey) {
      const { count, error } = await client
        .from("jobs")
        .select("id", { count: "exact", head: true })
        .eq("owner_id", ownerId)
        .eq("kind", "generation")
        .neq("idempotency_key", idempotencyKey)
        .in("state", ACTIVE_STATES);
      if (error) storeFailure(error);
      return (count ?? 0) > 0;
    },

    async submit(input) {
      const at = input.submittedAt;
      const account = await client
        .from("usage_accounts")
        .select("period_start,period_end")
        .eq("owner_id", input.ownerId)
        .eq("resource", "generation")
        .lte("period_start", at)
        .gt("period_end", at)
        .maybeSingle();
      if (account.error) storeFailure(account.error);
      if (!account.data) {
        throw { code: "QUOTA_EXCEEDED" };
      }
      const { data, error } = await client.rpc("server_submit_job", {
        p_owner_id: input.ownerId,
        p_project_id: null,
        p_kind: "generation",
        p_input_ref: input.inputRef,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
        p_resource: "generation",
        p_units: input.units,
        p_period_start: account.data.period_start,
        p_period_end: account.data.period_end,
        p_environment: input.environment,
        p_cost_period: input.costPeriod,
        p_reserved_micro_usd: input.reservedCostMicroUsd,
      });
      if (error || !data) storeFailure(error);
      return job(data as unknown as JobRow);
    },
  };
}

function parseGenerationBody(body: unknown): {
  readonly sourceId: string;
} & GenerationOptions {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new GenerationJobError("INVALID_REQUEST", "Request body must be an object.", 400, false);
  }
  const value = body as Record<string, unknown>;
  if (
    typeof value.sourceId !== "string" ||
    !UUID_PATTERN.test(value.sourceId) ||
    !isGenerationLanguage(value.language) ||
    typeof value.format !== "string" ||
    !value.format.trim() ||
    !Number.isInteger(value.pageCount) ||
    Number(value.pageCount) < 4 ||
    Number(value.pageCount) > 12 ||
    typeof value.instructions !== "string" ||
    value.instructions.length > 2_000 ||
    !["ink", "paper", "signal", "blush", "butter", "sky"].includes(String(value.templateId)) ||
    // 从 platformPresets 派生，不再手写。以前这里是一份独立的白名单：
    // 加画幅时漏改这一处，UI 能选但提交被 400 拒，而且报错完全看不出是画幅的问题。
    !isPlatformKey(value.platform)
  ) {
    throw new GenerationJobError("INVALID_REQUEST", "Generation options are invalid.", 400, false);
  }
  return value as unknown as { readonly sourceId: string } & GenerationOptions;
}

export function createGenerationJobService(input: {
  readonly store: GenerationSubmissionStore;
  readonly dispatch: (jobId: string, requestId: string) => Promise<void>;
  readonly requestHashSecret: string;
  readonly environment?: string;
  readonly now?: () => Date;
  /**
   * 提交前确保当期额度桶存在。可选：未配置权益策略的环境（BILLING_POLICY_JSON 缺失）
   * 不传，行为与接线前逐字一致——照旧走到 QUOTA_EXCEEDED，而不是把配置缺失伪装成别的错误。
   */
  readonly ensureEntitlements?: (ownerId: string, at: Date) => Promise<void>;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async submit(
      ownerId: string,
      body: unknown,
      idempotencyKey: string,
      requestId: string,
    ): Promise<JobRecord> {
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw new GenerationJobError("INVALID_REQUEST", "A valid Idempotency-Key is required.", 400, false);
      }
      const parsed = parseGenerationBody(body);
      const source = await input.store.findOwnedSource(ownerId, parsed.sourceId);
      const currentTime = now();
      if (
        !source ||
        source.ownerId !== ownerId ||
        source.state !== "ready" ||
        new Date(source.expiresAt).getTime() <= currentTime.getTime()
      ) {
        throw new GenerationJobError("NOT_FOUND", "Source not found.", 404, false);
      }
      if (await input.store.hasActiveGeneration(ownerId, idempotencyKey)) {
        throw new GenerationJobError(
          "CONCURRENCY_LIMIT",
          "Finish the active generation before starting another.",
          429,
          false,
        );
      }
      const { sourceId, ...generationOptions } = parsed;
      const inputRef = { sourceId, options: generationOptions };
      const requestHash = createHmac("sha256", input.requestHashSecret)
        .update(JSON.stringify(inputRef))
        .digest("hex");
      // 发放放在提交之前：submit_job 是按 (owner, period_start, resource) 精确相等去找桶的，
      // 桶不存在就是 22003。发放幂等且额度只升不降，重复提交不会多给。
      await input.ensureEntitlements?.(ownerId, currentTime);
      let submitted: JobRecord;
      try {
        submitted = await input.store.submit({
          ownerId,
          inputRef,
          idempotencyKey,
          requestHash,
          units: 1,
          submittedAt: currentTime.toISOString(),
          environment: input.environment ?? "development",
          costPeriod: currentTime.toISOString().slice(0, 7),
          reservedCostMicroUsd: RESERVED_COST_MICRO_USD,
        });
      } catch (error) {
        if (error instanceof GenerationJobError) throw error;
        storeFailure(error);
      }
      try {
        await input.dispatch(submitted.id, requestId);
      } catch {
        // The durable pending_dispatch row is reconciled after a Trigger timeout.
      }
      return submitted;
    },
  };
}

type GenerationService = ReturnType<typeof createGenerationJobService>;

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

export async function handleGenerationPost(
  request: Request,
  dependencies: {
    readonly appOrigin: string;
    readonly authenticate: () => Promise<string>;
    readonly service: Pick<GenerationService, "submit">;
    readonly requestId?: () => string;
  },
): Promise<Response> {
  const requestId = (dependencies.requestId ?? randomUUID)();
  if (request.headers.get("origin") !== dependencies.appOrigin) {
    return json({ error: { code: "INVALID_REQUEST", message: "The request origin is not allowed.", retryable: false }, requestId }, 400);
  }
  const idempotencyKey = request.headers.get("idempotency-key") ?? "";
  if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
    return json({ error: { code: "INVALID_REQUEST", message: "A valid Idempotency-Key is required.", retryable: false }, requestId }, 400);
  }
  let ownerId: string;
  try {
    ownerId = await dependencies.authenticate();
  } catch {
    return json({ error: { code: "AUTH_REQUIRED", message: "Authentication required.", retryable: false }, requestId }, 401);
  }
  try {
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      throw new GenerationJobError("INVALID_REQUEST", "Request body must be valid JSON.", 400, false);
    }
    const result = await dependencies.service.submit(ownerId, body, idempotencyKey, requestId);
    return json({ data: { jobId: result.id, state: result.state }, requestId }, 202);
  } catch (error) {
    const failure =
      error instanceof GenerationJobError
        ? error
        : new GenerationJobError("SERVICE_UNAVAILABLE", "Generation jobs are temporarily unavailable.", 503, true);
    return json({ error: { code: failure.code, message: failure.message, retryable: failure.retryable }, requestId }, failure.status);
  }
}

export async function POST(request: Request): Promise<Response> {
  const environment = readServerEnvironment(process.env);
  const cookieStore = await cookies();
  const userClient = createServerSupabaseClient({
    getAll: () => cookieStore.getAll(),
    set: (name, value, options) => cookieStore.set(name, value, options),
  });
  const admin = createAdminSupabaseClient();
  const jobStore = createSupabaseJobStore(admin);
  const service = createGenerationJobService({
    store: createSupabaseGenerationSubmissionStore(admin),
    requestHashSecret: environment.supabaseSecretKey,
    environment: environment.appEnvironment,
    ensureEntitlements: createEntitlementProvisioner({
      client: admin,
      appEnvironment: environment.appEnvironment,
      rawPolicy: process.env.BILLING_POLICY_JSON,
    }),
    dispatch: async (jobId, requestId) => {
      await dispatchPendingJob(jobStore, generationTriggerDispatcher, jobId, requestId);
    },
  });
  return handleGenerationPost(request, {
    appOrigin: new URL(environment.appUrl).origin,
    authenticate: async () => (await requireVerifiedUser(userClient)).id,
    service,
  });
}
