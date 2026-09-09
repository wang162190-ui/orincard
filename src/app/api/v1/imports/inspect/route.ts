import { cookies } from "next/headers";
import { createRecoveryService, createSupabaseRecoveryStore, RecoveryError } from "@/server/recovery";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

export function createInspectHandler(dependencies: { authenticate(): Promise<string>; inspect(ownerId: string, assetId: string): Promise<unknown> }) {
  return async (request: Request) => {
    try {
      const body = await request.json() as { verifiedAssetId?: unknown };
      if (typeof body.verifiedAssetId !== "string") throw new RecoveryError("INVALID_PACKAGE", "verifiedAssetId is required.", 422);
      const ownerId = await dependencies.authenticate();
      return Response.json({ data: await dependencies.inspect(ownerId, body.verifiedAssetId) }, { status: 202, headers: { "Cache-Control": "private, no-store" } });
    } catch (error) {
      const failure = error instanceof RecoveryError ? error : new RecoveryError("INVALID_PACKAGE", "Recovery package could not be inspected.", 422);
      return Response.json({ error: { code: failure.code, message: failure.message } }, { status: failure.status, headers: { "Cache-Control": "private, no-store" } });
    }
  };
}

export async function POST(request: Request) {
  const cookieStore = await cookies(); const user = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: () => undefined });
  const service = createRecoveryService(createSupabaseRecoveryStore(createAdminSupabaseClient()));
  return createInspectHandler({ authenticate: async () => (await requireVerifiedUser(user)).id, inspect: service.inspect })(request);
}
