import { createHmac, randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { parseToolRequest, TOOL_IDS, type ToolId, type ToolRequest } from "@/domain/tools";
import { readServerEnvironment } from "@/server/environment";
import { assertTrustedWriteRequest } from "@/server/projects";
import { getToolDefinition } from "@/features/tools/registry";
import { createEntitlementProvisioner } from "@/server/billing/entitlement-grant";
import { createSupabaseJobStore, dispatchPendingJob } from "@/server/jobs";
import { toolReservedMicroUsd, toTextWorkerRequest, toVisualWorkerRequest, VISUAL_TOOL_IDS } from "@/server/tools/application";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";
import { resolveTriggerDispatcher } from "@/trigger/dispatch";

/**
 * 一次工具调用消耗一个 `generation` 额度单位——与编排器逐步执行同口径
 * （`src/server/agent/executor.ts` 的 `STEP_USAGE_UNITS`）。
 */
const TOOL_USAGE_UNITS = 1;

function json(body: unknown, status: number) { return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } }); }

async function ownerId() {
  const cookieStore = await cookies();
  const client = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
  return (await requireVerifiedUser(client)).id;
}

function toolId(value: string): ToolId {
  if (!TOOL_IDS.includes(value as ToolId)) throw new Error("UNKNOWN_TOOL");
  return value as ToolId;
}

export class ToolJobError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly status: number,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "ToolJobError";
  }
}

export interface ToolSubmitInput {
  readonly ownerId: string;
  readonly projectId: string | null;
  readonly inputRef: Readonly<Record<string, unknown>>;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly submittedAt: string;
  readonly environment: string;
  readonly costPeriod: string;
  readonly reservedMicroUsd: number;
}

export interface ToolSubmissionStore {
  submit(input: ToolSubmitInput): Promise<{ readonly id: string; readonly state: string }>;
}

/**
 * 把提交失败翻译成稳定错误码。
 *
 * `private.submit_job` 对「用户额度不够」和「环境成本预算不够」都抛 22003，只有 message
 * 不同（`walking_skeleton.sql:1012` / `:1019`）；对用户这是两回事，所以分开报。
 */
export function toolSubmitFailure(error: unknown): never {
  const failure = error as { code?: string; message?: string } | null;
  const code = failure?.code ?? "";
  const message = failure?.message ?? "";
  if (code === "23505") throw new ToolJobError("IDEMPOTENCY_CONFLICT", "This operation key was already used for different input.", 409, false);
  if (code === "22003") {
    throw /cost budget/i.test(message)
      ? new ToolJobError("BUDGET_EXCEEDED", "This tool is paused because the environment budget is exhausted.", 429, false)
      : new ToolJobError("QUOTA_EXCEEDED", "No usage allowance is available for this tool.", 429, false);
  }
  if (code === "42501") throw new ToolJobError("NOT_FOUND", "The account or project is not accessible.", 404, false);
  throw new ToolJobError("SERVICE_UNAVAILABLE", "Tool service is temporarily unavailable.", 503, true);
}

/**
 * 这个入口从前用 `admin.from("jobs").upsert()` 直接建 job，绕开了 `server_submit_job`，
 * 于是既不预留用户额度也不写 `private.cost_reservations`——worker 一走到
 * `private.register_cost_attempt` 就 22023 `open cost reservation not found`，
 * 从工具页面手动跑任何文本/视觉工具都必然失败。这里改回与 generation / agent 同一条提交路径。
 */
export function createSupabaseToolSubmissionStore(client: SupabaseClient): ToolSubmissionStore {
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
      if (account.error) toolSubmitFailure(account.error);
      // 桶不存在与余额不足对调用方是同一件事；submit_job 自己也把两者都算 22003。
      if (!account.data) toolSubmitFailure({ code: "22003", message: "insufficient usage balance" });
      const { data, error } = await client.rpc("server_submit_job", {
        p_owner_id: input.ownerId,
        p_project_id: input.projectId,
        p_kind: "tool",
        p_input_ref: input.inputRef,
        p_idempotency_key: input.idempotencyKey,
        p_request_hash: input.requestHash,
        p_resource: "generation",
        p_units: TOOL_USAGE_UNITS,
        p_period_start: account.data.period_start,
        p_period_end: account.data.period_end,
        p_environment: input.environment,
        p_cost_period: input.costPeriod,
        p_reserved_micro_usd: input.reservedMicroUsd,
      });
      if (error || !data) toolSubmitFailure(error);
      const row = data as unknown as Record<string, unknown>;
      return { id: row.id as string, state: row.state as string };
    },
  };
}

/** 该工具入参翻译成对应 worker 认的载荷形状；与编排器的 `stepInputRef` 同一套适配器。 */
export function toolInputRef(parsed: ToolRequest): Readonly<Record<string, unknown>> {
  return VISUAL_TOOL_IDS.includes(parsed.tool as (typeof VISUAL_TOOL_IDS)[number])
    ? (toVisualWorkerRequest(parsed) as unknown as Readonly<Record<string, unknown>>)
    : (toTextWorkerRequest(parsed) as unknown as Readonly<Record<string, unknown>>);
}

export function createToolJobService(input: {
  readonly store: ToolSubmissionStore;
  readonly dispatch: (jobId: string, requestId: string) => Promise<void>;
  readonly requestHashSecret: string;
  readonly environment?: string;
  readonly now?: () => Date;
  readonly ensureEntitlements?: (ownerId: string, at: Date) => Promise<void>;
}) {
  const now = input.now ?? (() => new Date());
  return {
    async submit(
      owner: string,
      parsed: ToolRequest,
      idempotencyKey: string,
      requestId: string,
    ): Promise<{ readonly jobId: string; readonly state: string }> {
      if (idempotencyKey.length > 200) {
        throw new ToolJobError("INVALID_REQUEST", "Idempotency key is too long.", 400, false);
      }
      const currentTime = now();
      const requestHash = createHmac("sha256", input.requestHashSecret).update(JSON.stringify(parsed)).digest("hex");
      // 发放放在提交之前：submit_job 按 (owner, period_start, resource) 精确相等找桶，桶不存在就是 22003。
      // 发放幂等且额度只升不降，重复提交不会多给。
      await input.ensureEntitlements?.(owner, currentTime);
      const job = await input.store.submit({
        ownerId: owner,
        projectId: parsed.context?.projectId ?? null,
        inputRef: toolInputRef(parsed),
        idempotencyKey,
        requestHash,
        submittedAt: currentTime.toISOString(),
        environment: input.environment ?? "development",
        costPeriod: currentTime.toISOString().slice(0, 7),
        reservedMicroUsd: toolReservedMicroUsd(parsed.tool),
      });
      try {
        await input.dispatch(job.id, requestId);
      } catch {
        // 派发失败时 job 停在 pending_dispatch，由对账巡检兜底重新派发；额度与成本预留都已落盘。
      }
      return { jobId: job.id, state: job.state };
    },
  };
}

export async function handleToolPost(
  request: Request,
  dependencies: {
    readonly appUrl: string;
    readonly authenticate: () => Promise<string>;
    readonly service: ReturnType<typeof createToolJobService>;
    readonly tool: () => Promise<string>;
    readonly requestId?: () => string;
    readonly idempotencyKey?: () => string;
  },
): Promise<Response> {
  const requestId = (dependencies.requestId ?? randomUUID)();
  try {
    assertTrustedWriteRequest(request, dependencies.appUrl);
  } catch {
    return json({ error: { code: "INVALID_REQUEST", message: "The request origin is not allowed.", retryable: false }, requestId }, 400);
  }
  let owner: string;
  try { owner = await dependencies.authenticate(); } catch {
    return json({ error: { code: "AUTH_REQUIRED", message: "Sign in to use tools.", retryable: false }, requestId }, 401);
  }
  try {
    const tool = toolId(await dependencies.tool());
    const parsed = parseToolRequest(tool, await request.json());
    const key = request.headers.get("idempotency-key")?.trim() || (dependencies.idempotencyKey ?? randomUUID)();
    const result = await dependencies.service.submit(owner, parsed, key, requestId);
    return json({ data: { jobId: result.jobId, resultType: getToolDefinition(tool).resultType }, requestId }, 202);
  } catch (error) {
    if (error instanceof ToolJobError) {
      return json({ error: { code: error.code, message: error.message, retryable: error.retryable }, requestId }, error.status);
    }
    const invalid = error instanceof Error && (error.message === "UNKNOWN_TOOL" || error.name === "ZodError" || error instanceof SyntaxError);
    return json({ error: { code: invalid ? "INVALID_REQUEST" : "SERVICE_UNAVAILABLE", message: invalid ? "Tool request is invalid." : "Tool service is temporarily unavailable.", retryable: !invalid }, requestId }, invalid ? 400 : 503);
  }
}

export async function POST(request: Request, context: { readonly params: Promise<{ readonly tool: string }> }) {
  const environment = readServerEnvironment(process.env);
  const admin = createAdminSupabaseClient();
  const jobStore = createSupabaseJobStore(admin);
  const service = createToolJobService({
    store: createSupabaseToolSubmissionStore(admin),
    requestHashSecret: environment.supabaseSecretKey,
    environment: environment.appEnvironment,
    ensureEntitlements: createEntitlementProvisioner({
      client: admin,
      appEnvironment: environment.appEnvironment,
      rawPolicy: process.env.BILLING_POLICY_JSON,
    }),
    // 两个工具 worker 共用 `tool` 这个 kind，dispatcher 从 job 已经落盘的 input_ref 解析具体任务。
    dispatch: async (jobId, requestId) => {
      await dispatchPendingJob(jobStore, resolveTriggerDispatcher("tool"), jobId, requestId);
    },
  });
  return handleToolPost(request, {
    appUrl: environment.appUrl,
    authenticate: ownerId,
    service,
    tool: async () => (await context.params).tool,
  });
}

export async function GET(request: Request, context: { readonly params: Promise<{ readonly tool: string }> }) {
  const requestId = randomUUID();
  try {
    const owner = await ownerId();
    const tool = toolId((await context.params).tool);
    const jobId = new URL(request.url).searchParams.get("jobId");
    if (!jobId) return json({ error: { code: "INVALID_REQUEST", message: "jobId is required.", retryable: false }, requestId }, 400);
    const result = await createAdminSupabaseClient().from("jobs").select("id,state,progress,result_ref,error_code").eq("id", jobId).eq("owner_id", owner).eq("kind", "tool").maybeSingle();
    if (result.error) throw result.error;
    if (!result.data) return json({ error: { code: "NOT_FOUND", message: "Tool result was not found.", retryable: false }, requestId }, 404);
    const resultRef = result.data.result_ref && typeof result.data.result_ref === "object" && !Array.isArray(result.data.result_ref) ? result.data.result_ref as Record<string, unknown> : null;
    // A text candidate is nested under `candidate`; a visual candidate references its stored
    // tool output at the top level and never carries the rendered bytes.
    const candidate = resultRef ? resultRef.candidate ?? (typeof resultRef.tool === "string" ? resultRef : null) : null;
    if (candidate && typeof candidate === "object" && (candidate as { tool?: unknown }).tool !== tool) return json({ error: { code: "NOT_FOUND", message: "Tool result was not found.", retryable: false }, requestId }, 404);
    return json({ data: { jobId, state: result.data.state, progress: result.data.progress, candidate, errorCode: result.data.error_code }, requestId }, 200);
  } catch {
    return json({ error: { code: "AUTH_REQUIRED", message: "Sign in to view tool results.", retryable: false }, requestId }, 401);
  }
}
