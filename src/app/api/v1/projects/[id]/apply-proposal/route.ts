import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { readServerEnvironment } from "../../../../../../server/environment";
import {
  RewriteError,
  applyRewriteProposal,
  createSupabaseRewriteStore,
  rewriteErrorResponse,
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
    const cookieStore = await cookies();
    const user = await requireVerifiedUser(createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    })).catch(() => { throw new RewriteError("NOT_FOUND", "Proposal not found.", 404); });
    const body = await request.json() as Record<string, unknown>;
    const { id } = await contextInput.params;
    const result = await applyRewriteProposal({
      ownerId: user.id,
      projectId: id,
      proposalJobId: String(body.proposalJobId ?? ""),
      expectedRevision: Number(body.expectedRevision),
      baseSlideRevision: Number(body.baseSlideRevision),
      idempotencyKey: request.headers.get("idempotency-key") ?? "",
      hashSecret: environment.supabaseSecretKey,
      store: createSupabaseRewriteStore(createAdminSupabaseClient()),
    });
    return Response.json({ data: result, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return rewriteErrorResponse(error, requestId);
  }
}
