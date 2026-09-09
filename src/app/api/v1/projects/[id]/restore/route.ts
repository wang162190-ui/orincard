import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { readServerEnvironment } from "@/server/environment";
import { ProjectServiceError, assertTrustedWriteRequest, createProjectService, createSupabaseProjectStore, projectDocumentHash, projectErrorResponse } from "@/server/projects";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    assertTrustedWriteRequest(request, environment.appUrl);
    let body: unknown;
    try { body = await request.json(); } catch { throw new ProjectServiceError("INVALID_REQUEST", "Request body must be valid JSON.", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProjectServiceError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
    const cookieStore = await cookies();
    const user = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
    let ownerId: string;
    try { ownerId = (await requireVerifiedUser(user)).id; } catch { throw new ProjectServiceError("AUTH_REQUIRED", "Sign in to restore a project version.", 401); }
    const { id } = await context.params;
    const service = createProjectService({ store: createSupabaseProjectStore(createAdminSupabaseClient()), requestHashSecret: environment.supabaseSecretKey });
    const project = await service.restore(ownerId, id, body as { readonly versionId: unknown; readonly expectedRevision: unknown }, request.headers.get("idempotency-key") ?? "");
    return Response.json({ data: { projectId: project.id, revision: project.revision, restoredAt: project.updatedAt, documentHash: projectDocumentHash(project.document) }, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return projectErrorResponse(error, requestId);
  }
}
