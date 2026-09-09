import { describe, expect, it } from "vitest";
import { TOOL_IDS, parseToolRequest, parseToolResult } from "../../src/domain/tools";
import { TOOL_REGISTRY, getToolDefinition } from "../../src/features/tools/registry";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const SLIDE = "22222222-2222-4222-8222-222222222222";
const ASSET = "33333333-3333-4333-8333-333333333333";

describe("T062 tool contracts", () => {
  it("registers exactly the seven product tools once", () => {
    expect(TOOL_IDS).toHaveLength(7);
    expect(TOOL_REGISTRY.map((tool) => tool.id)).toEqual(TOOL_IDS);
    expect(new Set(TOOL_REGISTRY.map((tool) => tool.id)).size).toBe(7);
    expect(getToolDefinition("carousel-to-video").resultType).toBe("video");
  });

  it("accepts standalone typed inputs for all standalone tools", () => {
    expect(parseToolRequest("caption", { input: { text: "A useful caption" } }).tool).toBe("caption");
    expect(parseToolRequest("linkedin-post", { input: { text: "A useful post" } }).tool).toBe("linkedin-post");
    expect(parseToolRequest("post-ideas", { input: { topic: "Design systems" } }).input.count).toBe(5);
    expect(parseToolRequest("quote-card", { input: { quote: "Original words", attributionConfirmed: false } }).tool).toBe("quote-card");
    expect(parseToolRequest("infographic", { input: { content: "One fact" } }).tool).toBe("infographic");
    expect(parseToolRequest("portrait", { input: { prompt: "Studio portrait", referenceAssetId: ASSET } }).tool).toBe("portrait");
  });

  it("requires explicit project fields and never accepts a whole document", () => {
    const request = parseToolRequest("caption", { input: {}, context: { projectId: PROJECT, expectedRevision: 3, fields: { title: true, slideIds: [SLIDE] } } });
    expect(request.context?.fields).toEqual({ title: true, slideIds: [SLIDE] });
    expect(() => parseToolRequest("caption", { input: {}, context: { projectId: PROJECT, expectedRevision: 3, fields: {} } })).toThrow();
    expect(() => parseToolRequest("caption", { input: {}, context: { projectId: PROJECT, expectedRevision: 3, fields: { title: true }, document: { slides: [] } } })).toThrow();
    expect(() => parseToolRequest("caption", { input: {}, document: { slides: [] } })).toThrow();
  });

  it("requires explicitly selected slides for carousel video", () => {
    expect(() => parseToolRequest("carousel-to-video", { input: {} })).toThrow("Select at least one slide");
    expect(parseToolRequest("carousel-to-video", { input: {}, context: { projectId: PROJECT, expectedRevision: 1, fields: { slideIds: [SLIDE] } } }).input.secondsPerSlide).toBe(4);
    expect(parseToolRequest("carousel-to-video", { input: { slideAssetIds: [ASSET] } }).input.slideAssetIds).toEqual([ASSET]);
  });

  it("rejects unknown input fields and validates result variants", () => {
    expect(() => parseToolRequest("caption", { input: { text: "ok", project: { secret: true } } })).toThrow();
    expect(parseToolResult({ kind: "text", markdown: "Ready" })).toEqual({ kind: "text", markdown: "Ready" });
    expect(parseToolResult({ kind: "image", assetId: ASSET, width: 1080, height: 1350 }).kind).toBe("image");
    expect(parseToolResult({ kind: "video", outputId: ASSET, durationSeconds: 12 }).kind).toBe("video");
    expect(() => parseToolResult({ kind: "text", markdown: "Ready", rawPrompt: "private" })).toThrow();
  });
});
