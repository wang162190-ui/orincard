import { describe, expect, it, vi } from "vitest";
import { readStripeBillingConfig, startCheckout, startPortal, type BillingCustomerStore, type StripeProvider } from "../../src/server/billing/stripe";

const testEnvironment = {
  VERCEL_ENV: "preview",
  NEXT_PUBLIC_APP_URL: "https://preview.orincard.test/path",
  STRIPE_TEST_SECRET_KEY: "sk_test_example",
  STRIPE_TEST_MONTHLY_PRICES_JSON: JSON.stringify({ pro: "price_test_month" }),
  STRIPE_TEST_YEARLY_PRICES_JSON: JSON.stringify({ pro: "price_test_year" }),
  STRIPE_TEST_PROMOTION_CODES_JSON: JSON.stringify({ launch: "promo_test_launch" }),
};

function fixtures(customerId: string | null = "cus_server_owned") {
  let saved = customerId;
  const store: BillingCustomerStore = {
    find: vi.fn(async () => saved),
    save: vi.fn(async (_owner, _mode, value) => { saved = value; return value; }),
  };
  const provider: StripeProvider = {
    createCustomer: vi.fn(async () => "cus_created"),
    promotionActive: vi.fn(async () => true),
    createCheckout: vi.fn(async () => "https://checkout.stripe.com/c/pay/test"),
    createPortal: vi.fn(async () => "https://billing.stripe.com/p/session/test"),
  };
  return { store, provider };
}

describe("T070 Stripe Checkout and Portal", () => {
  it("keeps test and live credentials strictly separated", () => {
    expect(readStripeBillingConfig(testEnvironment).mode).toBe("test");
    expect(() => readStripeBillingConfig({ ...testEnvironment, STRIPE_TEST_SECRET_KEY: "sk_live_wrong" })).toThrow("BILLING_NOT_CONFIGURED");
    expect(() => readStripeBillingConfig({ ...testEnvironment, VERCEL_ENV: "production" })).toThrow("BILLING_NOT_CONFIGURED");
    const live = readStripeBillingConfig({ VERCEL_ENV: "production", NEXT_PUBLIC_APP_URL: "https://orincard.com", STRIPE_LIVE_SECRET_KEY: "sk_live_example", STRIPE_LIVE_MONTHLY_PRICES_JSON: JSON.stringify({ pro: "price_live_month" }) });
    expect(live.mode).toBe("live");
    expect(live.secretKey).toBe("sk_live_example");
  });

  it("uses only the server customer, price and active allowed promotion", async () => {
    const { store, provider } = fixtures();
    await startCheckout({ ownerId: "owner-1", planKey: "pro", interval: "month", promotionKey: "launch", requestKey: "click-key", config: readStripeBillingConfig(testEnvironment), store, provider });
    expect(provider.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cus_server_owned", priceId: "price_test_month", promotionCodeId: "promo_test_launch", successUrl: "https://preview.orincard.test/billing?checkout=success" }));
    expect(provider.createCustomer).not.toHaveBeenCalled();
  });

  it("does not apply unknown or inactive promotion codes", async () => {
    const unknown = fixtures();
    await startCheckout({ ownerId: "owner-1", planKey: "pro", interval: "year", promotionKey: "client-invented", requestKey: "unknown-promo", config: readStripeBillingConfig(testEnvironment), ...unknown });
    expect(unknown.provider.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ promotionCodeId: undefined, priceId: "price_test_year" }));
    expect(unknown.provider.promotionActive).not.toHaveBeenCalled();
    const inactive = fixtures();
    vi.mocked(inactive.provider.promotionActive).mockResolvedValue(false);
    await startCheckout({ ownerId: "owner-1", planKey: "pro", interval: "month", promotionKey: "launch", requestKey: "inactive-promo", config: readStripeBillingConfig(testEnvironment), ...inactive });
    expect(inactive.provider.createCheckout).toHaveBeenCalledWith(expect.objectContaining({ promotionCodeId: undefined }));
  });

  it("reuses deterministic provider idempotency for repeated checkout clicks", async () => {
    const fixturesOne = fixtures(null);
    const input = { ownerId: "owner-1", planKey: "pro", interval: "month" as const, requestKey: "same-click", config: readStripeBillingConfig(testEnvironment), ...fixturesOne };
    await startCheckout(input);
    await startCheckout(input);
    expect(fixturesOne.provider.createCustomer).toHaveBeenCalledTimes(1);
    const calls = vi.mocked(fixturesOne.provider.createCheckout).mock.calls;
    expect(calls[0][0].idempotencyKey).toBe(calls[1][0].idempotencyKey);
  });

  it("opens Portal only for the server-owned customer mapping", async () => {
    const mapped = fixtures();
    await expect(startPortal({ ownerId: "owner-1", requestKey: "portal-key", config: readStripeBillingConfig(testEnvironment), ...mapped })).resolves.toBe("https://billing.stripe.com/p/session/test");
    expect(mapped.provider.createPortal).toHaveBeenCalledWith(expect.objectContaining({ customerId: "cus_server_owned", returnUrl: "https://preview.orincard.test/billing" }));
    const missing = fixtures(null);
    await expect(startPortal({ ownerId: "owner-1", requestKey: "portal-key", config: readStripeBillingConfig(testEnvironment), ...missing })).rejects.toThrow("CUSTOMER_NOT_FOUND");
  });
});
