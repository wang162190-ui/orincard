import { describe, expect, it } from "vitest";
import baseDocument from "../fixtures/base-document.json";
import {
  DEFAULT_SLIDE_COUNT,
  carouselDocumentSchema,
  getPlatformDimensions,
  parseCarouselDocument,
} from "../../src/domain/document";
import { DomainError } from "../../src/domain/errors";

function cloneFixture(): Record<string, any> {
  return structuredClone(baseDocument) as Record<string, any>;
}

function fixtureWithSlideCount(count: number): Record<string, any> {
  const document = cloneFixture();
  const intro = structuredClone(document.slides[0]);
  const content = structuredClone(document.slides[1]);
  const outro = structuredClone(document.slides.at(-1));

  document.slides = [
    intro,
    ...Array.from({ length: count - 2 }, (_, index) => ({
      ...structuredClone(content),
      id: `local-content-${index + 1}`,
    })),
    { ...outro, id: "local-outro" },
  ];
  return document;
}

describe("CarouselDocument", () => {
  it("parses the six-slide development fixture", () => {
    const parsed = parseCarouselDocument(baseDocument);

    expect(parsed.slides).toHaveLength(DEFAULT_SLIDE_COUNT);
    expect(parsed.slides[0].role).toBe("intro");
    expect(parsed.slides.at(-1)?.role).toBe("outro");
  });

  it.each([4, 8, 12])("accepts %i slides", (count) => {
    expect(carouselDocumentSchema.safeParse(fixtureWithSlideCount(count)).success).toBe(true);
  });

  it.each([
    ["linkedin", 1080, 1350],
    ["instagram", 1080, 1350],
    ["tiktok", 1080, 1920],
    ["square", 1080, 1080],
    ["presentation", 1920, 1080],
  ] as const)("uses the fixed %s platform dimensions", (platform, width, height) => {
    expect(getPlatformDimensions(platform)).toEqual({ width, height });
  });

  it("rejects slide counts outside 4–12", () => {
    expect(carouselDocumentSchema.safeParse(fixtureWithSlideCount(3)).success).toBe(false);
    expect(carouselDocumentSchema.safeParse(fixtureWithSlideCount(13)).success).toBe(false);
  });

  it("rejects unknown fields instead of preserving them", () => {
    const document = cloneFixture();
    document.owner_id = "private-account-id";

    expect(carouselDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("returns a typed error for unsupported document versions", () => {
    const document = cloneFixture();
    document.schemaVersion = 2;

    expect(() => parseCarouselDocument(document)).toThrowError(
      expect.objectContaining<Partial<DomainError>>({
        code: "DOCUMENT_VERSION_UNSUPPORTED",
      }),
    );
  });

  it("requires intro and outro roles at the boundaries", () => {
    const document = cloneFixture();
    document.slides[0].role = "content";
    document.slides.at(-1).role = "content";

    const result = carouselDocumentSchema.safeParse(document);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "The first slide must use the intro role",
          "The final slide must use the outro role",
        ]),
      );
    }
  });

  it("rejects duplicate slide IDs", () => {
    const document = cloneFixture();
    document.slides[1].id = document.slides[0].id;

    expect(carouselDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("rejects missing asset declarations and out-of-bounds crops", () => {
    const document = cloneFixture();
    document.slides[1].assetSlots.push({
      slotId: "hero",
      assetId: "local-missing-asset",
      fit: "cover",
      crop: { x: 0.75, y: 0, width: 0.5, height: 1 },
      opacity: 1,
      alt: "Illustrative asset",
    });

    const result = carouselDocumentSchema.safeParse(document);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          "Crop exceeds the horizontal asset boundary",
          "The asset slot references an undeclared asset",
        ]),
      );
    }
  });

  it("requires complete timestamp ranges", () => {
    const document = cloneFixture();
    document.slides[1].bodyBlocks[0].sourceRefs = [
      {
        sourceId: "local-source",
        segmentId: "local-segment",
        timeStart: 12,
        kind: "paraphrase",
      },
    ];

    expect(carouselDocumentSchema.safeParse(document).success).toBe(false);
  });

  it("measures emphasis ranges by Unicode code point", () => {
    const document = cloneFixture();
    document.slides[1].bodyBlocks[0] = {
      kind: "paragraph",
      text: "知🙂识",
      emphasisRanges: [{ start: 0, end: 4 }],
    };

    expect(carouselDocumentSchema.safeParse(document).success).toBe(false);
  });
});
