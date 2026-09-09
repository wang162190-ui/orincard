import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import { createSupabaseAccountPreferencesStore, loadAccountPreferences, saveAccountPreferences } from "@/server/account-export";
import { readServerEnvironment } from "@/server/environment";
import { assertTrustedWriteRequest } from "@/server/projects";
import { createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

async function context() {
  const cookieStore = await cookies();
  const client = createServerSupabaseClient({
    getAll: () => cookieStore.getAll(),
    set: (name, value, options) => cookieStore.set(name, value, options),
  });
  const ownerId = (await requireVerifiedUser(client)).id;
  return { client, ownerId };
}

function failure(requestId: string, error: unknown) {
  const invalid = error instanceof Error && error.message.includes("Preferences");
  return Response.json(
    { error: { code: invalid ? "INVALID_REQUEST" : "SERVICE_UNAVAILABLE", message: invalid ? error.message : "Settings are temporarily unavailable.", retryable: !invalid }, requestId },
    { status: invalid ? 400 : 503, headers: { "Cache-Control": "private, no-store" } },
  );
}

export async function GET() {
  const requestId = randomUUID();
  try {
    const { client, ownerId } = await context();
    const preferences = await loadAccountPreferences(createSupabaseAccountPreferencesStore(client), ownerId);
    return Response.json({ data: { preferences }, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return failure(requestId, error);
  }
}

export async function PATCH(request: Request) {
  const requestId = randomUUID();
  try {
    assertTrustedWriteRequest(request, readServerEnvironment(process.env).appUrl);
    const { client, ownerId } = await context();
    const preferences = await saveAccountPreferences(createSupabaseAccountPreferencesStore(client), ownerId, (await request.json()).preferences);
    return Response.json({ data: { preferences }, requestId }, { headers: { "Cache-Control": "private, no-store" } });
  } catch (error) {
    return failure(requestId, error);
  }
}
