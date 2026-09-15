import { describe, expect, it } from "vitest";
import baseDocument from "../fixtures/base-document.json";
import { applyToolResultToDocument, readToolResult, toTextWorkerRequest } from "../../src/server/tools/application";

describe("T066 explicit tool application", () => {
  it("adapts the public kebab-case context contract without broadening selected fields", () => {
    const request = toTextWorkerRequest({ tool: "caption", input: { text: "Draft" }, context: { projectId: "11111111-1111-4111-8111-111111111111", expectedRevision: 2, fields: { title: true, slideIds: ["22222222-2222-4222-8222-222222222222"] } } });
    expect(request.tool).toBe("caption");
    expect(request.selectedContext).toEqual(["title", "slides"]);
    expect(request.selectedSlideIds).toEqual(["22222222-2222-4222-8222-222222222222"]);
  });

  // 回归：这两个字段 `inputSchemas` 收、`buildToolCatalog` 还广告给了规划模型，
  // 从前却在这里被静默丢掉——计划写 count: 3，worker 照样回 5 条。
  it("carries the count and instructions the input schema accepts", () => {
    const request = toTextWorkerRequest({ tool: "post-ideas", input: { topic: "Shipping small", count: 3, instructions: "Keep each angle concrete." } });
    expect(request.input).toBe("Shipping small");
    expect(request.count).toBe(3);
    expect(request.instructions).toBe("Keep each angle concrete.");
  });

  it("leaves both unset when the caller omitted them", () => {
    const request = toTextWorkerRequest({ tool: "caption", input: { text: "Draft" } });
    expect(request.count).toBeUndefined();
    expect(request.instructions).toBeUndefined();
  });

  it("changes only the requested caption and leaves the input snapshot immutable", () => {
    const before = structuredClone(baseDocument);
    const next = applyToolResultToDocument(before, { kind: "text", markdown: "New candidate" }, { kind: "caption" });
    expect(next.caption).toBe("New candidate");
    expect(before).toEqual(baseDocument);
    expect(next.slides).toEqual(baseDocument.slides);
    expect(next.brandSnapshot).toEqual(baseDocument.brandSnapshot);
  });

  it("rejects applying an incompatible result target", () => {
    expect(() => applyToolResultToDocument(baseDocument, { kind: "text", markdown: "Candidate" }, { kind: "slide" })).toThrow("INVALID_TARGET");
  });

  it("normalizes a stored text candidate into the shared ToolResult contract", () => {
    expect(readToolResult({ candidate: { schemaVersion: 1, resultId: "r", jobId: "j", tool: "caption", state: "candidate", payload: { text: "Hello", hashtags: ["#one"] } } })).toMatchObject({ tool: "caption", result: { kind: "text", markdown: "Hello\n\n#one" } });
  });
});
