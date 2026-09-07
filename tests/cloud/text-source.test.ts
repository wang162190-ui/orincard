import { afterAll, describe, expect, it, vi } from "vitest";
import {
  SourceServiceError,
  createSupabaseSourceStore,
  createTextSourceService,
  type SourceRecord,
  type SourceStore,
} from "../../src/server/sources";

const OWNER_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";
const NOW = new Date("2026-09-06T00:00:00.000Z");
const REQUEST_HASH_SECRET = "test-source-request-hash-secret";
const OPERATION_KEY = "source-operation-1";

const route = vi.hoisted(() => {
  const state = {
    userId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" as string | null,
    insert: vi.fn(),
  };
  return { state };
});

vi.mock("next/headers", () => ({
  cookies: vi.fn().mockResolvedValue({
    getAll: vi.fn().mockReturnValue([]),
    set: vi.fn(),
  }),
}));

vi.mock("../../src/server/environment", () => ({
  readServerEnvironment: () => ({
    appUrl: "https://orincard.test",
    supabaseSecretKey: REQUEST_HASH_SECRET,
  }),
}));

vi.mock("../../src/server/supabase", () => ({
  createAdminSupabaseClient: () => ({
    rpc: async (_name: string, value: unknown) => {
      route.state.insert(value);
      return {
        data: {
          sourceId: SOURCE_ID,
          state: "ready",
          expiresAt: "2026-09-13T00:00:00.000Z",
        },
        error: null,
      };
    },
  }),
  createServerSupabaseClient: () => ({}),
  requireVerifiedUser: async () => {
    if (!route.state.userId) {
      throw new Error("Authentication required");
    }
    return { id: route.state.userId };
  },
}));

function record(overrides: Partial<SourceRecord> = {}): SourceRecord {
  return {
    id: SOURCE_ID,
    ownerId: OWNER_ID,
    kind: "topic",
    metadata: { characterCount: 25 },
    segments: [
      {
        segmentId: "22222222-2222-4222-8222-222222222222",
        text: "Build a calmer work week",
      },
    ],
    state: "ready",
    expiresAt: "2026-09-13T00:00:00.000Z",
    ...overrides,
  };
}

function store(overrides: Partial<SourceStore> = {}): SourceStore {
  return {
    create: vi.fn().mockResolvedValue(record()),
    ...overrides,
  };
}

describe("T027 Topic/Text source service", () => {
  it("validates a registered topic before persisting a seven-day source", async () => {
    const create = vi.fn().mockResolvedValue(record());
    const service = createTextSourceService({
      store: store({ create }),
      requestHashSecret: REQUEST_HASH_SECRET,
      now: () => NOW,
      createId: () => "22222222-2222-4222-8222-222222222222",
    });

    const source = await service.create(
      OWNER_ID,
      { kind: "topic", text: "  Build a calmer work week  " },
      OPERATION_KEY,
    );

    expect(source.id).toBe(SOURCE_ID);
    expect(source.state).toBe("ready");
    expect(create).toHaveBeenCalledWith({
      ownerId: OWNER_ID,
      kind: "topic",
      metadata: { characterCount: 24 },
      segments: [
        {
          segmentId: "22222222-2222-4222-8222-222222222222",
          text: "Build a calmer work week",
        },
      ],
      state: "ready",
      expiresAt: "2026-09-13T00:00:00.000Z",
      idempotencyKey: OPERATION_KEY,
      requestHash: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("accepts the Text boundary and rejects empty or over-limit input before writes", async () => {
    const create = vi.fn().mockResolvedValue(
      record({ kind: "text", metadata: { characterCount: 30_000 } }),
    );
    const service = createTextSourceService({
      store: store({ create }),
      requestHashSecret: REQUEST_HASH_SECRET,
      now: () => NOW,
    });

    await expect(
      service.create(OWNER_ID, { kind: "text", text: "x".repeat(30_000) }, "source-operation-30000"),
    ).resolves.toMatchObject({ id: SOURCE_ID, kind: "text" });
    await expect(
      service.create(OWNER_ID, { kind: "text", text: " \n\t " }, "source-operation-empty"),
    ).rejects.toMatchObject({ code: "EMPTY_SOURCE", status: 422 });
    await expect(
      service.create(OWNER_ID, { kind: "topic", text: "x".repeat(501) }, "source-operation-topic-limit"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    await expect(
      service.create(OWNER_ID, { kind: "text", text: "x".repeat(30_001) }, "source-operation-text-limit"),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("forbids anonymous persistence before the source store is called", async () => {
    const create = vi.fn();
    const service = createTextSourceService({
      store: store({ create }),
      requestHashSecret: REQUEST_HASH_SECRET,
    });

    await expect(
      service.create("", { kind: "topic", text: "Anonymous source" }, OPERATION_KEY),
    ).rejects.toEqual(
      new SourceServiceError(
        "AUTH_REQUIRED",
        "Sign in before saving a source.",
        401,
      ),
    );
    expect(create).not.toHaveBeenCalled();
  });

  it("persists only the validated owner-bound source shape through Supabase", async () => {
    const row = {
      id: SOURCE_ID,
      owner_id: OWNER_ID,
      kind: "text",
      metadata: { characterCount: 12 },
      segments: [{ segmentId: "segment-1", text: "Source text." }],
      state: "ready",
      expires_at: "2026-09-13T00:00:00.000Z",
    };
    const rpc = vi.fn().mockResolvedValue({ data: row, error: null });
    const client = { rpc };

    const created = await createSupabaseSourceStore(client).create({
      ownerId: OWNER_ID,
      kind: "text",
      metadata: { characterCount: 12 },
      segments: [{ segmentId: "segment-1", text: "Source text." }],
      state: "ready",
      expiresAt: "2026-09-13T00:00:00.000Z",
      idempotencyKey: OPERATION_KEY,
      requestHash: "a".repeat(64),
    });

    expect(rpc).toHaveBeenCalledWith("server_create_text_source", expect.any(Object));
    expect(created).toEqual({
      id: SOURCE_ID,
      ownerId: OWNER_ID,
      kind: "text",
      metadata: { characterCount: 12 },
      segments: [{ segmentId: "segment-1", text: "Source text." }],
      state: "ready",
      expiresAt: "2026-09-13T00:00:00.000Z",
    });
  });

  it("uses one atomic idempotent RPC instead of a direct source insert", async () => {
    const row = {
      id: SOURCE_ID,
      owner_id: OWNER_ID,
      kind: "text",
      metadata: { characterCount: 12 },
      segments: [{ segmentId: "segment-1", text: "Source text." }],
      state: "ready",
      expires_at: "2026-09-13T00:00:00.000Z",
    };
    const rpc = vi.fn().mockResolvedValue({ data: row, error: null });
    const client = { rpc };

    const created = await createSupabaseSourceStore(client as never).create({
      ownerId: OWNER_ID,
      kind: "text",
      metadata: { characterCount: 12 },
      segments: [{ segmentId: "segment-1", text: "Source text." }],
      state: "ready",
      expiresAt: "2026-09-13T00:00:00.000Z",
      idempotencyKey: "source-operation-1",
      requestHash: "a".repeat(64),
    } as never);

    expect(rpc).toHaveBeenCalledWith("server_create_text_source", {
      p_owner_id: OWNER_ID,
      p_kind: "text",
      p_metadata: { characterCount: 12 },
      p_segments: [{ segmentId: "segment-1", text: "Source text." }],
      p_expires_at: "2026-09-13T00:00:00.000Z",
      p_idempotency_key: "source-operation-1",
      p_request_hash: "a".repeat(64),
    });
    expect(created.id).toBe(SOURCE_ID);
  });
});

describe("T027 POST /api/v1/sources", () => {
  afterAll(() => {
    route.state.userId = OWNER_ID;
  });

  it("returns the API envelope and a sourceId for an authenticated write", async () => {
    route.state.userId = OWNER_ID;
    route.state.insert.mockClear();
    const { POST } = await import("../../src/app/api/v1/sources/route");

    const response = await POST(
      new Request("https://orincard.test/api/v1/sources", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://orincard.test",
          "idempotency-key": OPERATION_KEY,
        },
        body: JSON.stringify({ kind: "topic", text: "Source topic" }),
      }),
    );
    const payload = (await response.json()) as {
      readonly data: { readonly sourceId: string; readonly expiresAt: string };
      readonly requestId: string;
    };

    expect(response.status).toBe(201);
    expect(payload.data.sourceId).toBe(SOURCE_ID);
    expect(payload.data.expiresAt).toBe("2026-09-13T00:00:00.000Z");
    expect(payload.requestId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(route.state.insert).toHaveBeenCalledTimes(1);
  });

  it("rejects a write without an Idempotency-Key before persistence", async () => {
    route.state.userId = OWNER_ID;
    route.state.insert.mockClear();
    const { POST } = await import("../../src/app/api/v1/sources/route");

    const response = await POST(
      new Request("https://orincard.test/api/v1/sources", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://orincard.test",
        },
        body: JSON.stringify({ kind: "topic", text: "Source topic" }),
      }),
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "INVALID_REQUEST", retryable: false },
    });
    expect(route.state.insert).not.toHaveBeenCalled();
  });

  it("returns AUTH_REQUIRED and performs no source write for an anonymous request", async () => {
    route.state.userId = null;
    route.state.insert.mockClear();
    const { POST } = await import("../../src/app/api/v1/sources/route");

    const response = await POST(
      new Request("https://orincard.test/api/v1/sources", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://orincard.test",
          "idempotency-key": OPERATION_KEY,
        },
        body: JSON.stringify({ kind: "text", text: "Do not persist this" }),
      }),
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "AUTH_REQUIRED", retryable: false },
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/i),
    });
    expect(route.state.insert).not.toHaveBeenCalled();
  });

  it("returns EMPTY_SOURCE and performs no source write for invalid content", async () => {
    route.state.userId = OWNER_ID;
    route.state.insert.mockClear();
    const { POST } = await import("../../src/app/api/v1/sources/route");

    const response = await POST(
      new Request("https://orincard.test/api/v1/sources", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "https://orincard.test",
          "idempotency-key": OPERATION_KEY,
        },
        body: JSON.stringify({ kind: "text", text: "   " }),
      }),
    );

    expect(response.status).toBe(422);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "EMPTY_SOURCE", retryable: false },
    });
    expect(route.state.insert).not.toHaveBeenCalled();
  });
});

const cloud =
  process.env.ORINCARD_RUN_TEXT_SOURCE_CLOUD === "1" ? describe : describe.skip;

cloud("T027 real development Supabase source", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterAll(async () => {
    await cleanup?.();
  });

  it("writes a seven-day owner source that is readable by its authenticated owner", async () => {
    const required = (name: string) => {
      const value = process.env[name]?.trim();
      if (!value) {
        throw new Error(
          `ORINCARD_RUN_TEXT_SOURCE_CLOUD=1 requires development variable ${name}`,
        );
      }
      return value;
    };
    const { createClient } = await import("@supabase/supabase-js");
    const url = required("NEXT_PUBLIC_SUPABASE_URL");
    const publishableKey = required("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
    const secretKey = required("SUPABASE_SECRET_KEY");
    const email = required("ORINCARD_AUTH_TEST_EMAIL");
    const password = required("ORINCARD_AUTH_TEST_PASSWORD");
    const userClient = createClient(url, publishableKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const adminClient = createClient(url, secretKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });
    const login = await userClient.auth.signInWithPassword({ email, password });
    expect(login.error).toBeNull();
    const ownerId = login.data.user?.id;
    expect(ownerId).toBeTruthy();

    const source = await createTextSourceService({
      store: createSupabaseSourceStore(adminClient),
      requestHashSecret: secretKey,
    }).create(
      ownerId!,
      { kind: "topic", text: `Synthetic source ${crypto.randomUUID()}` },
      `cloud-source-${crypto.randomUUID()}`,
    );
    cleanup = async () => {
      await adminClient.from("sources").delete().eq("id", source.id);
      await userClient.auth.signOut({ scope: "local" });
    };

    const read = await userClient
      .from("sources")
      .select("id,owner_id,kind,state,expires_at")
      .eq("id", source.id)
      .single();
    expect(read.error).toBeNull();
    expect(read.data).toMatchObject({
      id: source.id,
      owner_id: ownerId,
      kind: "topic",
      state: "ready",
    });
    const ttl = new Date(read.data!.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(6.99 * 24 * 60 * 60 * 1_000);
    expect(ttl).toBeLessThanOrEqual(7 * 24 * 60 * 60 * 1_000);
  });
});
