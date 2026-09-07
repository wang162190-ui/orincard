import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { createDeepSeekResponsesAdapter, createDeepSeekResponsesClient } from "../../../../../../server/ai";
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
    const proposal = await createRewriteProposal({
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
    });
    return Response.json(
      { data: { jobId: proposal.proposalJobId, proposal }, requestId },
      { status: 202, headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return rewriteErrorResponse(error, requestId);
  }
}
