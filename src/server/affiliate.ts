import { createHash, randomUUID } from "node:crypto";

export type AffiliateApplication = {
  readonly id: string;
  readonly ownerId: string;
  readonly status: "pending" | "approved" | "rejected";
  readonly code: string | null;
};

export type AffiliateSummary = {
  readonly status: AffiliateApplication["status"] | "not_applied";
  readonly referralUrl: string | null;
  readonly clicks: number;
  readonly conversions: number;
  readonly grossCommissionCents: number;
  readonly refundedCommissionCents: number;
  readonly netCommissionCents: number;
};

export interface AffiliateStore {
  findApprovedByCode(code: string): Promise<AffiliateApplication | null>;
  createAttribution(input: {
    readonly affiliateId: string;
    readonly visitorHash: string;
    readonly expiresAt: string;
  }): Promise<void>;
}

export function referralUrl(application: AffiliateApplication, publicUrl: string): string | null {
  if (application.status !== "approved" || !application.code) return null;
  const url = new URL("/affiliate", publicUrl);
  url.searchParams.set("ref", application.code);
  return url.toString();
}

export function summarizeAffiliate(input: {
  readonly application: AffiliateApplication | null;
  readonly publicUrl: string;
  readonly clicks: number;
  readonly conversions: number;
  readonly ledger: readonly { readonly kind: "commission" | "refund"; readonly amountCents: number }[];
}): AffiliateSummary {
  const gross = input.ledger.filter((entry) => entry.kind === "commission").reduce((sum, entry) => sum + entry.amountCents, 0);
  const refunded = input.ledger.filter((entry) => entry.kind === "refund").reduce((sum, entry) => sum + entry.amountCents, 0);
  return {
    status: input.application?.status ?? "not_applied",
    referralUrl: input.application ? referralUrl(input.application, input.publicUrl) : null,
    clicks: input.clicks,
    conversions: input.conversions,
    grossCommissionCents: gross,
    refundedCommissionCents: refunded,
    netCommissionCents: gross - refunded,
  };
}

function response(body: unknown, status: number, headers?: HeadersInit) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store", ...headers } });
}

export function createAffiliateAttributeHandler(dependencies: {
  readonly store: AffiliateStore;
  readonly currentOwnerId: () => Promise<string | null>;
  readonly now?: () => Date;
  readonly visitorId?: () => string;
}) {
  return async (request: Request) => {
    let body: unknown;
    try { body = await request.json(); } catch { return response({ error: { code: "INVALID_REQUEST", message: "A valid JSON body is required." } }, 400); }
    const input = body as { code?: unknown; consent?: unknown };
    if (input.consent !== true) return new Response(null, { status: 204, headers: { "Cache-Control": "no-store" } });
    if (typeof input.code !== "string" || !/^[A-Za-z0-9_-]{4,64}$/.test(input.code)) {
      return response({ error: { code: "INVALID_REFERRAL", message: "The referral code is invalid." } }, 400);
    }
    const affiliate = await dependencies.store.findApprovedByCode(input.code);
    if (!affiliate || affiliate.status !== "approved" || !affiliate.code) {
      return response({ error: { code: "REFERRAL_UNAVAILABLE", message: "This referral is unavailable." } }, 404);
    }
    const ownerId = await dependencies.currentOwnerId();
    if (ownerId && ownerId === affiliate.ownerId) {
      return response({ error: { code: "SELF_REFERRAL", message: "You cannot attribute your own referral." } }, 409);
    }
    const visitorId = dependencies.visitorId?.() ?? randomUUID();
    const expiresAt = new Date((dependencies.now?.() ?? new Date()).getTime() + 30 * 24 * 60 * 60 * 1_000);
    await dependencies.store.createAttribution({
      affiliateId: affiliate.id,
      visitorHash: createHash("sha256").update(visitorId).digest("hex"),
      expiresAt: expiresAt.toISOString(),
    });
    const cookie = `orincard_affiliate=${encodeURIComponent(visitorId)}; Path=/; Max-Age=2592000; HttpOnly; Secure; SameSite=Lax`;
    return response({ data: { attributed: true, expiresAt: expiresAt.toISOString() } }, 201, { "Set-Cookie": cookie });
  };
}
