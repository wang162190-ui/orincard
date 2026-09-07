import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import {
  GenerationError,
  confirmRegenerationCandidate,
  createRegenerationCandidate,
  createSupabaseRegenerationStore,
  type GenerationOptions,
  type RegenerationStore,
} from "../../src/server/generation";

async function fixture(): Promise<CarouselDocument> {
  return JSON.parse(
    await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8"),
  ) as CarouselDocument;
}

const options: GenerationOptions = {
  language: "English",
  format: "educational",
  pageCount: 4,
  instructions: "Use a clearer narrative.",
  templateId: "paper",
  platform: "linkedin",
};

function store(overrides: Partial<RegenerationStore> = {}): RegenerationStore {
  return {
    begin: vi.fn().mockResolvedValue({
      outcome: "accepted",
      candidateJobId: "00000000-0000-4000-8000-000000000033",
    }),
    complete: vi.fn().mockResolvedValue(undefined),
    confirm: vi.fn(),
    ...overrides,
  };
}

describe("T033 regeneration candidate", () => {
  it("stores a candidate without mutating the original project document", async () => {
    const original = await fixture();
    const snapshot = structuredClone(original);
    const candidate = { ...original, title: "Candidate title" };
    const complete = vi.fn().mockResolvedValue(undefined);
    const generate = vi.fn().mockResolvedValue(candidate);

    const result = await createRegenerationCandidate({
      ownerId: "owner-1",
      projectId: "00000000-0000-4000-8000-000000000001",
      projectRevision: 3,
      document: original,
      options,
      confirmed: true,
      idempotencyKey: "regenerate-operation-1234",
      hashSecret: "test-only-regenerate-hmac-secret",
      generate,
      store: store({ complete }),
    });

    expect(original).toEqual(snapshot);
    expect(result).toEqual({
      candidateJobId: "00000000-0000-4000-8000-000000000033",
      projectId: "00000000-0000-4000-8000-000000000001",
      projectRevision: 3,
      document: candidate,
    });
    expect(complete).toHaveBeenCalledWith({ candidate: result });
  });

  it("replays the same candidate without generating or charging twice", async () => {
    const original = await fixture();
    const replay = {
      candidateJobId: "00000000-0000-4000-8000-000000000033",
      projectId: "00000000-0000-4000-8000-000000000001",
      projectRevision: 3,
      document: { ...original, title: "Candidate title" },
    };
    const generate = vi.fn();
    const result = await createRegenerationCandidate({
      ownerId: "owner-1",
      projectId: replay.projectId,
      projectRevision: 3,
      document: original,
      options,
      confirmed: true,
      idempotencyKey: "regenerate-operation-1234",
      hashSecret: "test-only-regenerate-hmac-secret",
      generate,
      store: store({ begin: vi.fn().mockResolvedValue({ outcome: "replay", candidate: replay }) }),
    });

    expect(result).toEqual(replay);
    expect(generate).not.toHaveBeenCalled();
  });

  it("requires confirmation before either replace or save-copy", async () => {
    await expect(confirmRegenerationCandidate({
      ownerId: "owner-1",
      projectId: "00000000-0000-4000-8000-000000000001",
      candidateJobId: "00000000-0000-4000-8000-000000000033",
      expectedRevision: 3,
      mode: "replace",
      confirmed: false,
      idempotencyKey: "confirm-regenerate-1234",
      hashSecret: "test-only-regenerate-hmac-secret",
      store: store(),
    })).rejects.toMatchObject({ code: "CONFIRMATION_REQUIRED", status: 400 });
  });

  it.each([
    ["replace", { projectId: "00000000-0000-4000-8000-000000000001", revision: 4 }],
    ["save_copy", { projectId: "00000000-0000-4000-8000-000000000099", revision: 1 }],
  ] as const)("confirms %s atomically and replays its receipt", async (mode, expected) => {
    const confirm = vi.fn().mockResolvedValue({ outcome: "confirmed", ...expected });
    const input = {
      ownerId: "owner-1",
      projectId: "00000000-0000-4000-8000-000000000001",
      candidateJobId: "00000000-0000-4000-8000-000000000033",
      expectedRevision: 3,
      mode,
      confirmed: true,
      idempotencyKey: `confirm-${mode}-1234`,
      hashSecret: "test-only-regenerate-hmac-secret",
      store: store({ confirm }),
    };

    await expect(confirmRegenerationCandidate(input)).resolves.toEqual(expected);
    await expect(confirmRegenerationCandidate(input)).resolves.toEqual(expected);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({
      mode,
      requestHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    }));
  });

  it("returns 409 on project conflicts and fails closed without the atomic RPC", async () => {
    const base = {
      ownerId: "owner-1",
      projectId: "00000000-0000-4000-8000-000000000001",
      candidateJobId: "00000000-0000-4000-8000-000000000033",
      expectedRevision: 3,
      mode: "replace" as const,
      confirmed: true,
      idempotencyKey: "confirm-regenerate-1234",
      hashSecret: "test-only-regenerate-hmac-secret",
    };
    await expect(confirmRegenerationCandidate({
      ...base,
      store: store({ confirm: vi.fn().mockResolvedValue({ outcome: "stale" }) }),
    })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });

    const rpc = vi.fn().mockResolvedValue({ data: null, error: { message: "missing" } });
    await expect(confirmRegenerationCandidate({
      ...base,
      store: createSupabaseRegenerationStore({ rpc }),
    })).rejects.toBeInstanceOf(GenerationError);
  });
});
