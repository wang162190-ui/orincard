import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { createDeletionService, createSupabaseDeletionStore, DeletionError, deletionErrorResponse } from "../../../../server/deletion";
import { readServerEnvironment } from "../../../../server/environment";
import { assertTrustedWriteRequest } from "../../../../server/projects";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "../../../../server/supabase";
import { deletionCleanupDispatcher } from "../../../../trigger/dispatch";

export async function DELETE(request: Request) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    assertTrustedWriteRequest(request, environment.appUrl);
    const cookieStore = await cookies();
    const client = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
    let ownerId: string;
    try { ownerId = (await requireVerifiedUser(client)).id; }
    catch { throw new DeletionError("AUTH_REQUIRED", "Sign in to delete your account.", 401); }
    const deletionId = await createDeletionService(createSupabaseDeletionStore(createAdminSupabaseClient())).requestAccount(ownerId);
    try { await deletionCleanupDispatcher.trigger({ jobId: deletionId, schemaVersion: 1, requestId }, `deletion:${deletionId}`); } catch { /* Durable request remains retryable. */ }
    return Response.json({ data: { deletionId, state: "deleting" }, requestId }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return deletionErrorResponse(error, requestId);
  }
}
