import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createStripeFetchProvider, readStripeBillingConfig, startCheckout, startPortal, type BillingCustomerStore } from "../../src/server/billing/stripe";

const root = fileURLToPath(new URL("../..", import.meta.url));

function required(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`T073 real billing acceptance requires ${name}.`);
  return value;
}

describe("T073 billing lifecycle acceptance gates", () => {
  it("does not enable a real Sandbox run without an explicit opt-in and Price mapping", () => {
    if (process.env.RUN_STRIPE_SANDBOX_LIFECYCLE === "1") {
      expect(process.env.STRIPE_TEST_SECRET_KEY).toMatch(/^sk_test_/);
      expect(process.env.STRIPE_TEST_MONTHLY_PRICES_JSON).toContain("price_");
      return;
    }
    expect(process.env.RUN_STRIPE_SANDBOX_LIFECYCLE).not.toBe("1");
  });
});

describe.runIf(process.env.RUN_STRIPE_SANDBOX_LIFECYCLE === "1")("real Stripe Sandbox hosted-session gate", () => {
  it("creates a test customer, Checkout URL and Portal URL, then deletes the test customer", async () => {
    const secretKey = required("STRIPE_TEST_SECRET_KEY");
    if (!secretKey.startsWith("sk_test_")) throw new Error("T073 refuses a live Stripe key.");
    const environment = {
      VERCEL_ENV: "preview",
      NEXT_PUBLIC_APP_URL: required("NEXT_PUBLIC_APP_URL"),
      STRIPE_TEST_SECRET_KEY: secretKey,
      STRIPE_TEST_MONTHLY_PRICES_JSON: required("STRIPE_TEST_MONTHLY_PRICES_JSON"),
      STRIPE_TEST_YEARLY_PRICES_JSON: process.env.STRIPE_TEST_YEARLY_PRICES_JSON,
      STRIPE_TEST_PROMOTION_CODES_JSON: process.env.STRIPE_TEST_PROMOTION_CODES_JSON,
    };
    const config = readStripeBillingConfig(environment);
    const planKey = required("STRIPE_TEST_ACCEPTANCE_PLAN_KEY");
    const provider = createStripeFetchProvider(secretKey);
    let customerId: string | null = null;
    const store: BillingCustomerStore = {
      async find() { return customerId; },
      async save(_ownerId, _mode, value) { customerId = value; return value; },
    };
    try {
      const checkoutUrl = await startCheckout({ ownerId: "00000000-0000-4000-8000-000000000073", planKey, interval: "month", requestKey: `t073-${Date.now()}`, config, store, provider });
      expect(checkoutUrl).toMatch(/^https:\/\/checkout\.stripe\.com\//);
      const portalUrl = await startPortal({ ownerId: "00000000-0000-4000-8000-000000000073", requestKey: `t073-portal-${Date.now()}`, config, store, provider });
      expect(portalUrl).toMatch(/^https:\/\/billing\.stripe\.com\//);
    } finally {
      if (customerId) {
        const response = await fetch(`https://api.stripe.com/v1/customers/${encodeURIComponent(customerId)}`, { method: "DELETE", headers: { Authorization: `Bearer ${secretKey}` } });
        if (!response.ok) throw new Error("T073 could not clean up its Stripe test customer.");
      }
    }
  }, 30_000);
});

describe.runIf(process.env.RUN_BILLING_DB_ACCEPTANCE === "1")("real development billing database gate", () => {
  it("passes the pgTAP event idempotency, ordering, audit and owner-isolation suite", () => {
    if (required("APP_ENV") !== "development") throw new Error("T073 database acceptance is development-only.");
    const projectRef = required("SUPABASE_PROJECT_REF");
    if (projectRef === process.env.SUPABASE_PRODUCTION_PROJECT_REF) throw new Error("T073 refuses the production Supabase project.");
    const result = spawnSync("pnpm", ["exec", "supabase", "db", "query", "--linked", "--project-ref", projectRef, "--file", "supabase/tests/billing.sql"], { cwd: root, encoding: "utf8", env: process.env });
    if (result.status !== 0) throw new Error(`T073 billing pgTAP failed:\n${result.stderr}`);
    expect(result.stdout).toContain("different invoice IDs are never merged by timestamp");
  }, 30_000);
});
