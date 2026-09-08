import { describe, expect, it, vi } from "vitest";
import { AiAssetError, createAiCandidateService, generatedMetadata, type AiCandidateStore } from "../../src/server/assets/ai-image";
import { validateImageGenerationPayload } from "../../src/trigger/generate-image";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REFERENCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CANDIDATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function store(overrides: Partial<AiCandidateStore> = {}): AiCandidateStore {
  return {
    findReference: vi.fn().mockResolvedValue({ id: REFERENCE, bucket: "assets", objectKey: `${OWNER}/${REFERENCE}/photo.png`, mime: "image/png" }),
    reserve: vi.fn().mockResolvedValue("reserved"),
    release: vi.fn().mockResolvedValue(undefined),
    create: vi.fn().mockResolvedValue({ id: CANDIDATE }),
    ...overrides,
  };
}

describe("T047 AI candidate assets", () => {
  it("stores a portrait as an unaccepted private candidate only after owner-scoped reference and budget checks", async () => {
    const backing = store();
    const service = createAiCandidateService({ store: backing, createId: () => CANDIDATE, now: () => new Date("2026-09-09T00:00:00.000Z") });
    await expect(service.submit(OWNER, { kind: "portrait", prompt: "A warm editorial headshot", referenceAssetId: REFERENCE })).resolves.toEqual({ assetId: CANDIDATE, state: "pending_upload" });
    expect(backing.findReference).toHaveBeenCalledWith(OWNER, REFERENCE);
    expect(backing.reserve).toHaveBeenCalledWith(OWNER);
    expect(backing.create).toHaveBeenCalledWith(expect.objectContaining({ id: CANDIDATE, owner_id: OWNER, kind: "portrait", bucket: "assets", state: "pending_upload", rights: expect.objectContaining({ candidate: true, userAcceptedRequired: true, referenceAssetId: REFERENCE }) }));
    expect(JSON.stringify((backing.create as ReturnType<typeof vi.fn>).mock.calls[0][0])).not.toContain("object_key\":\"https");
  });

  it("rejects an absent or foreign reference before reserving quota, and never accepts references for general images", async () => {
    const missing = store({ findReference: vi.fn().mockResolvedValue(null) });
    await expect(createAiCandidateService({ store: missing }).submit(OWNER, { kind: "portrait", prompt: "portrait", referenceAssetId: REFERENCE })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(missing.reserve).not.toHaveBeenCalled();
    await expect(createAiCandidateService({ store: store() }).submit(OWNER, { kind: "ai_image", prompt: "illustration", referenceAssetId: REFERENCE })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it.each([["quota_exceeded", "QUOTA_EXCEEDED"], ["budget_exceeded", "BUDGET_EXCEEDED"]] as const)("does not write a candidate when %s", async (outcome, code) => {
    const backing = store({ reserve: vi.fn().mockResolvedValue(outcome), create: vi.fn() });
    await expect(createAiCandidateService({ store: backing }).submit(OWNER, { kind: "ai_image", prompt: "A paper collage" })).rejects.toMatchObject({ code });
    expect(backing.create).not.toHaveBeenCalled();
  });

  it("releases an injected reservation if candidate persistence fails", async () => {
    const backing = store({ create: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(createAiCandidateService({ store: backing }).submit(OWNER, { kind: "ai_image", prompt: "A paper collage" })).rejects.toThrow("db down");
    expect(backing.release).toHaveBeenCalledWith(OWNER);
  });

  it("rejects non-PNG provider data before it can become ready", () => {
    expect(() => generatedMetadata(new Uint8Array(24))).toThrow(AiAssetError);
  });

  it("keeps Trigger payloads reference-only", () => {
    expect(validateImageGenerationPayload({ assetId: CANDIDATE, schemaVersion: 1 })).toEqual({ assetId: CANDIDATE, schemaVersion: 1 });
    expect(() => validateImageGenerationPayload({ assetId: CANDIDATE, schemaVersion: 1, prompt: "never send user prompts through Trigger" })).toThrow("Invalid image generation payload");
  });
});
