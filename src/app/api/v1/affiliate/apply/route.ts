import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

type Application = { readonly id: string; readonly status: "pending" | "approved" | "rejected" };
export interface AffiliateApplicationStore {
  find(ownerId: string): Promise<Application | null>;
  create(input: { readonly ownerId: string; readonly channel: string; readonly audience: string }): Promise<Application>;
}

function reply(body: unknown, status: number) { return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } }); }

export function createAffiliateApplyHandler(dependencies: { readonly authenticate: () => Promise<string>; readonly store: AffiliateApplicationStore }) {
  return async (request: Request) => {
    let ownerId: string;
    try { ownerId = await dependencies.authenticate(); } catch { return reply({ error: { code: "AUTH_REQUIRED", message: "Sign in to apply." } }, 401); }
    let input: { channel?: unknown; audience?: unknown };
    try { input = await request.json(); } catch { return reply({ error: { code: "INVALID_REQUEST", message: "A valid JSON body is required." } }, 400); }
    const channel = typeof input.channel === "string" ? input.channel.trim() : "";
    const audience = typeof input.audience === "string" ? input.audience.trim() : "";
    if (!channel || channel.length > 120 || !audience || audience.length > 1_000) return reply({ error: { code: "INVALID_APPLICATION", message: "Channel and audience plan are required." } }, 400);
    const existing = await dependencies.store.find(ownerId);
    if (existing) return reply({ data: existing }, 200);
    const application = await dependencies.store.create({ ownerId, channel, audience });
    return reply({ data: application }, 201);
  };
}

export function createSupabaseAffiliateApplicationStore(client: SupabaseClient): AffiliateApplicationStore {
  return {
    async find(ownerId) { const result = await client.from("affiliate_applications").select("id,status").eq("owner_id", ownerId).maybeSingle(); if (result.error) throw result.error; return result.data; },
    async create(input) { const result = await client.from("affiliate_applications").insert({ owner_id: input.ownerId, channel: input.channel, audience: input.audience, status: "pending" }).select("id,status").single(); if (result.error) throw result.error; return result.data; },
  };
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userClient = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
  return createAffiliateApplyHandler({ authenticate: async () => (await requireVerifiedUser(userClient)).id, store: createSupabaseAffiliateApplicationStore(createAdminSupabaseClient()) })(request);
}
