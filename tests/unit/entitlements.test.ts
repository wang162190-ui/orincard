import { describe, expect, it } from "vitest";
import { entitlementsForPlan } from "../../src/domain/entitlements";
import {
  loadEntitlementPolicy,
  priceIdForCheckout,
} from "../../src/server/billing/policy";

function policy(testOnly = true) {
  const entitlements = (maxPages: number, paid: boolean) => ({
    maxPages,
    monthlyGenerations: maxPages * 2,
    hdExport: paid,
    pptxExport: paid,
    mp4Export: paid,
  });
  return {
    version: "sandbox-2026-09",
    testOnly,
    plans: {
      free: { entitlements: entitlements(5, false), priceIds: {} },
      pro: {
        entitlements: entitlements(20, true),
        priceIds: { month: "price_test_pro_month", year: "price_test_pro_year" },
      },
      creator: {
        entitlements: entitlements(50, true),
        priceIds: { month: "price_test_creator_month", year: "price_test_creator_year" },
      },
    },
  };
}

describe("versioned entitlement policy", () => {
  it("derives entitlements only from the server-owned subscription plan", () => {
    const loaded = loadEntitlementPolicy({ appEnvironment: "test", policy: policy() });
    const clientRequest = { planKey: "creator", maxPages: 999 };

    expect(entitlementsForPlan(loaded, "free")).toEqual({
      maxPages: 5,
      monthlyGenerations: 10,
      hdExport: false,
      pptxExport: false,
      mp4Export: false,
    });
    expect(entitlementsForPlan(loaded, "free").maxPages).not.toBe(clientRequest.maxPages);
  });

  it("keeps policy versions attached to the loaded entitlement set", () => {
    const loaded = loadEntitlementPolicy({ appEnvironment: "preview", policy: policy() });
    expect(loaded.version).toBe("sandbox-2026-09");
  });

  it("rejects production activation when an approved policy is missing", () => {
    expect(() =>
      loadEntitlementPolicy({ appEnvironment: "production", policy: undefined }),
    ).toThrow("BILLING_NOT_CONFIGURED");
  });

  it("never loads test-only prices in production", () => {
    expect(() =>
      loadEntitlementPolicy({ appEnvironment: "production", policy: policy(true) }),
    ).toThrow("test-only pricing cannot be loaded in production");
  });

  it("allows an explicitly non-test policy in production", () => {
    const loaded = loadEntitlementPolicy({
      appEnvironment: "production",
      policy: policy(false),
    });
    expect(priceIdForCheckout(loaded, "pro", "month")).toBe("price_test_pro_month");
  });

  it("resolves checkout prices from the server policy instead of client input", () => {
    const loaded = loadEntitlementPolicy({ appEnvironment: "test", policy: policy() });
    expect(priceIdForCheckout(loaded, "creator", "year")).toBe(
      "price_test_creator_year",
    );
  });
});
