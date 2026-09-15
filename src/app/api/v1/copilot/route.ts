import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { createDeepSeekResponsesAdapter, createDeepSeekResponsesClient } from "@/server/ai";
import {
  createSupabaseCopilotStore,
  runCopilotTurn,
  COPILOT_MESSAGE_MAX_LENGTH,
} from "@/server/copilot";
import { createMeasurementCollector, settleKeyedJobUsage } from "@/server/cost-settlement";
import { readServerEnvironment } from "@/server/environment";
import { createProjectService, createSupabaseProjectStore } from "@/server/projects";
import { RewriteError, createSupabaseRewriteStore, rewriteErrorResponse } from "@/server/rewrite";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "@/server/supabase";

/**
 * 编辑器助手的对话入口。骨架照 `/api/v1/agent`：origin 校验、`requireVerifiedUser`、
 * `Idempotency-Key`、`{ data | error, requestId }` 信封、`Cache-Control: private, no-store`。
 *
 * POST 发一轮，GET 读该项目的对话历史。**写项目不走这里**——助手只产出提议，
 * 应用走既有的 `/api/v1/projects/[id]/apply-proposal`。
 */

async function authenticate() {
  const cookieStore = await cookies();
  return requireVerifiedUser(
    createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    }),
  );
}

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) {
      throw new RewriteError("INVALID_REQUEST", "Untrusted request origin.", 400);
    }
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) {
      throw new RewriteError("SERVICE_UNAVAILABLE", "The editor assistant is unavailable.", 503, true);
    }
    const user = await authenticate().catch(() => {
      throw new RewriteError("NOT_FOUND", "Project not found.", 404);
    });

    const body = (await request.json()) as Record<string, unknown>;
    const projectId = String(body.projectId ?? "");
    const message = typeof body.message === "string" ? body.message : "";
    if (message.trim().length > COPILOT_MESSAGE_MAX_LENGTH) {
      throw new RewriteError("INVALID_REQUEST", "That question is too long.", 400);
    }

    const admin = createAdminSupabaseClient();
    const project = await createProjectService({
      store: createSupabaseProjectStore(admin),
      requestHashSecret: environment.supabaseSecretKey,
    }).get(user.id, projectId);

    // 尝试行由 server_begin_copilot_turn 以 `:copilot:1` 登记，这里只结算、不重复登记。
    const collector = createMeasurementCollector();
    let turnJobId = "";
    let settled = false;
    // 供应商失败时 runCopilotTurn 会抛错，但 token 已经烧掉了——失败路径也必须结算。
    // 只结算一次：同一个 attempt_key 结第二遍会在 SQL 侧撞唯一约束，虽然被吞掉，
    // 但每一轮都会在日志里留下一条假的 `[cost] settlement failed`。
    const settle = async () => {
      if (!turnJobId || settled) return;
      settled = true;
      await settleKeyedJobUsage({
        client: admin,
        jobId: turnJobId,
        operation: "copilot",
        sequence: 1,
        measurements: collector.collected(),
      });
    };

    let result;
    try {
      result = await runCopilotTurn({
        ownerId: user.id,
        projectId,
        projectRevision: project.revision,
        document: project.document,
        message,
        focusSlideId: typeof body.slideId === "string" ? body.slideId : null,
        idempotencyKey: request.headers.get("idempotency-key") ?? "",
        hashSecret: environment.supabaseSecretKey,
        environment: environment.appEnvironment,
        ai: createDeepSeekResponsesAdapter(createDeepSeekResponsesClient(apiKey)),
        store: createSupabaseCopilotStore(admin),
        rewriteStore: createSupabaseRewriteStore(admin),
        onMeasurement: collector.onMeasurement,
        onTurnJob: (jobId) => {
          turnJobId = jobId;
        },
        // 结算必须发生在 finalize 之前，否则预留只能按 unknown 保守收尾（见 copilot.ts 的注释）。
        settleUsage: settle,
      });
    } finally {
      // 兜底：runCopilotTurn 在任何来不及调用 settleUsage 的路径上抛错时，这一笔仍要记上。
      await settle();
    }

    return Response.json(
      { data: result, requestId },
      { status: 200, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return rewriteErrorResponse(error, requestId);
  }
}

export async function GET(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    const user = await authenticate().catch(() => {
      throw new RewriteError("NOT_FOUND", "Project not found.", 404);
    });
    const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
    const admin = createAdminSupabaseClient();
    // 先过一遍项目归属：不存在或不属于这个人时，连「有没有对话」都不该泄露。
    await createProjectService({
      store: createSupabaseProjectStore(admin),
      requestHashSecret: readServerEnvironment(process.env).supabaseSecretKey,
    }).get(user.id, projectId);

    const turns = await createSupabaseCopilotStore(admin).history(user.id, projectId);
    return Response.json(
      { data: { turns }, requestId },
      { status: 200, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return rewriteErrorResponse(error, requestId);
  }
}
