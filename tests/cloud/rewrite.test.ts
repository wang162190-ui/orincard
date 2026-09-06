import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import {
  RewriteError,
  applyRewriteProposal,
  createRewriteProposal,
  createSupabaseRewriteStore,
  type RewriteStore,
} from "../../src/server/rewrite";

async function fixture(): Promise<CarouselDocument> {
  return JSON.parse(
    await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8"),
  ) as CarouselDocument;
}

function store(overrides: Partial<RewriteStore> = {}): RewriteStore {
  return {
    begin: vi.fn().mockResolvedValue({
      outcome: "accepted",
      proposalJobId: "00000000-0000-4000-8000-000000000032",
    }),
    complete: vi.fn().mockResolvedValue(undefined),
    apply: vi.fn(),
    ...overrides,
  };
}

describe("T032 local rewrite proposal", () => {
  it("creates a before/after proposal for only the selected field", async () => {
    const document = await fixture();
    const slide = document.slides[1];
    const begin = vi.fn().mockResolvedValue({
      outcome: "accepted",
      proposalJobId: "00000000-0000-4000-8000-000000000032",
    });
    const complete = vi.fn().mockResolvedValue(undefined);
    const generateStructured = vi.fn().mockResolvedValue({ text: "A shorter title" });

    const proposal = await createRewriteProposal({
      ownerId: "owner-1",
      projectId: "00000000-0000-4000-8000-000000000001",
      projectRevision: 3,
      document,
      slideId: slide.id,
      field: "title",
      baseSlideRevision: slide.revision,
      action: "shorten",
      instruction: "",
      idempotencyKey: "rewrite-operation-1234",
      hashSecret: "test-only-rewrite-hmac-secret",
      ai: { generateStructured },
      store: store({ begin, complete }),
    });

    expect(proposal).toEqual({
      proposalJobId: "00000000-0000-4000-8000-000000000032",
      projectId: "00000000-0000-4000-8000-000000000001",
      projectRevision: 3,
      slideId: slide.id,
      baseSlideRevision: slide.revision,
      field: "title",
      before: slide.title,
      after: "A shorter title",
    });
    expect(begin).toHaveBeenCalledWith(expect.objectContaining({
      inputRef: {
        projectRevision: 3,
        slideId: slide.id,
        baseSlideRevision: slide.revision,
        field: "title",
        action: "shorten",
      },
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
    expect(JSON.stringify(begin.mock.calls)).not.toContain(slide.title);
    expect(complete).toHaveBeenCalledWith({ proposal });
  });

  it("replays an existing proposal without invoking or charging AI twice", async () => {
    const document = await fixture();
    const slide = document.slides[1];
    const replay = {
      proposalJobId: "00000000-0000-4000-8000-000000000032",
      projectId: "00000000-0000-4000-8000-000000000001",
      projectRevision: 3,
      slideId: slide.id,
      baseSlideRevision: slide.revision,
      field: "title" as const,
      before: slide.title ?? "",
      after: "A shorter title",
    };
    const generateStructured = vi.fn();

    const result = await createRewriteProposal({
      ownerId: "owner-1",
      projectId: replay.projectId,
      projectRevision: 3,
      document,
      slideId: slide.id,
      field: "title",
      baseSlideRevision: slide.revision,
      action: "shorten",
      instruction: "",
      idempotencyKey: "rewrite-operation-1234",
      hashSecret: "test-only-rewrite-hmac-secret",
      ai: { generateStructured },
      store: store({ begin: vi.fn().mockResolvedValue({ outcome: "replay", proposal: replay }) }),
    });

    expect(result).toEqual(replay);
    expect(generateStructured).not.toHaveBeenCalled();
  });

  it("rejects stale slide revisions before creating a proposal", async () => {
    const document = await fixture();
    const begin = vi.fn();

    await expect(createRewriteProposal({
      ownerId: "owner-1",
      projectId: "00000000-0000-4000-8000-000000000001",
      projectRevision: 3,
      document,
      slideId: document.slides[1].id,
      field: "title",
      baseSlideRevision: document.slides[1].revision + 1,
      action: "shorten",
      instruction: "",
      idempotencyKey: "rewrite-operation-1234",
      hashSecret: "test-only-rewrite-hmac-secret",
      ai: { generateStructured: vi.fn() },
      store: store({ begin }),
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    expect(begin).not.toHaveBeenCalled();
  });

  it("applies only the target field and maps stale proposals to 409", async () => {
    const document = await fixture();
    const slide = document.slides[1];
    const apply = vi.fn().mockResolvedValue({
      outcome: "applied",
      projectId: "00000000-0000-4000-8000-000000000001",
      revision: 4,
    });

    const result = await applyRewriteProposal({
      ownerId: "owner-1",
      projectId: "00000000-0000-4000-8000-000000000001",
      proposalJobId: "00000000-0000-4000-8000-000000000032",
      expectedRevision: 3,
      baseSlideRevision: slide.revision,
      idempotencyKey: "apply-proposal-1234",
      hashSecret: "test-only-rewrite-hmac-secret",
      store: store({ apply }),
    });

    expect(result).toEqual({ projectId: expect.any(String), revision: 4 });
    expect(apply).toHaveBeenCalledWith(expect.objectContaining({
      expectedRevision: 3,
      baseSlideRevision: slide.revision,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));

    await expect(applyRewriteProposal({
      ownerId: "owner-1",
      projectId: "00000000-0000-4000-8000-000000000001",
      proposalJobId: "00000000-0000-4000-8000-000000000032",
      expectedRevision: 3,
      baseSlideRevision: slide.revision,
      idempotencyKey: "apply-proposal-5678",
      hashSecret: "test-only-rewrite-hmac-secret",
      store: store({ apply: vi.fn().mockResolvedValue({ outcome: "stale" }) }),
    })).rejects.toEqual(expect.objectContaining({ code: "VERSION_CONFLICT", status: 409 }));
  });

  it("fails closed when the required atomic proposal RPC is absent", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "missing" } });
    const supabaseStore = createSupabaseRewriteStore({ rpc });
    await expect(supabaseStore.apply({
      ownerId: "owner-1",
      projectId: "00000000-0000-4000-8000-000000000001",
      proposalJobId: "00000000-0000-4000-8000-000000000032",
      expectedRevision: 3,
      baseSlideRevision: 1,
      idempotencyKey: "apply-proposal-1234",
      requestHash: "a".repeat(64),
    })).rejects.toBeInstanceOf(RewriteError);
  });
});
