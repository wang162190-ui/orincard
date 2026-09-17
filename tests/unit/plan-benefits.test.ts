import { describe, expect, it } from "vitest";
import { readPlanBenefits } from "../../src/server/billing/plan-benefits";

const ENTITLEMENTS = { maxPages: 5, monthlyGenerations: 10, monthlyImages: 10, hdExport: false, pptxExport: false, mp4Export: false };

function environment(overrides: Record<string, string | undefined> = {}) {
  return {
    APP_ENV: "development",
    NEXT_PUBLIC_APP_URL: "http://localhost:3000",
    NEXT_PUBLIC_SUPABASE_URL: "https://development-ref.supabase.co",
    NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: ["sb", "publishable", "test-client-key"].join("_"),
    SUPABASE_SECRET_KEY: ["sb", "secret", "test-server-key"].join("_"),
    SUPABASE_PROJECT_REF: "development-ref",
    ...overrides,
  };
}

function policy(testOnly: boolean) {
  return JSON.stringify({
    version: "test-policy",
    testOnly,
    plans: {
      free: { entitlements: ENTITLEMENTS },
      pro: { entitlements: { ...ENTITLEMENTS, maxPages: 20, monthlyGenerations: 200, hdExport: true, pptxExport: true, mp4Export: true } },
      creator: { entitlements: { ...ENTITLEMENTS, maxPages: 50, monthlyGenerations: 500, hdExport: true, pptxExport: true, mp4Export: true } },
    },
  });
}

describe("readPlanBenefits", () => {
  it("publishes the free allowances because they are the ones being enforced today", () => {
    const benefits = readPlanBenefits(environment({ BILLING_POLICY_JSON: policy(true) }));
    expect(benefits.free).toEqual({ state: "published", entitlements: ENTITLEMENTS });
  });

  it("withholds paid allowances while the policy is still test-only", () => {
    const benefits = readPlanBenefits(environment({ BILLING_POLICY_JSON: policy(true) }));
    expect(benefits.pro).toEqual({ state: "unapproved" });
    expect(benefits.creator).toEqual({ state: "unapproved" });
  });

  it("publishes paid allowances once the policy is approved", () => {
    const benefits = readPlanBenefits(environment({ BILLING_POLICY_JSON: policy(false) }));
    expect(benefits.pro).toMatchObject({ state: "published", entitlements: { maxPages: 20, monthlyGenerations: 200 } });
  });

  it.each([
    ["the policy is missing", undefined],
    ["the policy is not valid JSON", "{"],
    ["the policy is structurally invalid", JSON.stringify({ version: "x", testOnly: false, plans: {} })],
  ])("reports every plan as unavailable when %s, instead of failing the page", (_label, value) => {
    const benefits = readPlanBenefits(environment({ BILLING_POLICY_JSON: value }));
    expect(benefits).toEqual({ free: { state: "unavailable" }, pro: { state: "unavailable" }, creator: { state: "unavailable" } });
  });

  it("does not fail the public pricing page when the environment itself is incomplete", () => {
    expect(readPlanBenefits({ BILLING_POLICY_JSON: policy(false) }).free).toEqual({ state: "unavailable" });
  });
});
