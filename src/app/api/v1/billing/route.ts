import { randomUUID } from "node:crypto";
import { cookies } from "next/headers";
import type { SupabaseClient } from "@supabase/supabase-js";
import { entitlementsForPlan, type PlanKey } from "@/domain/entitlements";
import { readServerEnvironment } from "@/server/environment";
import { loadEntitlementPolicy } from "@/server/billing/policy";
import { createAdminSupabaseClient, createServerSupabaseClient, requireVerifiedUser } from "@/server/supabase";

type SubscriptionSummary = { readonly planKey: PlanKey; readonly policyVersion: string; readonly status: string; readonly periodStart: string; readonly periodEnd: string; readonly cancelAtPeriodEnd: boolean };
type BalanceSummary = { readonly resource: string; readonly granted: number; readonly reserved: number; readonly consumed: number; readonly periodStart: string; readonly periodEnd: string };

export interface BillingSummaryStore {
  subscription(ownerId: string): Promise<SubscriptionSummary | null>;
  balances(ownerId: string, now: Date): Promise<readonly BalanceSummary[]>;
}

export function createSupabaseBillingSummaryStore(client: SupabaseClient): BillingSummaryStore {
  return {
    async subscription(ownerId) {
      const result = await client.from("subscriptions").select("plan_key,policy_version,status,current_period_start,current_period_end,cancel_at_period_end").eq("owner_id", ownerId).maybeSingle();
      if (result.error) throw result.error;
      return result.data ? { planKey: result.data.plan_key, policyVersion: result.data.policy_version, status: result.data.status, periodStart: result.data.current_period_start, periodEnd: result.data.current_period_end, cancelAtPeriodEnd: result.data.cancel_at_period_end } : null;
    },
    async balances(ownerId, now) {
      const instant = now.toISOString();
      const result = await client.from("usage_accounts").select("resource,granted,reserved,consumed,period_start,period_end").eq("owner_id", ownerId).lte("period_start", instant).gt("period_end", instant).order("resource");
      if (result.error) throw result.error;
      return (result.data ?? []).map((row) => ({ resource: row.resource, granted: Number(row.granted), reserved: Number(row.reserved), consumed: Number(row.consumed), periodStart: row.period_start, periodEnd: row.period_end }));
    },
  };
}

function reply(body: unknown, status: number) { return Response.json(body, { status, headers: { "Cache-Control": "private, no-store" } }); }

export function createBillingSummaryHandler(dependencies: { readonly authenticate: () => Promise<string>; readonly store: BillingSummaryStore; readonly environment: NodeJS.ProcessEnv; readonly now?: () => Date }) {
  return async () => {
    const requestId = randomUUID();
    try {
      let ownerId: string;
      try { ownerId = await dependencies.authenticate(); } catch { return reply({ error: { code: "AUTH_REQUIRED", message: "Sign in to view billing.", retryable: false }, requestId }, 401); }
      const environment = readServerEnvironment(dependencies.environment);
      const rawPolicy = dependencies.environment.BILLING_POLICY_JSON;
      const policy = loadEntitlementPolicy({ appEnvironment: environment.appEnvironment, policy: rawPolicy ? JSON.parse(rawPolicy) : undefined });
      const now = dependencies.now?.() ?? new Date();
      const [subscription, balances] = await Promise.all([dependencies.store.subscription(ownerId), dependencies.store.balances(ownerId, now)]);
      const planKey = subscription?.planKey ?? "free";
      return reply({ data: {
        planKey,
        policyVersion: subscription?.policyVersion ?? policy.version,
        status: subscription?.status ?? "active",
        currentPeriod: subscription ? { start: subscription.periodStart, end: subscription.periodEnd } : null,
        cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
        entitlements: entitlementsForPlan(policy, planKey),
        balances: balances.map((balance) => ({ ...balance, remaining: Math.max(0, balance.granted - balance.reserved - balance.consumed) })),
      }, requestId }, 200);
    } catch (error) {
      const unavailable = error instanceof Error && (error.message.includes("BILLING_NOT_CONFIGURED") || error instanceof SyntaxError);
      return reply({ error: { code: unavailable ? "BILLING_NOT_CONFIGURED" : "BILLING_UNAVAILABLE", message: unavailable ? "Billing is not configured for this environment." : "Billing is temporarily unavailable.", retryable: !unavailable }, requestId }, 503);
    }
  };
}

export async function GET() {
  const cookieStore = await cookies();
  const userClient = createServerSupabaseClient({ getAll: () => cookieStore.getAll(), set: (name, value, options) => cookieStore.set(name, value, options) });
  return createBillingSummaryHandler({ authenticate: async () => (await requireVerifiedUser(userClient)).id, store: createSupabaseBillingSummaryStore(createAdminSupabaseClient()), environment: process.env })();
}
