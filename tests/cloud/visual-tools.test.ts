import { describe, expect, it, vi } from "vitest";
import { TOOL_IMAGE_SIZES, infographicTemplate, quoteCardTemplate } from "../../src/render/tool-templates";
import {
  createCarouselVideoCandidate,
  createInfographicCandidate,
  createPortraitCandidate,
  createQuoteCardCandidate,
  renderToolImage,
} from "../../src/server/tools/visual-tools";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const REFERENCE_ID = "22222222-2222-4222-8222-222222222222";
const SLIDE_ID = "33333333-3333-4333-8333-333333333333";

function pngDimensions(bytes: Buffer) {
  expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

describe("T064 visual tool candidates", () => {
  it("never renders an unconfirmed celebrity attribution and escapes supplied quote text", async () => {
    let html = "";
    const result = await createQuoteCardCandidate({
      jobId: JOB_ID,
      request: { quote: "Ship <carefully>", attribution: "Famous Person", attributionConfirmed: false },
      render: async (input) => { html = input.html; return Buffer.from("png"); },
      createId: () => "quote-result",
    });
    expect(html).toContain("Ship &lt;carefully&gt;");
    expect(html).not.toContain("Famous Person");
    expect(result).toMatchObject({ tool: "quote-card", state: "candidate", metadata: { attribution: null, attributionConfirmed: false }, artifact: { kind: "image", dimensions: TOOL_IMAGE_SIZES["quote-square"] } });
  });

  it("renders only an explicitly confirmed attribution", () => {
    expect(quoteCardTemplate({ quote: "A verified quotation", attribution: "Named Author", attributionConfirmed: true }).html).toContain("Named Author");
    expect(quoteCardTemplate({ quote: "An unattributed quotation", attributionConfirmed: false }).html).not.toContain("—");
  });

  it("uses separate controlled image dimensions and renders a real quote PNG", async () => {
    expect(TOOL_IMAGE_SIZES["quote-square"]).toEqual({ id: "quote-square", width: 1080, height: 1080 });
    expect(TOOL_IMAGE_SIZES["infographic-portrait"]).toEqual({ id: "infographic-portrait", width: 1080, height: 1350 });
    expect(TOOL_IMAGE_SIZES["portrait-square"]).toEqual({ id: "portrait-square", width: 1024, height: 1024 });
    const template = quoteCardTemplate({ quote: "A real rendered candidate", attributionConfirmed: false });
    const bytes = await renderToolImage({ html: template.html, width: template.dimensions.width, height: template.dimensions.height });
    expect(pngDimensions(bytes)).toEqual({ width: 1080, height: 1080 });
  });

  it("creates a bounded infographic candidate without interpreting content as markup", async () => {
    let html = "";
    const result = await createInfographicCandidate({
      jobId: JOB_ID,
      request: { title: "A <safe> guide", content: "First point.\nSecond point.\nThird point.", instructions: "Keep it concise" },
      render: async (input) => { html = input.html; return Buffer.from("png"); },
      createId: () => "infographic-result",
    });
    expect(html).toContain("A &lt;safe&gt; guide");
    expect(html).not.toContain("<safe>");
    expect(result).toMatchObject({ tool: "infographic", state: "candidate", metadata: { pointCount: 3 }, artifact: { dimensions: TOOL_IMAGE_SIZES["infographic-portrait"] } });
    expect(infographicTemplate({ title: "Guide", points: ["One"] }).dimensions.id).toBe("infographic-portrait");
  });

  it("reuses the image provider for a portrait that still requires user acceptance", async () => {
    const provider = { generate: vi.fn().mockResolvedValue({ bytes: Uint8Array.from([1, 2, 3]), mime: "image/png", providerOperationId: "provider-1", providerCostUsd: 0.01 }) };
    const reference = Uint8Array.from([8, 9]);
    const result = await createPortraitCandidate({
      jobId: JOB_ID,
      request: { prompt: "A warm editorial portrait", referenceAssetId: REFERENCE_ID },
      reference: { assetId: REFERENCE_ID, bytes: reference, mime: "image/png" },
      provider,
      createId: () => "portrait-result",
    });
    expect(provider.generate).toHaveBeenCalledWith({ kind: "portrait", prompt: "A warm editorial portrait", reference, referenceMime: "image/png" });
    expect(result).toMatchObject({ tool: "portrait", state: "candidate", metadata: { referenceAssetId: REFERENCE_ID, userAcceptedRequired: true }, artifact: { dimensions: TOOL_IMAGE_SIZES["portrait-square"] } });
    await expect(createPortraitCandidate({ jobId: JOB_ID, request: { prompt: "Portrait", referenceAssetId: REFERENCE_ID }, reference: { assetId: randomId(), bytes: reference, mime: "image/png" }, provider })).rejects.toThrow("PORTRAIT_REFERENCE_UNAVAILABLE");
  });

  it("reuses the MP4 renderer in slide order and returns only a candidate", async () => {
    const pages = [{ slideId: SLIDE_ID, bytes: Buffer.from("frame") }];
    const before = pages.map((page) => ({ slideId: page.slideId, bytes: page.bytes.toString("hex") }));
    const render = vi.fn().mockResolvedValue({ bytes: Buffer.from("video"), width: 1080, height: 1350, durationSeconds: 4, hasAudio: false });
    const result = await createCarouselVideoCandidate({
      jobId: JOB_ID,
      request: { slideAssetIds: [SLIDE_ID], secondsPerSlide: 4 },
      pages,
      width: 1080,
      height: 1350,
      render,
      createId: () => "video-result",
    });
    expect(render).toHaveBeenCalledWith({ pages, width: 1080, height: 1350, options: { secondsPerSlide: 4, audioAssetId: null } });
    expect(result).toMatchObject({ tool: "carousel-to-video", state: "candidate", artifact: { kind: "video", durationSeconds: 4 }, metadata: { slideIds: [SLIDE_ID] } });
    expect(result).not.toHaveProperty("projectId");
    expect(pages.map((page) => ({ slideId: page.slideId, bytes: page.bytes.toString("hex") }))).toEqual(before);
  });
});

function randomId() {
  return "44444444-4444-4444-8444-444444444444";
}
