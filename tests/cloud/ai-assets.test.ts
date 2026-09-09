import { describe, expect, it, vi } from "vitest";
import { AiAssetError, createAiCandidateService, createApiMartImageProvider, generatedMetadata, type AiCandidateStore } from "../../src/server/assets/ai-image";
import { validateImageGenerationPayload } from "../../src/trigger/generate-image";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const REFERENCE = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const CANDIDATE = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function store(overrides: Partial<AiCandidateStore> = {}): AiCandidateStore {
  return {
    findReference: vi.fn().mockResolvedValue({ id: REFERENCE, bucket: "assets", objectKey: `${OWNER}/${REFERENCE}/photo.png`, mime: "image/png" }),
    createCandidate: vi.fn().mockResolvedValue("created"),
    ...overrides,
  };
}

describe("T047 AI candidate assets", () => {
  it("stores a portrait as an unaccepted private candidate only after owner-scoped reference and budget checks", async () => {
    const backing = store();
    const service = createAiCandidateService({ store: backing, createId: () => CANDIDATE, now: () => new Date("2026-09-09T00:00:00.000Z") });
    await expect(service.submit(OWNER, { kind: "portrait", prompt: "A warm editorial headshot", referenceAssetId: REFERENCE })).resolves.toEqual({ assetId: CANDIDATE, state: "pending_upload" });
    expect(backing.findReference).toHaveBeenCalledWith(OWNER, REFERENCE);
    expect(backing.createCandidate).toHaveBeenCalledWith(expect.objectContaining({ assetId: CANDIDATE, ownerId: OWNER, kind: "portrait", rights: expect.objectContaining({ candidate: true, userAcceptedRequired: true, referenceAssetId: REFERENCE }) }));
    expect(JSON.stringify((backing.createCandidate as ReturnType<typeof vi.fn>).mock.calls[0][0])).not.toContain("objectKey\":\"https");
  });

  it("rejects an absent or foreign reference before reserving quota, and never accepts references for general images", async () => {
    const missing = store({ findReference: vi.fn().mockResolvedValue(null) });
    await expect(createAiCandidateService({ store: missing }).submit(OWNER, { kind: "portrait", prompt: "portrait", referenceAssetId: REFERENCE })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(missing.createCandidate).not.toHaveBeenCalled();
    await expect(createAiCandidateService({ store: store() }).submit(OWNER, { kind: "ai_image", prompt: "illustration", referenceAssetId: REFERENCE })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it.each([["quota_exceeded", "QUOTA_EXCEEDED"], ["budget_exceeded", "BUDGET_EXCEEDED"]] as const)("does not write a candidate when %s", async (outcome, code) => {
    const backing = store({ createCandidate: vi.fn().mockResolvedValue(outcome) });
    await expect(createAiCandidateService({ store: backing }).submit(OWNER, { kind: "ai_image", prompt: "A paper collage" })).rejects.toMatchObject({ code });
    expect(backing.createCandidate).toHaveBeenCalledOnce();
  });

  it("surfaces an atomic candidate transaction failure", async () => {
    const backing = store({ createCandidate: vi.fn().mockRejectedValue(new Error("db down")) });
    await expect(createAiCandidateService({ store: backing }).submit(OWNER, { kind: "ai_image", prompt: "A paper collage" })).rejects.toThrow("db down");
  });

  it("rejects non-PNG provider data before it can become ready", () => {
    expect(() => generatedMetadata(new Uint8Array(24))).toThrow(AiAssetError);
  });

  it("submits a 1k APIMart task, polls its result, and never sends an unsupported quality field", async () => {
    const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0, 0, 0, 1]);
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: [{ status: "submitted", task_id: "task-1" }] })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ code: 200, data: { status: "completed", cost: 0.01, result: { images: [{ url: ["https://upload.apimart.ai/f/image/result.png"] }] } } })))
      .mockResolvedValueOnce(new Response(png));
    const provider = createApiMartImageProvider("test-key", fetcher, async () => undefined);

    await expect(provider.generate({ kind: "ai_image", prompt: "A notebook" })).resolves.toMatchObject({ providerOperationId: "task-1", providerCostUsd: 0.01, bytes: png });
    expect(JSON.parse((fetcher.mock.calls[0]?.[1] as RequestInit).body as string)).toEqual({ model: "gpt-image-2", prompt: "A notebook", n: 1, size: "1:1", resolution: "1k" });
    expect(fetcher.mock.calls[1]?.[0]).toBe("https://api.apimart.ai/v1/tasks/task-1?language=en");
  });

  it("keeps Trigger payloads reference-only", () => {
    expect(validateImageGenerationPayload({ assetId: CANDIDATE, schemaVersion: 1 })).toEqual({ assetId: CANDIDATE, schemaVersion: 1 });
    expect(() => validateImageGenerationPayload({ assetId: CANDIDATE, schemaVersion: 1, prompt: "never send user prompts through Trigger" })).toThrow("Invalid image generation payload");
  });
});
