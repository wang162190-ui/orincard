import { describe, expect, it, vi } from "vitest";
import baseDocument from "../fixtures/base-document.json";
import { parseCarouselDocument } from "../../src/domain/document";
import { generateTextToolCandidate, parseTextToolRequest, selectProjectContext, type TextToolCandidate, type TextToolName } from "../../src/server/tools/text-tools";
import { runTextToolJob, type TextToolWorkerStore } from "../../src/trigger/tool";

const JOB_ID = "11111111-1111-4111-8111-111111111111";
const OWNER_ID = "22222222-2222-4222-8222-222222222222";

const outputs: Record<TextToolName, unknown> = {
  caption: { text: "A concise caption", hashtags: ["#design"] },
  linkedInPost: { hook: "A strong hook", body: "A useful post body.", cta: "What would you add?", hashtags: ["#creators"] },
  postIdeas: { ideas: [{ title: "One", angle: "First angle" }, { title: "Two", angle: "Second angle" }, { title: "Three", angle: "Third angle" }] },
};

describe("T063 text tools", () => {
  it.each(["caption", "linkedInPost", "postIdeas"] as const)("generates a %s candidate from an empty standalone input", async (tool) => {
    const ai = { generateStructured: vi.fn().mockResolvedValue(outputs[tool]) };
    const candidate = await generateTextToolCandidate({ ai, jobId: JOB_ID, request: { tool, input: "", selectedContext: [] }, createId: () => "result-1" });
    expect(candidate).toMatchObject({ schemaVersion: 1, resultId: "result-1", jobId: JOB_ID, tool, state: "candidate", payload: outputs[tool] });
    expect(ai.generateStructured).toHaveBeenCalledOnce();
  });

  it("inherits only explicitly selected project context without modifying the project", async () => {
    const document = parseCarouselDocument(baseDocument);
    const before = structuredClone(document);
    const context = selectProjectContext(document, ["title"]);
    expect(context).toEqual({ title: document.title });
    expect(context).not.toHaveProperty("caption");
    expect(context).not.toHaveProperty("slides");
    const ai = { generateStructured: vi.fn().mockResolvedValue(outputs.caption) };
    await generateTextToolCandidate({ ai, jobId: JOB_ID, request: { tool: "caption", input: "Improve this", contextProjectId: "33333333-3333-4333-8333-333333333333", contextRevision: 4, selectedContext: ["title"] }, selectedProjectContext: context });
    expect(document).toEqual(before);
    expect(JSON.parse(ai.generateStructured.mock.calls[0][0].input).selectedProjectContext).toEqual({ title: document.title });
  });

  it("rejects implicit context and invalid provider output", async () => {
    expect(() => parseTextToolRequest({ tool: "caption", input: "", selectedContext: ["slides"] })).toThrow("Selected context");
    await expect(generateTextToolCandidate({ ai: { generateStructured: async () => ({ text: "missing hashtags" }) }, jobId: JOB_ID, request: { tool: "caption", input: "", selectedContext: [] } })).rejects.toThrow("TEXT_TOOL_INVALID_OUTPUT");
  });

  it("persists only a candidate result and has no project mutation operation", async () => {
    let stored: TextToolCandidate | undefined;
    const store: TextToolWorkerStore = {
      claim: async () => ({ jobId: JOB_ID, ownerId: OWNER_ID, request: { tool: "postIdeas", input: "", selectedContext: [] } }),
      succeed: async (_jobId, _ownerId, candidate) => { stored = candidate; return true; },
      fail: vi.fn(),
    };
    const result = await runTextToolJob(store, async (work) => ({ schemaVersion: 1, resultId: "result-2", jobId: work.jobId, tool: "postIdeas", state: "candidate", payload: outputs.postIdeas as Record<string, unknown> }), { jobId: JOB_ID, schemaVersion: 1, requestId: "request-1" });
    expect(result.state).toBe("succeeded");
    expect(stored?.state).toBe("candidate");
    expect(Object.keys(store).sort()).toEqual(["claim", "fail", "succeed"]);
  });

  it("marks a provider failure without writing a candidate", async () => {
    const succeed = vi.fn();
    const fail = vi.fn();
    const store: TextToolWorkerStore = {
      claim: async () => ({ jobId: JOB_ID, ownerId: OWNER_ID, request: { tool: "caption", input: "", selectedContext: [] } }),
      succeed,
      fail,
    };
    await expect(runTextToolJob(store, async () => { throw new Error("PROVIDER_FAILED"); }, { jobId: JOB_ID, schemaVersion: 1, requestId: "request-2" })).rejects.toThrow("PROVIDER_FAILED");
    expect(succeed).not.toHaveBeenCalled();
    expect(fail).toHaveBeenCalledWith(JOB_ID, OWNER_ID, "PROVIDER_FAILED");
  });
});
