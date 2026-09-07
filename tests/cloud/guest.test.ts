import { describe, expect, it, vi } from "vitest";
import {
  GuestGenerationError,
  createGuestGenerationService,
  createSupabaseGuestGuardStore,
  type GuestGuardStore,
} from "../../src/server/guest-guards";
import { resolveGuestNetworkSubject } from "../../src/app/api/v1/guest/generate/route";

const body = {
  kind: "topic" as const,
  text: "Build a calmer work week",
  language: "English",
  format: "educational",
  pageCount: 4,
  instructions: "Use concise, practical language.",
  templateId: "paper" as const,
  platform: "linkedin" as const,
  sessionNonce: "browser-session-nonce-1234",
};

function guardStore(overrides: Partial<GuestGuardStore> = {}): GuestGuardStore {
  return {
    begin: vi.fn().mockResolvedValue({
      outcome: "accepted",
      guardId: "00000000-0000-4000-8000-000000000030",
    }),
    finish: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("T030 guest generation guard", () => {
  it("uses a local-only subject for browser acceptance without weakening hosted environments", () => {
    const localRequest = new Request("http://127.0.0.1:3000/api/v1/guest/generate");
    expect(resolveGuestNetworkSubject(localRequest, "development")).toBe("local-development");
    expect(resolveGuestNetworkSubject(localRequest, "preview")).toBe("");
    expect(resolveGuestNetworkSubject(localRequest, "production")).toBe("");
    expect(resolveGuestNetworkSubject(new Request(localRequest.url, {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1" },
    }), "development")).toBe("203.0.113.9");
  });

  it("persists only HMAC metadata and returns the generated document once", async () => {
    const begin = vi.fn().mockResolvedValue({
      outcome: "accepted",
      guardId: "00000000-0000-4000-8000-000000000030",
    });
    const finish = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue({ schemaVersion: 1, title: "Draft" });
    const service = createGuestGenerationService({
      store: guardStore({ begin, finish }),
      generate,
      hashSecret: "test-only-guest-hmac-secret",
      now: () => new Date("2026-09-06T12:00:00.000Z"),
    });

    const result = await service.generate(body, {
      operationKey: "guest-operation-1234",
      networkSubject: "203.0.113.9",
    });

    expect(result).toEqual({ schemaVersion: 1, title: "Draft" });
    expect(begin).toHaveBeenCalledWith({
      subjectHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      operationKey: "guest-operation-1234",
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
      windowStart: "2026-09-06T12:00:00.000Z",
      expiresAt: "2026-09-07T12:00:00.000Z",
      environment: "development",
      period: "2026-09",
      reservedMicroUsd: 2_000,
      rateLimit: 3,
    });
    expect(JSON.stringify(begin.mock.calls)).not.toContain(body.text);
    expect(JSON.stringify(begin.mock.calls)).not.toContain(body.sessionNonce);
    expect(finish).toHaveBeenCalledWith({
      guardId: "00000000-0000-4000-8000-000000000030",
      outcome: "succeeded",
    });
  });

  it("uses a stable hourly rate window instead of one timestamp per request", async () => {
    const begin = vi.fn().mockResolvedValue({
      outcome: "accepted",
      guardId: "00000000-0000-4000-8000-000000000030",
    });
    const service = createGuestGenerationService({
      store: guardStore({ begin }),
      generate: vi.fn().mockResolvedValue({ schemaVersion: 1, title: "Draft" }),
      hashSecret: "test-only-guest-hmac-secret",
      now: () => new Date("2026-09-06T12:34:56.789Z"),
    });

    await service.generate(body, {
      operationKey: "guest-operation-window",
      networkSubject: "203.0.113.9",
    });

    expect(begin).toHaveBeenCalledWith(
      expect.objectContaining({ windowStart: "2026-09-06T12:00:00.000Z" }),
    );
  });

  it("returns 410 for a completed idempotency key without calling AI again", async () => {
    const generate = vi.fn();
    const service = createGuestGenerationService({
      store: guardStore({
        begin: vi.fn().mockResolvedValue({ outcome: "result_not_retained" }),
      }),
      generate,
      hashSecret: "test-only-guest-hmac-secret",
    });

    await expect(
      service.generate(body, {
        operationKey: "guest-operation-1234",
        networkSubject: "203.0.113.9",
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        code: "RESULT_NOT_RETAINED",
        status: 410,
        retryable: false,
      }),
    );
    expect(generate).not.toHaveBeenCalled();
  });

  it.each([
    ["idempotency_conflict", "IDEMPOTENCY_CONFLICT", 409],
    ["rate_limited", "RATE_LIMITED", 429],
    ["budget_exceeded", "BUDGET_EXCEEDED", 429],
  ] as const)("maps %s without invoking AI", async (outcome, code, status) => {
    const generate = vi.fn();
    const service = createGuestGenerationService({
      store: guardStore({ begin: vi.fn().mockResolvedValue({ outcome }) }),
      generate,
      hashSecret: "test-only-guest-hmac-secret",
    });

    await expect(
      service.generate(body, {
        operationKey: "guest-operation-1234",
        networkSubject: "203.0.113.9",
      }),
    ).rejects.toEqual(expect.objectContaining({ code, status }));
    expect(generate).not.toHaveBeenCalled();
  });

  it("marks provider failures without retaining source or result content", async () => {
    const finish = vi.fn().mockResolvedValue(undefined);
    const service = createGuestGenerationService({
      store: guardStore({ finish }),
      generate: vi.fn().mockRejectedValue(new Error("provider failed")),
      hashSecret: "test-only-guest-hmac-secret",
    });

    await expect(
      service.generate(body, {
        operationKey: "guest-operation-1234",
        networkSubject: "203.0.113.9",
      }),
    ).rejects.toBeInstanceOf(GuestGenerationError);
    expect(finish).toHaveBeenCalledWith({
      guardId: "00000000-0000-4000-8000-000000000030",
      outcome: "failed",
    });
    expect(JSON.stringify(finish.mock.calls)).not.toContain(body.text);
  });

  it("uses the approved private RPC boundary and fails closed when it is absent", async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "function does not exist" },
    });
    const store = createSupabaseGuestGuardStore({ rpc });

    await expect(
      store.begin({
        subjectHash: "a".repeat(64),
        operationKey: "guest-operation-1234",
        requestHash: "b".repeat(64),
        windowStart: "2026-09-06T12:00:00.000Z",
        expiresAt: "2026-09-07T12:00:00.000Z",
        environment: "development",
        period: "2026-09",
        reservedMicroUsd: 2_000,
        rateLimit: 3,
      }),
    ).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE", status: 503 });
  });
});
