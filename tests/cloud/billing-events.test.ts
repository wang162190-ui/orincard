import { createHmac } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createStripeWebhookHandler } from "../../src/app/api/v1/webhooks/stripe/route";
import { reconcileBillingEvent, verifyStripeWebhook, type BillingEventStore, type SubscriptionSnapshot } from "../../src/server/billing/events";

const secret = "whsec_acceptance_secret";
const timestamp = 1_800_000_000;
const body = JSON.stringify({ id: "evt_1", type: "customer.subscription.updated", data: { object: { object: "subscription", id: "sub_1" } } });
function signature(raw = body) { return `t=${timestamp},v1=${createHmac("sha256", secret).update(`${timestamp}.${raw}`).digest("hex")}`; }

function store(): BillingEventStore {
  return { register: vi.fn(async () => true), claim: vi.fn(async () => true), apply: vi.fn(async () => undefined), fail: vi.fn(async () => undefined) };
}
const snapshot: SubscriptionSnapshot = { ownerId: "00000000-0000-0000-0000-000000000001", customerId: "cus_1", subscriptionId: "sub_1", planKey: "pro", policyVersion: "2026-09", status: "active", periodStart: "2026-09-01T00:00:00.000Z", periodEnd: "2026-10-01T00:00:00.000Z", cancelAtPeriodEnd: false, providerUpdatedAt: "2026-09-10T00:00:00.000Z", invoiceId: "in_1" };

describe("T071 Stripe billing events", () => {
  it("verifies the exact raw body and rejects invalid or stale signatures", () => {
    expect(verifyStripeWebhook(body, signature(), secret, timestamp)).toEqual({ id: "evt_1", type: "customer.subscription.updated", subjectId: "sub_1" });
    expect(() => verifyStripeWebhook(`${body} `, signature(), secret, timestamp)).toThrow("INVALID_SIGNATURE");
    expect(() => verifyStripeWebhook(body, signature(), secret, timestamp + 301)).toThrow("INVALID_SIGNATURE");
  });

  it("persists before dispatch and does not acknowledge a persistence failure", async () => {
    const order: string[] = [];
    const durable = store();
    vi.mocked(durable.register).mockImplementation(async () => { order.push("persist"); return true; });
    const handler = createStripeWebhookHandler({ secret, store: durable, nowSeconds: () => timestamp, dispatch: async () => { order.push("dispatch"); } });
    const response = await handler(new Request("https://example.test/api/v1/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature() }, body }));
    expect(response.status).toBe(200);
    expect(order).toEqual(["persist", "dispatch"]);
    vi.mocked(durable.register).mockRejectedValue(new Error("offline"));
    expect((await handler(new Request("https://example.test/api/v1/webhooks/stripe", { method: "POST", headers: { "stripe-signature": signature() }, body }))).status).toBe(503);
  });

  it("redispatches duplicate deliveries so a failed first dispatch can recover", async () => {
    const duplicate = store();
    vi.mocked(duplicate.register).mockResolvedValue(false);
    const dispatch = vi.fn();
    const handler = createStripeWebhookHandler({ secret, store: duplicate, nowSeconds: () => timestamp, dispatch });
    expect((await handler(new Request("https://example.test", { method: "POST", headers: { "stripe-signature": signature() }, body }))).status).toBe(200);
    expect(dispatch).toHaveBeenCalledOnce();
  });

  it("reconciles from the current provider snapshot so out-of-order events converge", async () => {
    const events = store();
    const provider = { retrieveSubscription: vi.fn(async () => snapshot) };
    await expect(reconcileBillingEvent({ eventId: "evt_old", subjectId: "sub_1", store: events, provider })).resolves.toBe("applied");
    expect(events.apply).toHaveBeenCalledWith("evt_old", snapshot);
  });

  it("marks provider failures retryable and a later Trigger attempt compensates", async () => {
    const events = store();
    const provider = { retrieveSubscription: vi.fn().mockRejectedValueOnce(new Error("STRIPE_UNAVAILABLE")).mockResolvedValueOnce(snapshot) };
    await expect(reconcileBillingEvent({ eventId: "evt_retry", subjectId: "sub_1", store: events, provider })).rejects.toThrow("STRIPE_UNAVAILABLE");
    expect(events.fail).toHaveBeenCalledWith("evt_retry", "STRIPE_UNAVAILABLE");
    await expect(reconcileBillingEvent({ eventId: "evt_retry", subjectId: "sub_1", store: events, provider })).resolves.toBe("applied");
  });
});
