import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAffiliateAttributeHandler, type AffiliateStore } from "@/server/affiliate";
import { createAdminSupabaseClient, createServerSupabaseClient } from "@/server/supabase";

export function createSupabaseAffiliateStore(client: SupabaseClient): AffiliateStore {
  return {
    async findApprovedByCode(code) {
      const result = await client.from("affiliate_applications").select("id,owner_id,status,code").eq("code", code).eq("status", "approved").maybeSingle();
      if (result.error) throw result.error;
      return result.data ? { id: result.data.id, ownerId: result.data.owner_id, status: result.data.status, code: result.data.code } : null;
    },
    async createAttribution(input) {
      const result = await client.from("affiliate_attributions").insert({ affiliate_id: input.affiliateId, visitor_hash: input.visitorHash, expires_at: input.expiresAt });
      if (result.error) throw result.error;
    },
  };
}

export async function POST(request: Request) {
  const cookieStore = await cookies();
  const userClient = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: () => undefined });
  return createAffiliateAttributeHandler({
    store: createSupabaseAffiliateStore(createAdminSupabaseClient()),
    currentOwnerId: async () => (await userClient.auth.getUser()).data.user?.id ?? null,
  })(request);
}
