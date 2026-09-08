import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { readServerEnvironment } from "../../../../server/environment";
import {
  SourceServiceError,
  createFileSourceService,
  createSupabaseFileSourceStore,
  createSupabaseSourceStore,
  createSupabaseUrlSourceStore,
  createTextSourceService,
  createUrlSourceService,
  sourceErrorResponse,
  sourceParseDispatcher,
} from "../../../../server/sources";
import {
  createNodeDnsResolver,
  createNodeHttpConnector,
  createSafeFetcher,
} from "../../../../server/sources/safe-fetch";
import { createUrlSourceParser } from "../../../../server/sources/url";
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
    const payload = await body(request);
    const idempotencyKey = request.headers.get("idempotency-key") ?? "";
    const admin = createAdminSupabaseClient();
    const requestHashSecret = environment.supabaseSecretKey;

    // One route, six kinds, three shapes of work behind them. The kind decides which
    // service runs and, with it, whether the source comes back readable or still parsing.
    const source =
      payload.kind === "url"
        ? await createUrlSourceService({
            store: createSupabaseUrlSourceStore(admin),
            // The fetcher is built per request so a parse cannot inherit another
            // request's sockets, and the resolver checks the address it will connect to.
            parser: createUrlSourceParser({
              fetch: createSafeFetcher({
                resolve: createNodeDnsResolver(),
                connect: createNodeHttpConnector(),
              }),
            }),
            requestHashSecret,
          }).create(ownerId, payload, idempotencyKey)
        : payload.kind === "pdf" || payload.kind === "slides" || payload.kind === "video"
          ? await createFileSourceService({
              store: createSupabaseFileSourceStore(admin),
              dispatcher: sourceParseDispatcher,
              requestHashSecret,
            }).create(ownerId, payload, idempotencyKey, requestId)
          : await createTextSourceService({
              store: createSupabaseSourceStore(admin),
              requestHashSecret,
            }).create(ownerId, payload, idempotencyKey);

    return Response.json(
      {
        data: {
          sourceId: source.id,
          kind: source.kind,
          state: source.state,
          expiresAt: source.expiresAt,
        },
        requestId,
      },
      // A file source is accepted, not finished: 202 says the reading is still to come.
      { status: source.state === "parsing" ? 202 : 201 },
    );
  } catch (error) {
    return sourceErrorResponse(error, requestId);
  }
}
