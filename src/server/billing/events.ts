import { createHmac, timingSafeEqual } from "node:crypto";

export const BILLING_RECONCILE_TASK_ID = "orincard-reconcile-billing";

export type BillingEventMetadata = Readonly<{
  id: string;
  type: string;
  subjectId: string;
}>;

export type SubscriptionSnapshot = Readonly<{
  ownerId: string;
  customerId: string;
  subscriptionId: string;
  planKey: "free" | "pro" | "creator";
  policyVersion: string;
  status: "trialing" | "active" | "past_due" | "canceled" | "unpaid";
  periodStart: string;
  periodEnd: string;
  cancelAtPeriodEnd: boolean;
  providerUpdatedAt: string;
  invoiceId: string | null;
}>;

export interface BillingEventStore {
  register(event: BillingEventMetadata): Promise<boolean>;
  claim(eventId: string): Promise<boolean>;
  apply(eventId: string, snapshot: SubscriptionSnapshot): Promise<void>;
  fail(eventId: string, code: string): Promise<void>;
}

export interface BillingSubscriptionProvider {
  retrieveSubscription(subjectId: string): Promise<SubscriptionSnapshot>;
}

function signatureParts(header: string) {
  const values = new Map<string, string[]>();
  for (const part of header.split(",")) {
    const [key, value] = part.split("=", 2);
    if (key && value) values.set(key, [...(values.get(key) ?? []), value]);
  }
  return values;
}

export function verifyStripeWebhook(
  rawBody: string,
  signatureHeader: string | null,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1_000),
): BillingEventMetadata {
  if (!signatureHeader || !secret.startsWith("whsec_")) throw new Error("INVALID_SIGNATURE");
  const parts = signatureParts(signatureHeader);
  const timestamp = Number(parts.get("t")?.[0]);
  if (!Number.isInteger(timestamp) || Math.abs(nowSeconds - timestamp) > 300) throw new Error("INVALID_SIGNATURE");
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest();
  const valid = (parts.get("v1") ?? []).some((candidate) => {
    if (!/^[a-f\d]{64}$/i.test(candidate)) return false;
    return timingSafeEqual(expected, Buffer.from(candidate, "hex"));
  });
  if (!valid) throw new Error("INVALID_SIGNATURE");

  const event = JSON.parse(rawBody) as Record<string, unknown>;
  const data = event.data as { object?: Record<string, unknown> } | undefined;
  const object = data?.object;
  const id = event.id;
  const type = event.type;
  const subjectId = object?.object === "subscription"
    ? object.id
    : object?.subscription;
  if (typeof id !== "string" || typeof type !== "string" || typeof subjectId !== "string") {
    throw new Error("UNSUPPORTED_EVENT");
  }
  return { id, type, subjectId };
}

export async function reconcileBillingEvent(input: {
  eventId: string;
  subjectId: string;
  store: BillingEventStore;
  provider: BillingSubscriptionProvider;
}): Promise<"applied" | "already_converged"> {
  if (!(await input.store.claim(input.eventId))) return "already_converged";
  try {
    const snapshot = await input.provider.retrieveSubscription(input.subjectId);
    await input.store.apply(input.eventId, snapshot);
    return "applied";
  } catch (error) {
    await input.store.fail(input.eventId, error instanceof Error ? error.message : "BILLING_RECONCILE_FAILED");
    throw error;
  }
}

export function createSupabaseBillingEventStore(client: {
  rpc(name: string, parameters: Record<string, unknown>): PromiseLike<{ data: unknown; error: { message: string } | null }>;
}): BillingEventStore {
  async function rpc(name: string, parameters: Record<string, unknown>) {
    const result = await client.rpc(name, parameters);
    if (result.error) throw new Error("BILLING_STORE_UNAVAILABLE");
    return result.data;
  }
  return {
    async register(event) {
      return (await rpc("server_register_billing_event", { p_provider_event_id: event.id, p_type: event.type, p_subject_id: event.subjectId })) === true;
    },
    async claim(eventId) {
      const data = await rpc("server_claim_billing_event", { p_provider_event_id: eventId });
      return Array.isArray(data) ? data.length > 0 : Boolean(data);
    },
    async apply(eventId, snapshot) {
      await rpc("server_apply_billing_event", {
        p_provider_event_id: eventId, p_owner_id: snapshot.ownerId,
        p_provider_customer_id: snapshot.customerId, p_provider_subscription_id: snapshot.subscriptionId,
        p_plan_key: snapshot.planKey, p_policy_version: snapshot.policyVersion, p_status: snapshot.status,
        p_current_period_start: snapshot.periodStart, p_current_period_end: snapshot.periodEnd,
        p_cancel_at_period_end: snapshot.cancelAtPeriodEnd, p_provider_updated_at: snapshot.providerUpdatedAt,
        p_provider_invoice_id: snapshot.invoiceId, p_action: "subscription.reconciled",
        p_details: { source: "stripe_webhook" },
      });
    },
    async fail(eventId, code) {
      await rpc("server_fail_billing_event", { p_provider_event_id: eventId, p_error_code: code });
    },
  };
}
