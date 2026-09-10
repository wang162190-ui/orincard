import { task } from "@trigger.dev/sdk";
import { createAdminSupabaseClient } from "../server/supabase";
import { BILLING_RECONCILE_TASK_ID, createSupabaseBillingEventStore, reconcileBillingEvent, type BillingSubscriptionProvider, type SubscriptionSnapshot } from "../server/billing/events";

function requiredString(value: unknown, code = "BILLING_PROVIDER_INVALID"): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(code);
  return value;
}

export function createStripeSubscriptionProvider(secretKey: string, fetcher: typeof fetch = fetch): BillingSubscriptionProvider {
  return {
    async retrieveSubscription(subjectId) {
      const response = await fetcher(`https://api.stripe.com/v1/subscriptions/${encodeURIComponent(subjectId)}?expand[]=latest_invoice`, { headers: { Authorization: `Bearer ${secretKey}` } });
      if (!response.ok) throw new Error("STRIPE_UNAVAILABLE");
      const data = await response.json() as Record<string, any>;
      const metadata = data.metadata as Record<string, unknown> | undefined;
      const start = Number(data.current_period_start);
      const end = Number(data.current_period_end);
      const updated = Number(data.ended_at ?? data.created);
      if (![start, end, updated].every(Number.isFinite)) throw new Error("BILLING_PROVIDER_INVALID");
      return {
        ownerId: requiredString(metadata?.owner_id), customerId: requiredString(data.customer),
        subscriptionId: requiredString(data.id), planKey: requiredString(metadata?.plan_key) as SubscriptionSnapshot["planKey"],
        policyVersion: requiredString(metadata?.policy_version), status: requiredString(data.status) as SubscriptionSnapshot["status"],
        periodStart: new Date(start * 1_000).toISOString(), periodEnd: new Date(end * 1_000).toISOString(),
        cancelAtPeriodEnd: data.cancel_at_period_end === true, providerUpdatedAt: new Date(updated * 1_000).toISOString(),
        invoiceId: typeof data.latest_invoice === "string" ? data.latest_invoice : typeof data.latest_invoice?.id === "string" ? data.latest_invoice.id : null,
      };
    },
  };
}

export function validateBillingReconcilePayload(payload: unknown) {
  if (!payload || typeof payload !== "object" || typeof (payload as any).eventId !== "string" || typeof (payload as any).subjectId !== "string") throw new Error("Invalid billing reconcile payload");
  return payload as { eventId: string; subjectId: string };
}

export const reconcileBillingTask = task({
  id: BILLING_RECONCILE_TASK_ID,
  maxDuration: 60,
  run: async (payload: unknown) => {
    const input = validateBillingReconcilePayload(payload);
    const secretKey = process.env.STRIPE_SECRET_KEY?.trim() ?? "";
    if (!secretKey.startsWith("sk_")) throw new Error("BILLING_NOT_CONFIGURED");
    return reconcileBillingEvent({ ...input, store: createSupabaseBillingEventStore(createAdminSupabaseClient()), provider: createStripeSubscriptionProvider(secretKey) });
  },
});
