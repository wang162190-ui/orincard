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
