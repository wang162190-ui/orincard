import { describe, expect, it, vi } from "vitest";
import { createWaitlistHandler, parseWaitlistRequest } from "../../src/app/api/v1/waitlist/route";

const APP_URL = "http://localhost:3000";
const VALID = { email: "Reader@Example.com", source: "pricing", locale: "en" };

function post(body: unknown, origin: string | null = APP_URL) {
  return new Request(`${APP_URL}/api/v1/waitlist`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) },
    body: JSON.stringify(body),
  });
}

function harness(overrides: { readonly record?: () => Promise<void>; readonly currentUserId?: () => Promise<string | null> } = {}) {
  const recorded: unknown[] = [];
  const handler = createWaitlistHandler({
    appUrl: APP_URL,
    currentUserId: overrides.currentUserId ?? (async () => null),
    record: overrides.record ?? (async (entry) => { recorded.push(entry); }),
  });
  return { handler, recorded };
}

describe("parseWaitlistRequest", () => {
  it("lowercases the address so the unique constraint actually deduplicates", () => {
    expect(parseWaitlistRequest(VALID).email).toBe("reader@example.com");
  });

  it("accepts an optional paid plan key", () => {
    expect(parseWaitlistRequest({ ...VALID, planKey: "creator" }).planKey).toBe("creator");
  });

  it.each([
    ["a missing email", { source: "pricing", locale: "en" }],
    ["an address without a domain dot", { ...VALID, email: "reader@example" }],
    ["an unknown source", { ...VALID, source: "newsletter" }],
    ["an unsupported locale", { ...VALID, locale: "fr" }],
    // free 已经能用，登记它没有意义，出现就说明前端传错了。
    ["the free plan", { ...VALID, planKey: "free" }],
    ["an unexpected extra key", { ...VALID, utmCampaign: "launch" }],
    ["a non-object body", "reader@example.com"],
  ])("rejects %s", (_label, body) => {
    expect(() => parseWaitlistRequest(body)).toThrow("INVALID_REQUEST");
  });
});

describe("createWaitlistHandler", () => {
  it("records the signup and reports it was stored", async () => {
    const { handler, recorded } = harness();
    const response = await handler(post({ ...VALID, planKey: "pro" }));

    expect(response.status).toBe(201);
    await expect(response.json()).resolves.toMatchObject({ data: { recorded: true } });
    expect(recorded).toEqual([{ email: "reader@example.com", planKey: "pro", source: "pricing", locale: "en", ownerId: null }]);
  });

  it("associates a signed-in account without requiring one", async () => {
    const { handler, recorded } = harness({ currentUserId: async () => "11111111-1111-4111-8111-111111111111" });
    await handler(post(VALID));
    expect(recorded).toEqual([expect.objectContaining({ ownerId: "11111111-1111-4111-8111-111111111111" })]);
  });

  it("still records the signup when the session lookup fails", async () => {
    const { handler, recorded } = harness({ currentUserId: async () => { throw new Error("no session"); } });
    const response = await handler(post(VALID));
    expect(response.status).toBe(201);
    expect(recorded).toEqual([expect.objectContaining({ ownerId: null })]);
  });

  it("rejects a cross-origin submission before touching the store", async () => {
    const record = vi.fn(async () => {});
    const { handler } = harness({ record });
    const response = await handler(post(VALID, "https://attacker.example"));

    expect(response.status).toBe(400);
    expect(record).not.toHaveBeenCalled();
  });

  it("reports a storage failure as retryable instead of claiming success", async () => {
    const { handler } = harness({ record: async () => { throw new Error("WAITLIST_UNAVAILABLE"); } });
    const response = await handler(post(VALID));

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({ error: { code: "WAITLIST_UNAVAILABLE", retryable: true } });
  });
});
