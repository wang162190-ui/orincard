import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadEntitlementPolicy } from "../../src/server/billing/policy";
import {
  createSupabaseEntitlementGrantStore,
  currentUsagePeriod,
  ensureEntitlementsForPeriod,
  grantsForPlan,
  type EntitlementGrantStore,
} from "../../src/server/billing/entitlement-grant";

function policy() {
  const entitlements = (monthlyGenerations: number) => ({
    maxPages: 5,
    monthlyGenerations,
    hdExport: false,
    pptxExport: false,
    mp4Export: false,
  });
  return loadEntitlementPolicy({
    appEnvironment: "test",
    policy: {
      version: "sandbox-2026-09",
      testOnly: true,
      plans: {
        free: { entitlements: entitlements(10), priceIds: {} },
        pro: { entitlements: entitlements(200), priceIds: { month: "price_test_pro_month" } },
        creator: { entitlements: entitlements(500), priceIds: { month: "price_test_creator_month" } },
      },
    },
  });
}

describe("usage period", () => {
  it("uses left-closed right-open UTC month bounds", () => {
    expect(currentUsagePeriod(new Date("2026-09-15T12:00:00Z"))).toEqual({
      periodStart: "2026-09-01T00:00:00.000Z",
      periodEnd: "2026-10-01T00:00:00.000Z",
    });
  });

  // 边界必须与 submit_job 的精确相等匹配对齐，所以不能依赖本地时区。
  it("stays on UTC at the edge of a local day", () => {
    expect(currentUsagePeriod(new Date("2026-01-31T23:30:00Z")).periodStart).toBe(
      "2026-01-01T00:00:00.000Z",
    );
  });

  // 这一条就是「按周期发放」而非「注册时发放一次」的理由：跨月必须换桶。
  it("rolls over into a new period next month", () => {
    const september = currentUsagePeriod(new Date("2026-09-30T23:59:59Z"));
    const october = currentUsagePeriod(new Date("2026-10-01T00:00:00Z"));
    expect(october.periodStart).not.toBe(september.periodStart);
    expect(october.periodStart).toBe(september.periodEnd);
  });
});

describe("grants for plan", () => {
  it("derives the generation bucket from the policy, not from a literal", () => {
    expect(grantsForPlan(policy(), "free")).toEqual([{ resource: "generation", granted: 10 }]);
    expect(grantsForPlan(policy(), "pro")).toEqual([{ resource: "generation", granted: 200 }]);
  });

  // 策略里没有 image 的字段，发多少是未定的商业决策，所以不发——这条守住「不要偷偷编一个数字」。
  it("does not invent an image quota the policy never defines", () => {
    expect(grantsForPlan(policy(), "free").map((grant) => grant.resource)).not.toContain("image");
  });
});

describe("ensureEntitlementsForPeriod", () => {
  it("grants each resource once for the current period", async () => {
    const store: EntitlementGrantStore = {
      planKey: vi.fn(async () => "pro" as const),
      grant: vi.fn(async () => {}),
    };
    const period = await ensureEntitlementsForPeriod({
      store,
      policy: policy(),
      ownerId: "11111111-1111-4111-8111-111111111111",
      at: new Date("2026-09-15T12:00:00Z"),
    });
    expect(period.periodStart).toBe("2026-09-01T00:00:00.000Z");
    expect(store.grant).toHaveBeenCalledOnce();
    expect(store.grant).toHaveBeenCalledWith({
      ownerId: "11111111-1111-4111-8111-111111111111",
      resource: "generation",
      period,
      granted: 200,
    });
  });
});

describe("supabase entitlement grant store", () => {
  function clientReturning(data: unknown): SupabaseClient {
    return {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: async () => ({ data, error: null }) }) }),
      }),
    } as unknown as SupabaseClient;
  }

  it("falls back to free when the user has no subscription row", async () => {
    await expect(createSupabaseEntitlementGrantStore(clientReturning(null)).planKey("x")).resolves.toBe("free");
  });

  // 方案只能由服务端持有的订阅决定；库里出现不认识的值时退回 free，而不是照单全收。
  it("refuses a plan key it does not recognise", async () => {
    await expect(
      createSupabaseEntitlementGrantStore(clientReturning({ plan_key: "enterprise" })).planKey("x"),
    ).resolves.toBe("free");
  });

  it("reads the plan key the server recorded", async () => {
    await expect(
      createSupabaseEntitlementGrantStore(clientReturning({ plan_key: "creator" })).planKey("x"),
    ).resolves.toBe("creator");
  });
});
