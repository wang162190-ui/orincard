import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { summarizeAffiliate, type AffiliateApplication } from "@/server/affiliate";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

type DashboardRows = { readonly application: AffiliateApplication | null; readonly clicks: number; readonly conversions: number; readonly ledger: readonly { readonly kind: "commission" | "refund"; readonly amountCents: number }[] };
export interface AffiliateDashboardStore { summary(ownerId: string): Promise<DashboardRows>; }

function reply(body: unknown, status: number) { return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } }); }

export function createAffiliateDashboardHandler(dependencies: { readonly authenticate: () => Promise<string>; readonly store: AffiliateDashboardStore; readonly publicUrl: string }) {
  return async () => {
    let ownerId: string;
    try { ownerId = await dependencies.authenticate(); } catch { return reply({ error: { code: "AUTH_REQUIRED", message: "Sign in to view affiliate status." } }, 401); }
    const rows = await dependencies.store.summary(ownerId);
    return reply({ data: summarizeAffiliate({ ...rows, publicUrl: dependencies.publicUrl }) }, 200);
  };
}

export function createSupabaseAffiliateDashboardStore(client: SupabaseClient): AffiliateDashboardStore {
  return { async summary(ownerId) {
    const applicationResult = await client.from("affiliate_applications").select("id,owner_id,status,code").eq("owner_id", ownerId).maybeSingle();
    if (applicationResult.error) throw applicationResult.error;
    if (!applicationResult.data) return { application: null, clicks: 0, conversions: 0, ledger: [] };
    const application = { id: applicationResult.data.id, ownerId: applicationResult.data.owner_id, status: applicationResult.data.status, code: applicationResult.data.code } as AffiliateApplication;
    const [clicks, conversions, ledger] = await Promise.all([
      client.from("affiliate_attributions").select("id", { count: "exact", head: true }).eq("affiliate_id", application.id),
      client.from("affiliate_conversions").select("id", { count: "exact", head: true }).eq("affiliate_id", application.id),
      client.from("affiliate_commissions").select("kind,amount_cents").eq("affiliate_id", application.id),
    ]);
    if (clicks.error) throw clicks.error; if (conversions.error) throw conversions.error; if (ledger.error) throw ledger.error;
    return { application, clicks: clicks.count ?? 0, conversions: conversions.count ?? 0, ledger: (ledger.data ?? []).map((row) => ({ kind: row.kind as "commission" | "refund", amountCents: Number(row.amount_cents) })) };
  } };
}

export async function GET() {
  const cookieStore = await cookies();
  const userClient = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
  return createAffiliateDashboardHandler({ authenticate: async () => (await requireVerifiedUser(userClient)).id, store: createSupabaseAffiliateDashboardStore(createAdminSupabaseClient()), publicUrl: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000" })();
}
