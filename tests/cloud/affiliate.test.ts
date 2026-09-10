import { describe, expect, it, vi } from "vitest";
import { createAffiliateAttributeHandler, referralUrl, summarizeAffiliate, type AffiliateStore } from "../../src/server/affiliate";

const approved = { id: "affiliate-1", ownerId: "owner-1", status: "approved" as const, code: "GOOD_CODE" };

function store(application = approved): AffiliateStore {
  return { findApprovedByCode: vi.fn(async () => application), createAttribution: vi.fn(async () => undefined) };
}

it("does not expose a referral link before approval", () => {
  expect(referralUrl({ ...approved, status: "pending", code: null }, "https://orincard.test")).toBeNull();
  expect(referralUrl(approved, "https://orincard.test")).toBe("https://orincard.test/affiliate?ref=GOOD_CODE");
});

describe("affiliate attribution", () => {
  it("does not persist or write a cookie without consent", async () => {
    const database = store();
    const response = await createAffiliateAttributeHandler({ store: database, currentOwnerId: async () => null })(new Request("https://orincard.test/api/v1/affiliate/attribute", { method: "POST", body: JSON.stringify({ code: "GOOD_CODE", consent: false }) }));
    expect(response.status).toBe(204);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(database.findApprovedByCode).not.toHaveBeenCalled();
  });

  it("rejects self referral", async () => {
    const database = store();
    const response = await createAffiliateAttributeHandler({ store: database, currentOwnerId: async () => "owner-1" })(new Request("https://orincard.test/api/v1/affiliate/attribute", { method: "POST", body: JSON.stringify({ code: "GOOD_CODE", consent: true }) }));
    expect(response.status).toBe(409);
    expect(database.createAttribution).not.toHaveBeenCalled();
  });

  it("stores an opaque hash and writes an httpOnly attribution cookie", async () => {
    const database = store();
    const response = await createAffiliateAttributeHandler({ store: database, currentOwnerId: async () => "buyer-2", visitorId: () => "opaque-visit", now: () => new Date("2026-09-10T00:00:00Z") })(new Request("https://orincard.test/api/v1/affiliate/attribute", { method: "POST", body: JSON.stringify({ code: "GOOD_CODE", consent: true }) }));
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(database.createAttribution).toHaveBeenCalledWith(expect.objectContaining({ affiliateId: "affiliate-1", visitorHash: expect.not.stringContaining("opaque-visit") }));
  });
});

it("reverses refunded commission and returns aggregates without purchaser data", () => {
  const summary = summarizeAffiliate({ application: approved, publicUrl: "https://orincard.test", clicks: 12, conversions: 2, ledger: [{ kind: "commission", amountCents: 800 }, { kind: "commission", amountCents: 500 }, { kind: "refund", amountCents: 500 }] });
  expect(summary).toMatchObject({ grossCommissionCents: 1300, refundedCommissionCents: 500, netCommissionCents: 800 });
  expect(JSON.stringify(summary)).not.toMatch(/buyer|email|customer/i);
});
