import { createHash } from "node:crypto";

export type StripeMode = "test" | "live";
export type BillingInterval = "month" | "year";

export interface BillingCustomerStore {
  find(ownerId: string, mode: StripeMode): Promise<string | null>;
  save(ownerId: string, mode: StripeMode, customerId: string): Promise<string>;
}

export interface StripeProvider {
  createCustomer(input: { readonly ownerId: string; readonly idempotencyKey: string }): Promise<string>;
  promotionActive(promotionCodeId: string): Promise<boolean>;
  createCheckout(input: { readonly customerId: string; readonly priceId: string; readonly promotionCodeId?: string; readonly successUrl: string; readonly cancelUrl: string; readonly idempotencyKey: string }): Promise<string>;
  createPortal(input: { readonly customerId: string; readonly returnUrl: string; readonly idempotencyKey: string }): Promise<string>;
}

export type StripeBillingConfig = {
  readonly mode: StripeMode;
  readonly secretKey: string;
  readonly appUrl: string;
  readonly prices: Readonly<Record<string, Partial<Record<BillingInterval, string>>>>;
  readonly promotions: Readonly<Record<string, string>>;
};

function parseMap(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const parsed: unknown = JSON.parse(value);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.values(parsed).some((item) => typeof item !== "string")) throw new Error("BILLING_NOT_CONFIGURED");
  return parsed as Record<string, string>;
}

export function readStripeBillingConfig(environment: Readonly<Record<string, string | undefined>>): StripeBillingConfig {
  const mode: StripeMode = environment.VERCEL_ENV === "production" ? "live" : "test";
  const prefix = mode === "live" ? "STRIPE_LIVE" : "STRIPE_TEST";
  const secretKey = environment[`${prefix}_SECRET_KEY`]?.trim() ?? "";
  const appUrl = environment.NEXT_PUBLIC_APP_URL?.trim() ?? "";
  const monthly = parseMap(environment[`${prefix}_MONTHLY_PRICES_JSON`]);
  const yearly = parseMap(environment[`${prefix}_YEARLY_PRICES_JSON`]);
  if (!secretKey.startsWith(mode === "live" ? "sk_live_" : "sk_test_") || !appUrl) throw new Error("BILLING_NOT_CONFIGURED");
  const keys = new Set([...Object.keys(monthly), ...Object.keys(yearly)]);
  const prices = Object.fromEntries([...keys].map((key) => [key, { month: monthly[key], year: yearly[key] }]));
  if (keys.size === 0 || Object.values(monthly).concat(Object.values(yearly)).some((id) => !id.startsWith("price_"))) throw new Error("BILLING_NOT_CONFIGURED");
  return { mode, secretKey, appUrl: new URL(appUrl).origin, prices, promotions: parseMap(environment[`${prefix}_PROMOTION_CODES_JSON`]) };
}

function stableKey(parts: readonly string[]) {
  return createHash("sha256").update(parts.join(":"), "utf8").digest("hex");
}

async function customer(store: BillingCustomerStore, provider: StripeProvider, ownerId: string, mode: StripeMode) {
  const existing = await store.find(ownerId, mode);
  if (existing) return existing;
  const created = await provider.createCustomer({ ownerId, idempotencyKey: `customer-${stableKey([mode, ownerId])}` });
  return store.save(ownerId, mode, created);
}

export async function startCheckout(input: { readonly ownerId: string; readonly planKey: string; readonly interval: BillingInterval; readonly promotionKey?: string; readonly requestKey: string; readonly config: StripeBillingConfig; readonly store: BillingCustomerStore; readonly provider: StripeProvider }) {
  const priceId = input.config.prices[input.planKey]?.[input.interval];
  if (!priceId) throw new Error("PLAN_NOT_AVAILABLE");
  const customerId = await customer(input.store, input.provider, input.ownerId, input.config.mode);
  const configuredPromotion = input.promotionKey ? input.config.promotions[input.promotionKey] : undefined;
  const promotionCodeId = configuredPromotion && await input.provider.promotionActive(configuredPromotion) ? configuredPromotion : undefined;
  const key = `checkout-${stableKey([input.config.mode, input.ownerId, input.planKey, input.interval, input.requestKey])}`;
  return input.provider.createCheckout({ customerId, priceId, promotionCodeId, successUrl: `${input.config.appUrl}/billing?checkout=success`, cancelUrl: `${input.config.appUrl}/billing?checkout=canceled`, idempotencyKey: key });
}

export async function startPortal(input: { readonly ownerId: string; readonly requestKey: string; readonly config: StripeBillingConfig; readonly store: BillingCustomerStore; readonly provider: StripeProvider }) {
  const customerId = await input.store.find(input.ownerId, input.config.mode);
  if (!customerId) throw new Error("CUSTOMER_NOT_FOUND");
  return input.provider.createPortal({ customerId, returnUrl: `${input.config.appUrl}/billing`, idempotencyKey: `portal-${stableKey([input.config.mode, input.ownerId, input.requestKey])}` });
}

export function createStripeFetchProvider(secretKey: string, fetcher: typeof fetch = fetch): StripeProvider {
  async function post(path: string, body: URLSearchParams, idempotencyKey: string) {
    const response = await fetcher(`https://api.stripe.com/v1/${path}`, { method: "POST", headers: { Authorization: `Bearer ${secretKey}`, "Content-Type": "application/x-www-form-urlencoded", "Idempotency-Key": idempotencyKey }, body });
    const data = await response.json() as Record<string, unknown>;
    if (!response.ok) throw new Error("STRIPE_UNAVAILABLE");
    return data;
  }
  return {
    async createCustomer(input) {
      const data = await post("customers", new URLSearchParams({ "metadata[owner_id]": input.ownerId }), input.idempotencyKey);
      if (typeof data.id !== "string" || !data.id.startsWith("cus_")) throw new Error("STRIPE_UNAVAILABLE");
      return data.id;
    },
    async promotionActive(id) {
      const response = await fetcher(`https://api.stripe.com/v1/promotion_codes/${encodeURIComponent(id)}`, { headers: { Authorization: `Bearer ${secretKey}` } });
      if (!response.ok) return false;
      const data = await response.json() as Record<string, unknown>;
      return data.active === true;
    },
    async createCheckout(input) {
      const body = new URLSearchParams({ mode: "subscription", customer: input.customerId, "line_items[0][price]": input.priceId, "line_items[0][quantity]": "1", success_url: input.successUrl, cancel_url: input.cancelUrl, client_reference_id: input.customerId });
      if (input.promotionCodeId) body.set("discounts[0][promotion_code]", input.promotionCodeId);
      const data = await post("checkout/sessions", body, input.idempotencyKey);
      if (typeof data.url !== "string" || !data.url.startsWith("https://checkout.stripe.com/")) throw new Error("STRIPE_UNAVAILABLE");
      return data.url;
    },
    async createPortal(input) {
      const data = await post("billing_portal/sessions", new URLSearchParams({ customer: input.customerId, return_url: input.returnUrl }), input.idempotencyKey);
      if (typeof data.url !== "string" || !data.url.startsWith("https://billing.stripe.com/")) throw new Error("STRIPE_UNAVAILABLE");
      return data.url;
    },
  };
}
