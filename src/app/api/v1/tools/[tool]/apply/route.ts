import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { TOOL_IDS, type ToolId } from "@/domain/tools";
import { readServerEnvironment } from "@/server/environment";
import { ProjectServiceError, assertTrustedWriteRequest, createProjectService, createSupabaseProjectStore, projectErrorResponse } from "@/server/projects";
import { applyToolResultToDocument, loadOwnedToolResult } from "@/server/tools/application";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export async function POST(request: Request, context: { readonly params: Promise<{ readonly tool: string }> }) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    assertTrustedWriteRequest(request, environment.appUrl);
    const body = await request.json() as Record<string, unknown>;
    if (body.confirmed !== true) throw new ProjectServiceError("INVALID_REQUEST", "Confirm before applying a tool result.", 400);
    const tool = (await context.params).tool as ToolId;
    if (!TOOL_IDS.includes(tool)) throw new ProjectServiceError("INVALID_REQUEST", "Unknown tool.", 400);
    const cookieStore = await cookies();
    const userClient = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
    let ownerId: string;
    try { ownerId = (await requireVerifiedUser(userClient)).id; } catch { throw new ProjectServiceError("AUTH_REQUIRED", "Sign in to apply a tool result.", 401); }
    if (typeof body.resultJobId !== "string" || typeof body.projectId !== "string") throw new ProjectServiceError("INVALID_REQUEST", "Result and project IDs are required.", 400);
    const admin = createAdminSupabaseClient();
    const result = await loadOwnedToolResult(admin, ownerId, body.resultJobId);
    if (result.tool !== tool || (result.contextProjectId && result.contextProjectId !== body.projectId)) throw new ProjectServiceError("NOT_FOUND", "Tool result was not found.", 404);
    const service = createProjectService({ store: createSupabaseProjectStore(admin), requestHashSecret: environment.supabaseSecretKey });
    const project = await service.get(ownerId, body.projectId);
    const document = applyToolResultToDocument(project.document, result.result, body.target);
    const saved = await service.save(ownerId, body.projectId, { expectedRevision: body.expectedRevision, document }, request.headers.get("idempotency-key") ?? "");
    return Response.json({ data: { projectId: saved.id, revision: saved.revision }, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return projectErrorResponse(error, requestId);
  }
}
