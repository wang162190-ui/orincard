import { describe, expect, it, vi } from "vitest";
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
      now: () => NOW,
      createId: () => "22222222-2222-4222-8222-222222222222",
    });

    const source = await service.create(OWNER_ID, {
      kind: "topic",
      text: "  Build a calmer work week  ",
    });

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
    });
  });

  it("accepts the Text boundary and rejects empty or over-limit input before writes", async () => {
    const create = vi.fn().mockResolvedValue(
      record({ kind: "text", metadata: { characterCount: 30_000 } }),
    );
    const service = createTextSourceService({
      store: store({ create }),
      now: () => NOW,
    });

    await expect(
      service.create(OWNER_ID, { kind: "text", text: "x".repeat(30_000) }),
    ).resolves.toMatchObject({ id: SOURCE_ID, kind: "text" });
    await expect(
      service.create(OWNER_ID, { kind: "text", text: " \n\t " }),
    ).rejects.toMatchObject({ code: "EMPTY_SOURCE", status: 422 });
    await expect(
      service.create(OWNER_ID, { kind: "topic", text: "x".repeat(501) }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    await expect(
      service.create(OWNER_ID, { kind: "text", text: "x".repeat(30_001) }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });

    expect(create).toHaveBeenCalledTimes(1);
  });

  it("forbids anonymous persistence before the source store is called", async () => {
    const create = vi.fn();
    const service = createTextSourceService({ store: store({ create }) });

    await expect(
      service.create("", { kind: "topic", text: "Anonymous source" }),
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
    const query = {
      insert: vi.fn(),
      select: vi.fn(),
      single: vi.fn().mockResolvedValue({ data: row, error: null }),
    };
    query.insert.mockReturnValue(query);
    query.select.mockReturnValue(query);
    const client = { from: vi.fn().mockReturnValue(query) };

    const created = await createSupabaseSourceStore(client).create({
      ownerId: OWNER_ID,
      kind: "text",
      metadata: { characterCount: 12 },
      segments: [{ segmentId: "segment-1", text: "Source text." }],
      state: "ready",
      expiresAt: "2026-09-13T00:00:00.000Z",
    });

    expect(client.from).toHaveBeenCalledWith("sources");
    expect(query.insert).toHaveBeenCalledWith({
      owner_id: OWNER_ID,
      kind: "text",
      metadata: { characterCount: 12 },
      segments: [{ segmentId: "segment-1", text: "Source text." }],
      state: "ready",
      expires_at: "2026-09-13T00:00:00.000Z",
    });
    expect(query.select).toHaveBeenCalledWith(
      "id,owner_id,kind,metadata,segments,state,expires_at",
    );
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
});
