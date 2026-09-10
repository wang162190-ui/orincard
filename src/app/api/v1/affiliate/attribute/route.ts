import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createAffiliateAttributeHandler, type AffiliateStore } from "@/server/affiliate";
import { createAdminSupabaseClient, createServerSupabaseClient } from "@/server/supabase";

export function createSupabaseAffiliateStore(client: SupabaseClient): AffiliateStore {
  return {
    async findApprovedByCode(code) {
      const result = await client.from("affiliate_accounts").select("id,owner_id,state,referral_code,policy_version").eq("referral_code", code).eq("state", "approved").maybeSingle();
      if (result.error) throw result.error;
      return result.data ? { id: result.data.id, ownerId: result.data.owner_id, status: result.data.state, code: result.data.referral_code, policyVersion: result.data.policy_version } : null;
    },
    async createAttribution(input) {
      const result = await client.from("referrals").insert({ affiliate_account_id: input.affiliateId, affiliate_owner_id: input.affiliateOwnerId, referred_owner_id: input.referredOwnerId, code: input.code, policy_version: input.policyVersion, visitor_hash: input.visitorHash, consent_at: input.consentAt, expires_at: input.expiresAt, state: "active" });
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
