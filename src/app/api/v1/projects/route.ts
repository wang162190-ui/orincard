import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { readServerEnvironment } from "../../../../server/environment";
import {
  ProjectServiceError,
  assertTrustedWriteRequest,
  createProjectService,
  createSupabaseProjectStore,
  projectErrorResponse,
} from "../../../../server/projects";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "../../../../server/supabase";

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
  const store = createSupabaseProjectStore(createAdminSupabaseClient());
  return {
    environment,
    ownerId,
    service: createProjectService({
      store,
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

export async function GET(request: Request) {
  const requestId = randomUUID();
  try {
    const { ownerId, service } = await context();
    const search = new URL(request.url).searchParams;
    const projects = await service.list(ownerId, {
      platform: search.get("platform") ?? undefined,
      state: search.get("state") ?? undefined,
      query: search.get("q") ?? undefined,
      limit: search.get("limit") ?? undefined,
    });
    return Response.json(
      { data: { projects, nextCursor: null }, requestId },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch (error) {
    return projectErrorResponse(error, requestId);
  }
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    const { environment, ownerId, service } = await context();
    assertTrustedWriteRequest(request, environment.appUrl);
    const body = await jsonBody(request);
    const project = await service.create(
      ownerId,
      {
        document: body.document,
        localDraftId: body.localDraftId,
        explicitMigrationConsent: body.explicitMigrationConsent,
      },
      request.headers.get("idempotency-key") ?? "",
    );
    return Response.json(
      { data: { projectId: project.id, revision: project.revision }, requestId },
      { status: 201 },
    );
  } catch (error) {
    return projectErrorResponse(error, requestId);
  }
}
