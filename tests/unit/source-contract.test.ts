import { describe, expect, it } from "vitest";
import {
  sourceParseFailure,
  sourceParseResult,
  type SourceParseFailureCode,
  type SourceSegment,
} from "../../src/server/sources";

const ALL_FAILURE_CODES: readonly SourceParseFailureCode[] = [
  "SOURCE_ENCRYPTED",
  "SOURCE_NO_TEXT_LAYER",
  "SOURCE_EMPTY",
  "SOURCE_TOO_LARGE",
  "SOURCE_UNSUPPORTED_FORMAT",
  "SOURCE_MALFORMED",
  "SOURCE_BLOCKED",
  "SOURCE_UNAVAILABLE",
  "SOURCE_TIMEOUT",
];

function segment(text: string, segmentId = "11111111-1111-4111-8111-111111111111"): SourceSegment {
  return { segmentId, text };
}

describe("T038-T041 shared source parse contract", () => {
  it("refuses to report success when nothing readable was extracted", () => {
    for (const segments of [[], [segment("")], [segment("   \n\t  ")]]) {
      const result = sourceParseResult(segments, { pageCount: 12 });
      // A scanned PDF that yields no text must reach the user as a failure with a next
      // step, not as an accepted source that quietly generates from nothing.
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.code).toBe("SOURCE_EMPTY");
      expect(result.action).toBe("paste-text");
    }
  });

  it("lets a parser name the reason the extraction came back empty", () => {
    const result = sourceParseResult([segment("")], { pageCount: 3 }, "SOURCE_NO_TEXT_LAYER");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("SOURCE_NO_TEXT_LAYER");
    expect(result.action).toBe("paste-text");
  });

  it("drops blank segments and counts characters over what survives", () => {
    const result = sourceParseResult(
      [segment("你好世界", "a"), segment("   ", "b"), segment("hello", "c")],
      { title: "Deck", slideCount: 3 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segments.map((entry) => entry.segmentId)).toEqual(["a", "c"]);
    // Code points, not UTF-16 units: four CJK characters plus five ASCII.
    expect(result.metadata.characterCount).toBe(9);
    expect(result.metadata.slideCount).toBe(3);
  });

  it("keeps page, slide and time locators intact", () => {
    const result = sourceParseResult(
      [
        { segmentId: "a", text: "page", locator: { kind: "page", page: 2 } },
        { segmentId: "b", text: "slide", locator: { kind: "slide", slide: 5 } },
        { segmentId: "c", text: "clip", locator: { kind: "time", startSeconds: 0, endSeconds: 30 } },
      ],
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.segments.map((entry) => entry.locator?.kind)).toEqual(["page", "slide", "time"]);
  });

  it("gives every failure code a concrete alternative action and a message", () => {
    for (const code of ALL_FAILURE_CODES) {
      const failure = sourceParseFailure(code);
      expect(failure.ok).toBe(false);
      expect(failure.code).toBe(code);
      // AC-002: an invalid source has to tell the user what to do instead.
      expect(failure.action.length).toBeGreaterThan(0);
      expect(failure.message).toMatch(/\.$/);
    }
  });

  it("carries the AC-002 wording for a link that resolves to a private address", () => {
    const failure = sourceParseFailure("SOURCE_BLOCKED");
    expect(failure.message).toBe("This link can't be imported. Paste the public text instead.");
    expect(failure.action).toBe("paste-text");
  });

  it("lets a parser override the wording without losing the typed code", () => {
    const failure = sourceParseFailure("SOURCE_UNSUPPORTED_FORMAT", {
      action: "convert-to-pptx",
      message: "Keynote files can't be imported. Export the deck as .pptx and try again.",
    });
    expect(failure.code).toBe("SOURCE_UNSUPPORTED_FORMAT");
    expect(failure.action).toBe("convert-to-pptx");
    expect(failure.message).toContain(".pptx");
  });

  it("never leaks the extracted text into the failure it reports", () => {
    const failure = sourceParseFailure("SOURCE_ENCRYPTED");
    expect(JSON.stringify(failure)).not.toContain("segment");
  });
});
