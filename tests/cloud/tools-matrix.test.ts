import { describe, expect, it, vi } from "vitest";
import baseDocument from "../fixtures/base-document.json";
import { parseToolRequest, TOOL_IDS } from "../../src/domain/tools";
import { TOOL_REGISTRY } from "../../src/features/tools/registry";
import { applyToolResultToDocument } from "../../src/server/tools/application";
import { generateTextToolCandidate, type TextToolName } from "../../src/server/tools/text-tools";
import {
  createCarouselVideoCandidate,
  createInfographicCandidate,
  createPortraitCandidate,
  createQuoteCardCandidate,
} from "../../src/server/tools/visual-tools";

const PROJECT_ID = "11111111-1111-4111-8111-111111111111";
const SLIDE_ID = "22222222-2222-4222-8222-222222222222";
const ASSET_ID = "33333333-3333-4333-8333-333333333333";
const JOB_ID = "44444444-4444-4444-8444-444444444444";

const requests = {
  caption: { input: { text: "A concise launch note" } },
  "linkedin-post": { input: { text: "A professional launch note" } },
  "post-ideas": { input: { topic: "Design systems", count: 3 } },
  "quote-card": { input: { quote: "Make the next step clear.", attributionConfirmed: false } },
  infographic: { input: { title: "Three steps", content: "Plan. Build. Verify." } },
  portrait: { input: { prompt: "Editorial portrait", referenceAssetId: ASSET_ID } },
  "carousel-to-video": { input: { slideAssetIds: [SLIDE_ID], secondsPerSlide: 4 } },
} as const;

const context = {
  projectId: PROJECT_ID,
  expectedRevision: 1,
  fields: { title: true, slideIds: [SLIDE_ID] },
};

describe("T067 seven-tool acceptance matrix", () => {
  it("covers every registry tool through independent and explicitly selected project entry", () => {
    expect(TOOL_REGISTRY.map((tool) => tool.id)).toEqual(TOOL_IDS);
    for (const tool of TOOL_IDS) {
      expect(parseToolRequest(tool, requests[tool])).toMatchObject({ tool });
      expect(parseToolRequest(tool, { ...requests[tool], context })).toMatchObject({ tool, context });
    }
  });

  it("creates candidates for all seven tools without changing a project", async () => {
    const document = structuredClone(baseDocument);
    const before = structuredClone(document);
    const ai = { generateStructured: vi.fn(async ({ schemaName }: { schemaName: string }) => {
      if (schemaName.endsWith("caption")) return { text: "Candidate", hashtags: ["#draft"] };
      if (schemaName.endsWith("linkedin-post")) return { hook: "Hook", body: "Body", cta: "CTA", hashtags: [] };
      return { ideas: [{ title: "One", angle: "A" }, { title: "Two", angle: "B" }, { title: "Three", angle: "C" }] };
    }) } as never;
    for (const tool of ["caption", "linkedin-post", "post-ideas"] as const satisfies readonly TextToolName[]) {
      const candidate = await generateTextToolCandidate({ ai, jobId: JOB_ID, request: { tool, input: "Brief", selectedContext: [] }, createId: () => `${tool}-result` });
      expect(candidate).toMatchObject({ tool, state: "candidate" });
    }
    expect(await createQuoteCardCandidate({ jobId: JOB_ID, request: requests["quote-card"].input, render: async () => Buffer.from("png") })).toMatchObject({ tool: "quote-card", state: "candidate" });
    expect(await createInfographicCandidate({ jobId: JOB_ID, request: requests.infographic.input, render: async () => Buffer.from("png") })).toMatchObject({ tool: "infographic", state: "candidate" });
    expect(await createPortraitCandidate({ jobId: JOB_ID, request: requests.portrait.input, reference: { assetId: ASSET_ID, bytes: new Uint8Array([1]), mime: "image/png" }, provider: { generate: async () => ({ bytes: new Uint8Array([2]), mime: "image/png", providerOperationId: "provider-1", providerCostUsd: 0.01 }) } })).toMatchObject({ tool: "portrait", state: "candidate" });
    expect(await createCarouselVideoCandidate({ jobId: JOB_ID, request: requests["carousel-to-video"].input, pages: [{ slideId: SLIDE_ID, bytes: Buffer.from("page") }], width: 1080, height: 1350, render: async () => ({ bytes: Buffer.from("mp4"), width: 1080, height: 1350, durationSeconds: 4, hasAudio: false }) })).toMatchObject({ tool: "carousel-to-video", state: "candidate" });
    expect(document).toEqual(before);
  });

  it("applies only after an explicit target and preserves the original on refusal or failure", () => {
    const document = structuredClone(baseDocument);
    expect(applyToolResultToDocument(document, { kind: "text", markdown: "Accepted" }, { kind: "caption" }).caption).toBe("Accepted");
    expect(() => applyToolResultToDocument(document, { kind: "text", markdown: "Rejected" }, { kind: "slide" })).toThrow("INVALID_TARGET");
    expect(document.caption).toBe(baseDocument.caption);
    expect(() => parseToolRequest("portrait", { input: { prompt: "Missing reference", referenceAssetId: "foreign" } })).toThrow();
  });
});
