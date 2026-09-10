import { describe, expect, it, vi } from "vitest";
import { TOOL_IMAGE_SIZES, infographicTemplate, quoteCardTemplate } from "../../src/render/tool-templates";
import {
  createCarouselVideoCandidate,
  createInfographicCandidate,
  createPortraitCandidate,
  createQuoteCardCandidate,
  renderToolImage,
  VISUAL_TOOL_NAMES,
} from "../../src/server/tools/visual-tools";
import {
  TOOL_OUTPUT_LIFETIME_MS,
  VISUAL_TOOL_IDS,
  readToolResult,
  toVisualWorkerRequest,
  type VisualWorkerRequest,
} from "../../src/server/tools/application";
import type { PersistToolOutputInput, PersistedToolOutput } from "../../src/server/tools/outputs";
import { runVisualToolJob, type VisualToolDependencies } from "../../src/trigger/visual-tool";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const REFERENCE_ID = "22222222-2222-4222-8222-222222222222";
const SLIDE_ID = "33333333-3333-4333-8333-333333333333";
const OWNER_ID = "55555555-5555-4555-8555-555555555555";
const PROJECT_ID = "66666666-6666-4666-8666-666666666666";
const AUDIO_ID = "77777777-7777-4777-8777-777777777777";
const OUTPUT_ID = "88888888-8888-4888-8888-888888888888";
const OUTPUT_ASSET_ID = "99999999-9999-4999-8999-999999999999";
const NOW = new Date("2026-09-10T00:00:00.000Z");

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

function unavailableAssets(): VisualToolDependencies["assets"] {
  return {
    loadPortraitReference: vi.fn(async () => { throw new Error("PORTRAIT_REFERENCE_UNAVAILABLE"); }),
    loadSlideFrames: vi.fn(async () => { throw new Error("VIDEO_SLIDES_UNAVAILABLE"); }),
    loadAudio: vi.fn(async () => { throw new Error("VIDEO_AUDIO_UNAVAILABLE"); }),
  };
}

function unusedBudget(): VisualToolDependencies["portraitBudget"] {
  return {
    reserve: vi.fn(async () => { throw new Error("BUDGET_GATE_NOT_EXPECTED"); }),
    settle: vi.fn(async () => { throw new Error("BUDGET_GATE_NOT_EXPECTED"); }),
  };
}

// The worker is exercised through injected adapters only: no Supabase, Storage, Chromium,
// ffmpeg or APIMart call is faked into reporting a cloud success here.
function harness(request: VisualWorkerRequest | null, overrides: Partial<VisualToolDependencies> = {}) {
  const results: Record<string, unknown>[] = [];
  const persisted: PersistToolOutputInput[] = [];
  const fail = vi.fn(async () => {});
  const persist = vi.fn(async (input: PersistToolOutputInput): Promise<PersistedToolOutput> => {
    persisted.push(input);
    const result = input.content.kind === "image"
      ? { kind: "image" as const, assetId: OUTPUT_ASSET_ID, width: input.content.width, height: input.content.height }
      : { kind: "video" as const, outputId: OUTPUT_ID, durationSeconds: input.content.kind === "video" ? input.content.durationSeconds : 0 };
    return { id: OUTPUT_ID, jobId: input.jobId, tool: input.tool, result, expiresAt: input.expiresAt.toISOString() };
  });
  const dependencies: VisualToolDependencies = {
    store: {
      claim: async () => (request ? { jobId: JOB_ID, ownerId: OWNER_ID, request } : null),
      succeed: async (_jobId, _ownerId, resultRef) => { results.push(resultRef); return true; },
      fail,
    },
    assets: unavailableAssets(),
    portraitProvider: { generate: vi.fn(async () => { throw new Error("PROVIDER_NOT_EXPECTED"); }) },
    portraitBudget: unusedBudget(),
    persist,
    renderImage: vi.fn(async () => Buffer.from("rendered-png")),
    renderVideo: vi.fn(async () => { throw new Error("RENDERER_NOT_EXPECTED"); }),
    now: () => NOW,
    ...overrides,
  };
  return { dependencies, results, persisted, persist, fail };
}

const PAYLOAD = { jobId: JOB_ID, schemaVersion: 1, requestId: "request-1" } as const;

describe("T067 visual tool worker", () => {
  it("adapts the public tool contract into a reference-only visual worker request", () => {
    expect([...VISUAL_TOOL_IDS]).toEqual([...VISUAL_TOOL_NAMES]);
    expect(toVisualWorkerRequest({ tool: "quote-card", input: { quote: "Ship carefully", attribution: "Named Author", attributionConfirmed: true } })).toEqual({
      tool: "quote-card",
      input: { quote: "Ship carefully", attribution: "Named Author", attributionConfirmed: true },
    });
    expect(toVisualWorkerRequest({
      tool: "carousel-to-video",
      input: { secondsPerSlide: 4 },
      context: { projectId: PROJECT_ID, expectedRevision: 3, fields: { slideIds: [SLIDE_ID] } },
    })).toEqual({
      tool: "carousel-to-video",
      input: { slideAssetIds: [SLIDE_ID], secondsPerSlide: 4 },
      contextProjectId: PROJECT_ID,
      contextRevision: 3,
    });
    expect(() => toVisualWorkerRequest({ tool: "caption", input: { text: "Draft" } })).toThrow("NOT_A_VISUAL_TOOL");
    expect(() => toVisualWorkerRequest({ tool: "carousel-to-video", input: { slideAssetIds: [SLIDE_ID], secondsPerSlide: 25 } })).toThrow();
  });

  it("stores a quote card as a private tool output candidate without the submitted text", async () => {
    const { dependencies, results, persisted } = harness({ tool: "quote-card", input: { quote: "Ship carefully", attributionConfirmed: false } });
    await expect(runVisualToolJob(dependencies, PAYLOAD)).resolves.toEqual({ jobId: JOB_ID, state: "succeeded" });
    expect(persisted[0]).toMatchObject({ ownerId: OWNER_ID, jobId: JOB_ID, tool: "quote-card", content: { kind: "image", mime: "image/png", width: 1080, height: 1080 } });
    expect(persisted[0]?.expiresAt.getTime()).toBe(NOW.getTime() + TOOL_OUTPUT_LIFETIME_MS);
    expect(results[0]).toMatchObject({ tool: "quote-card", state: "candidate", outputId: OUTPUT_ID, result: { kind: "image", assetId: OUTPUT_ASSET_ID, width: 1080, height: 1080 } });
    expect(JSON.stringify(results[0])).not.toContain("Ship carefully");
    expect(readToolResult(results[0]!)).toMatchObject({ tool: "quote-card", result: { kind: "image", assetId: OUTPUT_ASSET_ID } });
  });

  it("keeps the selected project context on an infographic output without applying it", async () => {
    const { dependencies, results, persisted } = harness({
      tool: "infographic",
      input: { content: "First point.\nSecond point.", title: "Guide" },
      contextProjectId: PROJECT_ID,
      contextRevision: 3,
    });
    await runVisualToolJob(dependencies, PAYLOAD);
    expect(persisted[0]).toMatchObject({ tool: "infographic", contextProjectId: PROJECT_ID, contextRevision: 3, content: { kind: "image", width: 1080, height: 1350 } });
    expect(results[0]).toMatchObject({ contextProjectId: PROJECT_ID, contextRevision: 3 });
  });

  it("refuses to call the portrait provider when the image budget is exhausted", async () => {
    const reserve = vi.fn(async () => "budget_exceeded" as const);
    const settle = vi.fn(async () => {});
    const provider = { generate: vi.fn() };
    const { dependencies, results, persist, fail } = harness(
      { tool: "portrait", input: { prompt: "A warm editorial portrait", referenceAssetId: REFERENCE_ID } },
      {
        assets: { ...unavailableAssets(), loadPortraitReference: vi.fn(async () => ({ assetId: REFERENCE_ID, bytes: Uint8Array.from([8, 9]), mime: "image/png" })) },
        portraitProvider: provider,
        portraitBudget: { reserve, settle },
      },
    );
    await expect(runVisualToolJob(dependencies, PAYLOAD)).rejects.toThrow("IMAGE_BUDGET_EXCEEDED");
    expect(provider.generate).not.toHaveBeenCalled();
    expect(settle).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(results).toEqual([]);
    expect(fail).toHaveBeenCalledWith(JOB_ID, OWNER_ID, "IMAGE_BUDGET_EXCEEDED");
  });

  it("settles the reserved image budget with the real provider cost and releases it on failure", async () => {
    const reserve = vi.fn(async () => "created" as const);
    const settle = vi.fn(async () => {});
    const provider = { generate: vi.fn(async () => ({ bytes: Uint8Array.from([1, 2, 3]), mime: "image/png" as const, providerOperationId: "provider-1", providerCostUsd: 0.02 })) };
    const assets = { ...unavailableAssets(), loadPortraitReference: vi.fn(async () => ({ assetId: REFERENCE_ID, bytes: Uint8Array.from([8, 9]), mime: "image/png" })) };
    const request: VisualWorkerRequest = { tool: "portrait", input: { prompt: "A warm editorial portrait", referenceAssetId: REFERENCE_ID } };
    const succeeded = harness(request, { assets, portraitProvider: provider, portraitBudget: { reserve, settle } });
    await runVisualToolJob(succeeded.dependencies, PAYLOAD);
    expect(reserve).toHaveBeenCalledWith({ ownerId: OWNER_ID, jobId: JOB_ID, prompt: "A warm editorial portrait", referenceAssetId: REFERENCE_ID });
    expect(settle).toHaveBeenCalledWith({ ownerId: OWNER_ID, jobId: JOB_ID, succeeded: true, bytes: Uint8Array.from([1, 2, 3]), providerOperationId: "provider-1", providerCostUsd: 0.02 });
    expect(succeeded.persisted[0]).toMatchObject({ tool: "portrait", content: { kind: "image", width: 1024, height: 1024 } });

    const failingSettle = vi.fn(async () => {});
    const failed = harness(request, {
      assets,
      portraitProvider: { generate: vi.fn(async () => { throw new Error("PROVIDER_FAILED"); }) },
      portraitBudget: { reserve: vi.fn(async () => "created" as const), settle: failingSettle },
    });
    await expect(runVisualToolJob(failed.dependencies, PAYLOAD)).rejects.toThrow("PROVIDER_FAILED");
    expect(failingSettle).toHaveBeenCalledWith({ ownerId: OWNER_ID, jobId: JOB_ID, succeeded: false });
    expect(failed.persist).not.toHaveBeenCalled();
  });

  it("renders carousel video frames in the requested slide order with explicitly authorized audio", async () => {
    const pages = [{ slideId: SLIDE_ID, bytes: Buffer.from("frame") }];
    const renderVideo = vi.fn(async () => ({ bytes: Buffer.from("video"), width: 1080, height: 1350, durationSeconds: 4, hasAudio: true }));
    const audio = { bytes: Buffer.from("audio"), extension: "mp3" };
    const { dependencies, persisted, results } = harness(
      { tool: "carousel-to-video", input: { slideAssetIds: [SLIDE_ID], secondsPerSlide: 4, audioAssetId: AUDIO_ID } },
      {
        assets: { ...unavailableAssets(), loadSlideFrames: vi.fn(async () => ({ pages, width: 1080, height: 1350 })), loadAudio: vi.fn(async () => audio) },
        renderVideo,
      },
    );
    await runVisualToolJob(dependencies, PAYLOAD);
    expect(renderVideo).toHaveBeenCalledWith({ pages, width: 1080, height: 1350, options: { secondsPerSlide: 4, audioAssetId: AUDIO_ID }, audio });
    expect(persisted[0]).toMatchObject({ tool: "carousel-to-video", content: { kind: "video", mime: "video/mp4", durationSeconds: 4 } });
    expect(results[0]).toMatchObject({ tool: "carousel-to-video", result: { kind: "video", outputId: OUTPUT_ID, durationSeconds: 4 } });
  });

  it("fails the job with the tool error code and writes no candidate when a slide is unavailable", async () => {
    const { dependencies, results, persist, fail } = harness({ tool: "carousel-to-video", input: { slideAssetIds: [SLIDE_ID], secondsPerSlide: 4 } });
    await expect(runVisualToolJob(dependencies, PAYLOAD)).rejects.toThrow("VIDEO_SLIDES_UNAVAILABLE");
    expect(fail).toHaveBeenCalledWith(JOB_ID, OWNER_ID, "VIDEO_SLIDES_UNAVAILABLE");
    expect(persist).not.toHaveBeenCalled();
    expect(results).toEqual([]);
  });

  it("accepts only reference-only payloads and ignores an unclaimable job", async () => {
    const { dependencies, persist } = harness({ tool: "quote-card", input: { quote: "Ship carefully", attributionConfirmed: false } });
    await expect(runVisualToolJob(dependencies, { ...PAYLOAD, ownerId: OWNER_ID })).rejects.toThrow();
    await expect(runVisualToolJob(dependencies, { jobId: JOB_ID, schemaVersion: 2, requestId: "request-1" })).rejects.toThrow();
    expect(persist).not.toHaveBeenCalled();
    const ignored = harness(null);
    await expect(runVisualToolJob(ignored.dependencies, PAYLOAD)).resolves.toEqual({ jobId: JOB_ID, state: "ignored" });
    expect(ignored.persist).not.toHaveBeenCalled();
  });
});
