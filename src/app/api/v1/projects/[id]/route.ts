import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { readServerEnvironment } from "../../../../../server/environment";
import {
  ProjectServiceError,
  assertTrustedWriteRequest,
  createProjectService,
  createSupabaseProjectStore,
  projectDocumentHash,
  projectErrorResponse,
} from "../../../../../server/projects";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "../../../../../server/supabase";
import { createDeletionService, createSupabaseDeletionStore, deletionErrorResponse } from "../../../../../server/deletion";
import { deletionCleanupDispatcher } from "../../../../../trigger/dispatch";

async function context() {
  const environment = readServerEnvironment(process.env);
  const cookieStore = await cookies();
  const userClient = createServerSupabaseClient({
    getAll: () => cookieStore.getAll(),
    set: (name, value, options) => cookieStore.set(name, value, options),
  });
  let ownerId: string;
  try {
    ownerId = (await requireVerifiedUser(userClient)).id;
  } catch {
    throw new ProjectServiceError(
      "AUTH_REQUIRED",
      "Sign in to access saved projects.",
      401,
    );
  }
  return {
    environment,
    ownerId,
    service: createProjectService({
      store: createSupabaseProjectStore(createAdminSupabaseClient()),
      requestHashSecret: environment.supabaseSecretKey,
    }),
  };
}

async function jsonBody(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("body must be an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new ProjectServiceError(
      "INVALID_REQUEST",
      "Request body must be valid JSON.",
      400,
    );
  }
}

export async function GET(
  _request: Request,
  contextInput: { readonly params: Promise<{ readonly id: string }> },
) {
  const requestId = randomUUID();
  try {
    const [{ id }, { ownerId, service }] = await Promise.all([
      contextInput.params,
      context(),
    ]);
    const project = await service.get(ownerId, id);
    return Response.json(
      {
        data: {
          ...project,
          saveState: "saved",
          documentHash: projectDocumentHash(project.document),
        },
        requestId,
      },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return projectErrorResponse(error, requestId);
  }
}

export async function PUT(
  request: Request,
  contextInput: { readonly params: Promise<{ readonly id: string }> },
) {
  const requestId = randomUUID();
  try {
    const [{ id }, { environment, ownerId, service }] = await Promise.all([
      contextInput.params,
      context(),
    ]);
    assertTrustedWriteRequest(request, environment.appUrl);
    const body = await jsonBody(request);
    const project = await service.save(
      ownerId,
      id,
      { expectedRevision: body.expectedRevision, document: body.document },
      request.headers.get("idempotency-key") ?? "",
    );
    return Response.json({
      data: {
        projectId: project.id,
        revision: project.revision,
        savedAt: project.updatedAt,
        documentHash: projectDocumentHash(project.document),
      },
      requestId,
    });
  } catch (error) {
    return projectErrorResponse(error, requestId);
  }
}

export async function DELETE(
  request: Request,
  contextInput: { readonly params: Promise<{ readonly id: string }> },
) {
  const requestId = randomUUID();
  try {
    const [{ id }, { environment, ownerId }] = await Promise.all([contextInput.params, context()]);
    assertTrustedWriteRequest(request, environment.appUrl);
    const deletionId = await createDeletionService(createSupabaseDeletionStore(createAdminSupabaseClient())).requestProject(ownerId, id);
    try { await deletionCleanupDispatcher.trigger({ jobId: deletionId, schemaVersion: 1, requestId }, `deletion:${deletionId}`); } catch { /* Durable request remains retryable. */ }
    return Response.json({ data: { deletionId, state: "deleting" }, requestId }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    if (error instanceof ProjectServiceError) return projectErrorResponse(error, requestId);
    return deletionErrorResponse(error, requestId);
  }
}
