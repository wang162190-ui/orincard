import { cookies } from "next/headers";
import { createRecoveryService, createSupabaseRecoveryStore, RecoveryError } from "@/server/recovery";
import { readServerEnvironment } from "@/server/environment";
import { assertTrustedWriteRequest } from "@/server/projects";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export function createConfirmHandler(dependencies: { authenticate(): Promise<string>; assertOrigin(request: Request): void; confirm(ownerId: string, id: string, hash: string, accept: boolean): Promise<unknown> }) {
  return async (request: Request, id: string) => {
    try {
      dependencies.assertOrigin(request);
      const body = await request.json() as { inspectionHash?: unknown; acceptMissingAssets?: unknown };
      if (typeof body.inspectionHash !== "string" || typeof body.acceptMissingAssets !== "boolean") throw new RecoveryError("INVALID_PACKAGE", "inspectionHash and acceptMissingAssets are required.", 422);
      let ownerId: string;
      try { ownerId = await dependencies.authenticate(); }
      catch { throw new RecoveryError("AUTH_REQUIRED", "Sign in before restoring a recovery package.", 401); }
      return Response.json({ data: await dependencies.confirm(ownerId, id, body.inspectionHash, body.acceptMissingAssets) }, { status: 201, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      const failure = error instanceof RecoveryError ? error : new RecoveryError("INVALID_PACKAGE", "Recovery confirmation failed.", 422);
      return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status, headers: { "Cache-Control": "private, no-store" } });
    }
  };
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const environment = readServerEnvironment(process.env);
  const cookieStore = await cookies(); const user = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: () => undefined });
  const service = createRecoveryService(createSupabaseRecoveryStore(createAdminSupabaseClient())); const { id } = await context.params;
  return createConfirmHandler({ authenticate: async () => (await requireVerifiedUser(user)).id, assertOrigin: (input) => assertTrustedWriteRequest(input, environment.appUrl), confirm: service.confirm })(request, id);
}
