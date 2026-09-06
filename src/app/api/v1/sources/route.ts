import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { readServerEnvironment } from "../../../../server/environment";
import {
  SourceServiceError,
  createSupabaseSourceStore,
  createTextSourceService,
  sourceErrorResponse,
} from "../../../../server/sources";
import {
  createAdminSupabaseClient,
  createServerSupabaseClient,
  requireVerifiedUser,
} from "../../../../server/supabase";

async function body(request: Request): Promise<Record<string, unknown>> {
  try {
    const value: unknown = await request.json();
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error("body must be an object");
    }
    return value as Record<string, unknown>;
  } catch {
    throw new SourceServiceError(
      "INVALID_REQUEST",
      "Request body must be valid JSON.",
      400,
    );
  }
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) {
      throw new SourceServiceError(
        "INVALID_REQUEST",
        "This write request did not come from the configured application origin.",
        400,
      );
    }
    const cookieStore = await cookies();
    const userClient = createServerSupabaseClient({
      getAll: () => cookieStore.getAll(),
      set: (name, value, options) => cookieStore.set(name, value, options),
    });
    let ownerId: string;
    try {
      ownerId = (await requireVerifiedUser(userClient)).id;
    } catch {
      throw new SourceServiceError(
        "AUTH_REQUIRED",
        "Sign in before saving a source.",
        401,
      );
    }
    const service = createTextSourceService({
      store: createSupabaseSourceStore(createAdminSupabaseClient()),
    });
    const source = await service.create(ownerId, await body(request));
    return Response.json(
      { data: { sourceId: source.id, expiresAt: source.expiresAt }, requestId },
      { status: 201 },
    );
  } catch (error) {
    return sourceErrorResponse(error, requestId);
  }
}
