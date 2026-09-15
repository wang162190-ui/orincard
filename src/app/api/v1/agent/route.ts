import { createHmac, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createEntitlementProvisioner } from "@/server/billing/entitlement-grant";
import { readServerEnvironment } from "@/server/environment";
import { PLAN_RESERVED_MICRO_USD } from "@/server/agent/plan-run";
import {
  createSupabaseJobStore,
  dispatchPendingJob,
  type JobRecord,
} from "@/server/jobs";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "@/server/supabase";
import { agentTriggerDispatcher } from "@/trigger/dispatch";

const IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{8,200}$/;
/** 与 `public.agent_runs.request` 的检查约束同值；两处必须一起改。 */
const REQUEST_MAX_LENGTH = 2_000;

/**
 * 规划本身消耗一个 `generation` 额度单位。
 *
 * `private.submit_job` 要求 `p_units > 0`，没有「零用户额度」的提交口子。可选的替代是给规划
 * 单独开一个 resource 桶，但那需要一个「每月能规划几次」的数字——B-1 的 12 项未定决策里
 * 没有它，编一个出来就是替产品做决定。扣既有额度是保守方向：宁可多扣，不白送没人授权的容量。
 *
 * 代价是明确的：免费方案 10 个单位下，一次三步 run 花掉 4 个（1 规划 + 3 执行）。
 * 要不要给规划单独开桶，是 B-1 该回答的问题，不是这里该默默解决的。
 */
const PLAN_USAGE_UNITS = 1;

export class AgentJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "AgentJobError";
  }
}

export interface AgentSubmitInput {
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly submittedAt: string;
  readonly environment: string;
  readonly costPeriod: string;
}

export interface AgentSubmissionStore {
  submit(input: AgentSubmitInput): Promise<JobRecord>;
  /**
   * 落一行 `agent_runs`。需求正文只存在这里，**不进 `jobs.input_ref`**——与
   * `private.b04_begin_ai_candidate_job`「不携带正文输入」的既有口径一致。
   */
  createRun(input: {
    readonly jobId: string;
    readonly ownerId: string;
    readonly request: string;
  }): Promise<void>;
  findRun(ownerId: string, jobId: string): Promise<AgentRunRecord | null>;
}

export interface AgentRunRecord {
  readonly jobId: string;
  readonly request: string;
  readonly plan: Readonly<Record<string, unknown>> | null;
  readonly state: string;
  readonly errorCode: string | null;
  readonly jobState: string;
  readonly progress: number;
}

function storeFailure(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  if (code === "22003") throw new AgentJobError("QUOTA_EXCEEDED", "Not enough quota remains.", 429, false);
  if (code === "23505") {
    throw new AgentJobError(
      "IDEMPOTENCY_CONFLICT",
      "This operation key was already used for a different request.",
      409,
      false,
    );
  }
  if (code === "42501") throw new AgentJobError("NOT_FOUND", "Account is not active.", 404, false);
  throw new AgentJobError("SERVICE_UNAVAILABLE", "The agent is temporarily unavailable.", 503, true);
}

export function createSupabaseAgentSubmissionStore(client: SupabaseClient): AgentSubmissionStore {
  return {
    async submit(input) {
      const account = await client
        .from("usage_accounts")
        .select("period_start,period_end")
        .eq("owner_id", input.ownerId)
        .eq("resource", "generation")
        .lte("period_start", input.submittedAt)
        .gt("period_end", input.submittedAt)
        .maybeSingle();
      if (account.error) storeFailure(account.error);
      if (!account.data) {
        throw new AgentJobError("QUOTA_EXCEEDED", "No usage allowance is available.", 429, false);
      }
      const { data, error } = await client.rpc("server_submit_job", {
        p_owner_id: input.ownerId,
        p_project_id: input.projectId,
        p_kind: "agent",
        // 正文不进这里；任务从 agent_runs 取需求。
        p_input_ref: { schemaVersion: 1 },
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
        p_resource: "generation",
        p_units: PLAN_USAGE_UNITS,
        p_period_start: account.data.period_start,
        p_period_end: account.data.period_end,
        p_environment: input.environment,
        p_cost_period: input.costPeriod,
        p_reserved_micro_usd: PLAN_RESERVED_MICRO_USD,
      });
      if (error || !data) storeFailure(error);
      const row = data as unknown as Record<string, unknown>;
      return {
        id: row.id as string,
        ownerId: row.owner_id as string,
        kind: row.kind as string,
        state: row.state as JobRecord["state"],
        stage: row.stage as string,
        progress: Number(row.progress ?? 0),
        providerRunId: (row.provider_run_id as string | null) ?? null,
        attempt: Number(row.attempt ?? 0),
        heartbeatAt: (row.heartbeat_at as string | null) ?? null,
        resultRef: (row.result_ref as Readonly<Record<string, unknown>> | null) ?? null,
        errorCode: (row.error_code as string | null) ?? null,
        cancelRequestedAt: (row.cancel_requested_at as string | null) ?? null,
        updatedAt: row.updated_at as string,
        finishedAt: (row.finished_at as string | null) ?? null,
      };
    },

    async createRun(input) {
      const { error } = await client
        .from("agent_runs")
        .insert({ job_id: input.jobId, owner_id: input.ownerId, request: input.request });
      // 重放同一个幂等键时 job 已存在，run 行也已存在；唯一约束冲突在这里是正常结果。
      if (error && (error as { code?: string }).code !== "23505") storeFailure(error);
    },

    async findRun(ownerId, jobId) {
      const { data, error } = await client
        .from("agent_runs")
        .select("job_id,request,plan,state,error_code,jobs!inner(state,progress)")
        .eq("owner_id", ownerId)
        .eq("job_id", jobId)
        .maybeSingle();
      if (error) storeFailure(error);
      if (!data) return null;
      const job = data.jobs as unknown as { state: string; progress: number };
      return {
        jobId: data.job_id as string,
        request: data.request as string,
        plan: (data.plan as Readonly<Record<string, unknown>> | null) ?? null,
        state: data.state as string,
        errorCode: (data.error_code as string | null) ?? null,
        jobState: job.state,
        progress: Number(job.progress ?? 0),
      };
    },
  };
}

export function parseAgentBody(body: unknown): { readonly request: string; readonly projectId: string | null } {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AgentJobError("INVALID_REQUEST", "Request body must be an object.", 400, false);
  }
  const value = body as Record<string, unknown>;
  const request = typeof value.request === "string" ? value.request.trim() : "";
  if (request.length === 0 || request.length > REQUEST_MAX_LENGTH) {
    throw new AgentJobError("INVALID_REQUEST", "Describe what you want in 1–2000 characters.", 400, false);
  }
  const projectId = value.projectId;
  if (projectId !== undefined && projectId !== null && typeof projectId !== "string") {
    throw new AgentJobError("INVALID_REQUEST", "projectId must be a string.", 400, false);
  }
  return { request, projectId: (projectId as string | null) ?? null };
}

export function createAgentJobService(input: {
  readonly store: AgentSubmissionStore;
  readonly dispatch: (jobId: string, requestId: string) => Promise<void>;
  readonly requestHashSecret: string;
  readonly environment?: string;
  readonly now?: () => Date;
  readonly ensureEntitlements?: (ownerId: string, at: Date) => Promise<void>;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async submit(
      ownerId: string,
      body: unknown,
      idempotencyKey: string,
      requestId: string,
    ): Promise<{ readonly jobId: string; readonly state: string }> {
      if (!IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
        throw new AgentJobError("INVALID_REQUEST", "A valid Idempotency-Key is required.", 400, false);
      }
      const parsed = parseAgentBody(body);
      const currentTime = now();
      const requestHash = createHmac("sha256", input.requestHashSecret)
        .update(JSON.stringify({ request: parsed.request, projectId: parsed.projectId }))
        .digest("hex");

      await input.ensureEntitlements?.(ownerId, currentTime);
      const job = await input.store.submit({
        ownerId,
        projectId: parsed.projectId,
        idempotencyKey,
        requestHash,
        submittedAt: currentTime.toISOString(),
        environment: input.environment ?? "development",
        costPeriod: currentTime.toISOString().slice(0, 7),
      });

      // 顺序是刻意的：先建 job（agent_runs.job_id 有外键），再落需求正文，**最后**才派发。
      // 若落正文失败，任务就不会被派发；此时 job 停在 pending_dispatch，由对账兜底。
      // 对账重新派发时 run 行仍可能缺失，所以 Trigger 任务必须把「找不到 run 行」当作
      // 一个明确的失败来报，而不是当成空需求继续跑。
      await input.store.createRun({ jobId: job.id, ownerId, request: parsed.request });
      await input.dispatch(job.id, requestId);
      return { jobId: job.id, state: job.state };
    },

    async read(ownerId: string, jobId: string): Promise<AgentRunRecord> {
      const run = await input.store.findRun(ownerId, jobId);
      if (!run) throw new AgentJobError("NOT_FOUND", "Agent run was not found.", 404, false);
      return run;
    },
  };
}

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

function failure(error: unknown, requestId: string) {
  const known =
    error instanceof AgentJobError
      ? error
      : new AgentJobError("SERVICE_UNAVAILABLE", "The agent is temporarily unavailable.", 503, true);
  return json(
    { error: { code: known.code, message: known.message, retryable: known.retryable }, requestId },
    known.status,
  );
}

export async function handleAgentPost(
  request: Request,
  dependencies: {
    readonly appOrigin: string;
    readonly authenticate: () => Promise<string>;
    readonly service: ReturnType<typeof createAgentJobService>;
    readonly requestId?: () => string;
  },
): Promise<Response> {
  const requestId = (dependencies.requestId ?? randomUUID)();
  if (request.headers.get("origin") !== dependencies.appOrigin) {
    return json(
      { error: { code: "FORBIDDEN", message: "Request origin is not allowed.", retryable: false }, requestId },
      403,
    );
  }
  let ownerId: string;
  try {
    ownerId = await dependencies.authenticate();
  } catch {
    return json(
      { error: { code: "AUTH_REQUIRED", message: "Sign in to use the agent.", retryable: false }, requestId },
      401,
    );
  }
  try {
    const idempotencyKey = request.headers.get("idempotency-key")?.trim() ?? "";
    const result = await dependencies.service.submit(ownerId, await request.json(), idempotencyKey, requestId);
    return json({ data: result, requestId }, 202);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return failure(new AgentJobError("INVALID_REQUEST", "Request body must be JSON.", 400, false), requestId);
    }
    return failure(error, requestId);
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
  const service = createAgentJobService({
    store: createSupabaseAgentSubmissionStore(admin),
    requestHashSecret: environment.supabaseSecretKey,
    environment: environment.appEnvironment,
    ensureEntitlements: createEntitlementProvisioner({
      client: admin,
      appEnvironment: environment.appEnvironment,
      rawPolicy: process.env.BILLING_POLICY_JSON,
    }),
    dispatch: async (jobId, requestId) => {
      await dispatchPendingJob(jobStore, agentTriggerDispatcher, jobId, requestId);
    },
  });
  return handleAgentPost(request, {
    appOrigin: new URL(environment.appUrl).origin,
    authenticate: async () => (await requireVerifiedUser(userClient)).id,
    service,
  });
}

export async function GET(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const cookieStore = await cookies();
    const userClient = createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    });
    let ownerId: string;
    try {
      ownerId = (await requireVerifiedUser(userClient)).id;
    } catch {
      return json(
        { error: { code: "AUTH_REQUIRED", message: "Sign in to view agent runs.", retryable: false }, requestId },
        401,
      );
    }
    const jobId = new URL(request.url).searchParams.get("jobId");
    if (!jobId) {
      return failure(new AgentJobError("INVALID_REQUEST", "jobId is required.", 400, false), requestId);
    }
    const store = createSupabaseAgentSubmissionStore(createAdminSupabaseClient());
    const run = await store.findRun(ownerId, jobId);
    if (!run) return failure(new AgentJobError("NOT_FOUND", "Agent run was not found.", 404, false), requestId);
    return json({ data: run, requestId }, 200);
  } catch (error) {
    return failure(error, requestId);
  }
}
