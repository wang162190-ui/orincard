import { cookies } from "next/headers";
import { createRecoveryService, createSupabaseRecoveryStore, RecoveryError } from "@/server/recovery";
import { readServerEnvironment } from "@/server/environment";
import { assertTrustedWriteRequest } from "@/server/projects";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export function createInspectHandler(dependencies: { authenticate(): Promise<string>; assertOrigin(request: Request): void; inspect(ownerId: string, assetId: string): Promise<unknown> }) {
  return async (request: Request) => {
    try {
      dependencies.assertOrigin(request);
      const body = await request.json() as { verifiedAssetId?: unknown };
      if (typeof body.verifiedAssetId !== "string") throw new RecoveryError("INVALID_PACKAGE", "verifiedAssetId is required.", 422);
      let ownerId: string;
      try { ownerId = await dependencies.authenticate(); }
      catch { throw new RecoveryError("AUTH_REQUIRED", "Sign in before inspecting a recovery package.", 401); }
      return Response.json({ data: await dependencies.inspect(ownerId, body.verifiedAssetId) }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      const failure = error instanceof RecoveryError ? error : new RecoveryError("INVALID_PACKAGE", "Recovery package could not be inspected.", 422);
      return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status, headers: { "Cache-Control": "private, no-store" } });
    }
  };
}

export async function POST(request: Request) {
  const environment = readServerEnvironment(process.env);
  const cookieStore = await cookies(); const user = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: () => undefined });
  const service = createRecoveryService(createSupabaseRecoveryStore(createAdminSupabaseClient()));
  return createInspectHandler({ authenticate: async () => (await requireVerifiedUser(user)).id, assertOrigin: (input) => assertTrustedWriteRequest(input, environment.appUrl), inspect: service.inspect })(request);
}
