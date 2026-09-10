import { tasks } from "@trigger.dev/sdk";
import { createAdminSupabaseClient } from "@/server/supabase";
import { BILLING_RECONCILE_TASK_ID, createSupabaseBillingEventStore, verifyStripeWebhook, type BillingEventStore } from "@/server/billing/events";

export function createStripeWebhookHandler(dependencies: {
  secret: string;
  store: BillingEventStore;
  dispatch: (payload: { eventId: string; subjectId: string }) => Promise<unknown>;
  nowSeconds?: () => number;
}) {
  return async (request: Request) => {
    const rawBody = await request.text();
    let event;
    try {
      event = verifyStripeWebhook(rawBody, request.headers.get("stripe-signature"), dependencies.secret, dependencies.nowSeconds?.());
    } catch {
      return Response.json({ error: { code: "INVALID_SIGNATURE" } }, { status: 400 });
    }
    try {
      await dependencies.store.register(event);
      // Dispatch every verified delivery. If an earlier dispatch failed after the
      // durable insert, Stripe's retry must still be able to start reconciliation.
      // The event claim RPC makes duplicate tasks harmless.
      await dependencies.dispatch({ eventId: event.id, subjectId: event.subjectId });
      return Response.json({ received: true }, { status: 200 });
    } catch {
      return Response.json({ error: { code: "BILLING_UNAVAILABLE" } }, { status: 503 });
    }
  };
}

export async function POST(request: Request) {
  const secret = process.env.STRIPE_WEBHOOK_SECRET?.trim() ?? "";
  return createStripeWebhookHandler({
    secret,
    store: createSupabaseBillingEventStore(createAdminSupabaseClient()),
    dispatch: (payload) => tasks.trigger(BILLING_RECONCILE_TASK_ID, payload),
  })(request);
}
