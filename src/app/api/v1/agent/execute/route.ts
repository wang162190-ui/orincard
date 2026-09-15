import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import {
  AgentExecutionError,
  createSupabaseAgentExecutorStore,
  executeAgentPlan,
} from "@/server/agent/executor";
import { readServerEnvironment } from "@/server/environment";
import { createSupabaseJobStore, dispatchPendingJob } from "@/server/jobs";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "@/server/supabase";
import { resolveTriggerDispatcher } from "@/trigger/dispatch";

function json(body: unknown, status: number) {
  return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } });
}

export function parseExecuteBody(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new AgentExecutionError("INVALID_REQUEST", "Request body must be an object.", 400, false);
  }
  const jobId = (body as Record<string, unknown>).jobId;
  if (typeof jobId !== "string" || jobId.trim().length === 0) {
    throw new AgentExecutionError("INVALID_REQUEST", "jobId is required.", 400, false);
  }
  return jobId.trim();
}

/**
 * 执行是**用户确认后**的一次显式动作，所以它是自己的 POST 入口，而不是规划成功后的自动续跑。
 * 计划里每一步都要花用户额度，替用户决定花掉它不是编排器该做的事。
 */
export async function handleAgentExecute(
  request: Request,
  dependencies: {
    readonly appOrigin: string;
    readonly authenticate: () => Promise<string>;
    readonly execute: (ownerId: string, jobId: string, requestId: string) => Promise<unknown>;
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
      { error: { code: "AUTH_REQUIRED", message: "Sign in to run a plan.", retryable: false }, requestId },
      401,
    );
  }
  try {
    const jobId = parseExecuteBody(await request.json());
    return json({ data: await dependencies.execute(ownerId, jobId, requestId), requestId }, 202);
  } catch (error) {
    if (error instanceof SyntaxError) {
      return json(
        { error: { code: "INVALID_REQUEST", message: "Request body must be JSON.", retryable: false }, requestId },
        400,
      );
    }
    const known =
      error instanceof AgentExecutionError
        ? error
        : new AgentExecutionError("SERVICE_UNAVAILABLE", "The agent is temporarily unavailable.", 503, true);
    return json(
      { error: { code: known.code, message: known.message, retryable: known.retryable }, requestId },
      known.status,
    );
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
  return handleAgentExecute(request, {
    appOrigin: new URL(environment.appUrl).origin,
    authenticate: async () => (await requireVerifiedUser(userClient)).id,
    execute: (ownerId, jobId, requestId) =>
      executeAgentPlan(
        {
          store: createSupabaseAgentExecutorStore(admin),
          // 每一步都是 kind='tool' 的子任务，派发器沿用既有的按 job kind 解析那一套。
          dispatch: async (stepJobId, id) => {
            await dispatchPendingJob(jobStore, resolveTriggerDispatcher("tool"), stepJobId, id);
          },
          requestHashSecret: environment.supabaseSecretKey,
          environment: environment.appEnvironment,
        },
        ownerId,
        jobId,
        requestId,
      ),
  });
}
