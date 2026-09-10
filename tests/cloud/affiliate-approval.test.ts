import { describe, expect, it, vi } from "vitest";
import { createAffiliateApplyHandler, type AffiliateApplicationStore } from "../../src/app/api/v1/affiliate/apply/route";
import { createAffiliateDashboardHandler } from "../../src/app/api/v1/affiliate/dashboard/route";
// @ts-expect-error The production review command is intentionally a directly executable ESM script.
import { reviewAffiliateApplication } from "../../scripts/affiliate-review.mjs";

describe("affiliate application API", () => {
  it("creates only a pending application and cannot accept client approval fields", async () => {
    const store: AffiliateApplicationStore = { find: vi.fn(async () => null), create: vi.fn(async () => ({ id: "app-1", status: "pending" as const })) };
    const response = await createAffiliateApplyHandler({ authenticate: async () => "owner-1", store })(new Request("https://orincard.test/api", { method: "POST", body: JSON.stringify({ channel: "Newsletter", audience: "Designers", status: "approved", code: "MINE" }) }));
    expect(response.status).toBe(201);
    expect(store.create).toHaveBeenCalledWith({ ownerId: "owner-1", channel: "Newsletter", audience: "Designers" });
    expect(await response.json()).toEqual({ data: { id: "app-1", status: "pending" } });
  });
});

it("returns owner aggregates without purchaser records", async () => {
  const response = await createAffiliateDashboardHandler({ authenticate: async () => "owner-1", publicUrl: "https://orincard.test", store: { summary: async () => ({ application: { id: "app-1", ownerId: "owner-1", status: "approved", code: "OKAY" }, clicks: 4, conversions: 1, ledger: [{ kind: "commission", amountCents: 900 }, { kind: "refund", amountCents: 200 }] }) } })();
  const body = await response.json();
  expect(body.data).toMatchObject({ clicks: 4, conversions: 1, netCommissionCents: 700 });
  expect(JSON.stringify(body)).not.toMatch(/buyer|customer|email/i);
});

describe("controlled affiliate review", () => {
  const environment = { APP_ENV: "preview", AFFILIATE_REVIEW_TOKEN: "review-secret", AFFILIATE_REVIEW_ACTOR: "ops@example.test", NEXT_PUBLIC_SUPABASE_URL: "https://db.test", SUPABASE_SECRET_KEY: "service-secret" };
  const argv = ["--application", "app-1", "--decision", "approved", "--environment", "preview", "--confirm", "REVIEW:preview", "--authorization", "review-secret"];

  it("requires exact environment confirmation and authorization", async () => {
    const wrongEnvironment = [...argv]; wrongEnvironment[7] = "REVIEW:production";
    const wrongAuthorization = [...argv]; wrongAuthorization[9] = "wrong";
    await expect(reviewAffiliateApplication({ argv: wrongEnvironment, environment, fetchImpl: vi.fn() })).rejects.toThrow("Environment confirmation");
    await expect(reviewAffiliateApplication({ argv: wrongAuthorization, environment, fetchImpl: vi.fn() })).rejects.toThrow("authorization failed");
  });

  it("uses the atomic audited review RPC", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ id: "audit-1" }), { status: 200 }));
    await reviewAffiliateApplication({ argv, environment, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledWith("https://db.test/rest/v1/rpc/review_affiliate_application", expect.objectContaining({ method: "POST", body: expect.stringContaining('"p_actor":"ops@example.test"') }));
  });
});
