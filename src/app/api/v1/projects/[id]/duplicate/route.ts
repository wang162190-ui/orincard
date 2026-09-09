import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { readServerEnvironment } from "@/server/environment";
import { createProjectLibraryService, ProjectLibraryError, projectLibraryErrorResponse } from "@/server/project-library";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export async function POST(request: Request, context: { readonly params: Promise<{ readonly id: string }> }) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    if (request.headers.get("origin") !== new URL(environment.appUrl).origin) {
      throw new ProjectLibraryError("INVALID_REQUEST", "Untrusted request origin.", 400);
    }
    let body: unknown;
    try { body = await request.json(); } catch { throw new ProjectLibraryError("INVALID_REQUEST", "Request body must be valid JSON.", 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new ProjectLibraryError("INVALID_REQUEST", "Request body must be valid JSON.", 400);
    const cookieStore = await cookies();
    const userClient = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
    const ownerId = await requireVerifiedUser(userClient).then((user) => user.id).catch(() => { throw new ProjectLibraryError("NOT_FOUND", "Project not found.", 404); });
    const { id } = await context.params;
    const data = await createProjectLibraryService({ client: createAdminSupabaseClient(), requestHashSecret: environment.supabaseSecretKey }).duplicate(ownerId, id, (body as { expectedRevision?: unknown }).expectedRevision, request.headers.get("idempotency-key") ?? "");
    return Response.json({ data, requestId }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
  } catch (error) { return projectLibraryErrorResponse(error, requestId); }
}
