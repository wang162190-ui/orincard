import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { ProjectServiceError, createProjectService, createSupabaseProjectStore, projectErrorResponse } from "@/server/projects";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";
import { readServerEnvironment } from "@/server/environment";

export async function GET(request: Request, context: { readonly params: Promise<{ readonly id: string }> }) {
  const requestId = randomUUID();
  try {
    const environment = readServerEnvironment(process.env);
    const cookieStore = await cookies();
    const user = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
    let ownerId: string;
    try { ownerId = (await requireVerifiedUser(user)).id; } catch { throw new ProjectServiceError("AUTH_REQUIRED", "Sign in to view project versions.", 401); }
    const { id } = await context.params;
    const limit = new URL(request.url).searchParams.get("limit") ?? undefined;
    const service = createProjectService({ store: createSupabaseProjectStore(createAdminSupabaseClient()), requestHashSecret: environment.supabaseSecretKey });
    const items = await service.listVersions(ownerId, id, limit);
    return Response.json({ data: { items }, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return projectErrorResponse(error, requestId);
  }
}
