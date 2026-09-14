import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { createDeepSeekResponsesAdapter, createDeepSeekResponsesClient } from "../../../../../../server/ai";
import { createMeasurementCollector, settleKeyedJobUsage } from "../../../../../../server/cost-settlement";
import { readServerEnvironment } from "../../../../../../server/environment";
import { createProjectService, createSupabaseProjectStore } from "../../../../../../server/projects";
import {
  RewriteError,
  createRewriteProposal,
  createSupabaseRewriteStore,
  rewriteErrorResponse,
  type RewriteAction,
  type RewriteField,
} from "../../../../../../server/rewrite";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "../../../../../../server/supabase";

export async function POST(
  request: Request,
  contextInput: { readonly params: Promise<{ readonly id: string }> },
) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) {
      throw new RewriteError("INVALID_REQUEST", "Untrusted request origin.", 400);
    }
    const apiKey = process.env.DEEPSEEK_API_KEY?.trim();
    if (!apiKey) throw new RewriteError("SERVICE_UNAVAILABLE", "AI rewrite is unavailable.", 503, true);
    const cookieStore = await cookies();
    const user = await requireVerifiedUser(createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    })).catch(() => { throw new RewriteError("NOT_FOUND", "Project not found.", 404); });
    const body = await request.json() as Record<string, unknown>;
    const { id } = await contextInput.params;
    const admin = createAdminSupabaseClient();
    const project = await createProjectService({
      store: createSupabaseProjectStore(admin),
      requestHashSecret: environment.supabaseSecretKey,
    }).get(user.id, id);

    // 候选任务的尝试行已由 private.b04_begin_ai_candidate_job 以 `:candidate:1` 登记，
    // 这里只结算、不重复登记。rewrittenText 内部最多重试两次，两次共用同一个 key，合并结算一次。
    const collector = createMeasurementCollector();
    let proposalJobId = "";
    // 供应商失败时 createRewriteProposal 会抛错，但 token 已经烧掉了，所以失败路径也要结算。
    const settle = async () => {
      if (!proposalJobId) return;
      await settleKeyedJobUsage({
        client: admin,
        jobId: proposalJobId,
        operation: "candidate",
        sequence: 1,
        measurements: collector.collected(),
      });
    };

    let proposal;
    try {
      proposal = await createRewriteProposal({
        ownerId: user.id,
        projectId: id,
        projectRevision: project.revision,
        document: project.document,
        slideId: String(body.slideId ?? ""),
        field: String(body.field ?? "") as RewriteField,
        baseSlideRevision: Number(body.baseSlideRevision),
        action: String(body.action ?? "") as RewriteAction,
        instruction: typeof body.instruction === "string" ? body.instruction : "",
        idempotencyKey: request.headers.get("idempotency-key") ?? "",
        hashSecret: environment.supabaseSecretKey,
        environment: environment.appEnvironment,
        ai: createDeepSeekResponsesAdapter(createDeepSeekResponsesClient(apiKey)),
        store: createSupabaseRewriteStore(admin),
        onMeasurement: collector.onMeasurement,
        onProposalJob: (jobId) => { proposalJobId = jobId; },
      });
    } finally {
      await settle();
    }

    return Response.json(
      { data: { jobId: proposal.proposalJobId, proposal }, requestId },
      { status: 202, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return rewriteErrorResponse(error, requestId);
  }
}
