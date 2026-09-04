import { describe, expect, it } from "vitest";
import baseDocument from "../fixtures/base-document.json";
import {
  MAX_SLIDE_COUNT,
  MIN_SLIDE_COUNT,
  parseCarouselDocument,
  type CarouselDocument,
} from "../../src/domain/document";
import {
  addSlide,
  deleteSlide,
  duplicateSlide,
  moveSlide,
  redo,
  undo,
} from "../../src/features/editor/commands";
import {
  createEditorState,
  editorReducer,
} from "../../src/features/editor/reducer";

type Slide = CarouselDocument["slides"][number];

function createDocument(): CarouselDocument {
  return parseCarouselDocument(structuredClone(baseDocument));
}

function createContentSlide(id: string): Slide {
  const slide = structuredClone(createDocument().slides[1]);
  return { ...slide, id, revision: 1, role: "content" };
}

function createDocumentWithSlideCount(count: number): CarouselDocument {
  const document = createDocument();
  const intro = structuredClone(document.slides[0]);
  const content = document.slides[1];
  const outro = structuredClone(document.slides.at(-1)!);

  document.slides = [
    intro,
    ...Array.from({ length: count - 2 }, (_, index) => ({
      ...structuredClone(content),
      id: `local-content-${index + 1}`,
    })),
    { ...outro, id: "local-outro" },
  ];

  return parseCarouselDocument(document);
}

describe("editor slide commands", () => {
  it("adds a content slide without replacing existing slides and supports undo/redo", () => {
    const document = createDocument();
    const initial = createEditorState(document);
    const added = editorReducer(
      initial,
      addSlide(createContentSlide("local-added"), 2),
    );

    expect(added.document.slides.map((slide) => slide.id)).toEqual([
      "local-slide-01",
      "local-slide-02",
      "local-added",
      "local-slide-03",
      "local-slide-04",
      "local-slide-05",
      "local-slide-06",
    ]);
    expect(added.document.slides[0]).toBe(document.slides[0]);
    expect(added.document.slides[1]).toBe(document.slides[1]);
    expect(added.document.slides[3]).toBe(document.slides[2]);

    const undone = editorReducer(added, undo());
    expect(undone.document).toBe(document);

    const redone = editorReducer(undone, redo());
    expect(redone.document).toBe(added.document);
    expect(redone.document.slides[1]).toBe(document.slides[1]);
  });

  it("duplicates a slide with an independent ID and nested content", () => {
    const document = createDocument();
    const source = document.slides[1];
    const next = editorReducer(
      createEditorState(document),
      duplicateSlide(source.id, "local-duplicate"),
    );
    const duplicate = next.document.slides[2];

    expect(duplicate).toEqual({
      ...source,
      id: "local-duplicate",
      revision: 1,
      role: "content",
    });
    expect(duplicate).not.toBe(source);
    expect(duplicate.bodyBlocks).not.toBe(source.bodyBlocks);
    expect(next.document.slides[3]).toBe(document.slides[2]);
  });

  it("duplicates intro and outro slides as content without replacing the boundaries", () => {
    const document = createDocument();
    const introCopy = editorReducer(
      createEditorState(document),
      duplicateSlide(document.slides[0].id, "local-intro-copy"),
    );
    const outroCopy = editorReducer(
      introCopy,
      duplicateSlide(document.slides.at(-1)!.id, "local-outro-copy"),
    );

    expect(outroCopy.document.slides[0]).toBe(document.slides[0]);
    expect(outroCopy.document.slides[1]).toMatchObject({
      id: "local-intro-copy",
      role: "content",
    });
    expect(outroCopy.document.slides.at(-2)).toMatchObject({
      id: "local-outro-copy",
      role: "content",
    });
    expect(outroCopy.document.slides.at(-1)).toBe(document.slides.at(-1));
  });

  it("deletes only a content slide and retains document asset declarations", () => {
    const document = createDocument();
    const next = editorReducer(
      createEditorState(document),
      deleteSlide("local-slide-03"),
    );

    expect(next.document.slides.map((slide) => slide.id)).not.toContain(
      "local-slide-03",
    );
    expect(next.document.slides[1]).toBe(document.slides[1]);
    expect(next.document.slides[2]).toBe(document.slides[3]);
    expect(next.document.assetRefs).toBe(document.assetRefs);
  });

  it("reorders content slides without mutating their data or the boundary slides", () => {
    const document = createDocument();
    const next = editorReducer(
      createEditorState(document),
      moveSlide("local-slide-04", 1),
    );

    expect(next.document.slides.map((slide) => slide.id)).toEqual([
      "local-slide-01",
      "local-slide-04",
      "local-slide-02",
      "local-slide-03",
      "local-slide-05",
      "local-slide-06",
    ]);
    expect(next.document.slides[0]).toBe(document.slides[0]);
    expect(next.document.slides[1]).toBe(document.slides[3]);
    expect(next.document.slides.at(-1)).toBe(document.slides.at(-1));
  });

  it("keeps the 4-slide minimum and 12-slide maximum as no-op boundaries", () => {
    const minimum = createDocumentWithSlideCount(MIN_SLIDE_COUNT);
    const minimumState = createEditorState(minimum);
    expect(
      editorReducer(minimumState, deleteSlide(minimum.slides[1].id)),
    ).toBe(minimumState);

    const maximum = createDocumentWithSlideCount(MAX_SLIDE_COUNT);
    const maximumState = createEditorState(maximum);
    expect(
      editorReducer(
        maximumState,
        addSlide(createContentSlide("local-over-limit")),
      ),
    ).toBe(maximumState);
    expect(
      editorReducer(
        maximumState,
        duplicateSlide(maximum.slides[1].id, "local-over-limit"),
      ),
    ).toBe(maximumState);
  });

  it("rejects commands that would move or delete intro and outro boundaries", () => {
    const document = createDocument();
    const state = createEditorState(document);

    expect(editorReducer(state, deleteSlide(document.slides[0].id))).toBe(state);
    expect(editorReducer(state, deleteSlide(document.slides.at(-1)!.id))).toBe(
      state,
    );
    expect(editorReducer(state, moveSlide(document.slides[0].id, 2))).toBe(state);
    expect(editorReducer(state, moveSlide(document.slides[2].id, 0))).toBe(state);
  });

  it("clears redo history after a new edit follows undo", () => {
    const document = createDocument();
    const added = editorReducer(
      createEditorState(document),
      addSlide(createContentSlide("local-first")),
    );
    const undone = editorReducer(added, undo());
    const replacement = editorReducer(
      undone,
      addSlide(createContentSlide("local-replacement")),
    );

    expect(editorReducer(replacement, redo())).toBe(replacement);
    expect(replacement.document.slides.map((slide) => slide.id)).toContain(
      "local-replacement",
    );
    expect(replacement.document.slides.map((slide) => slide.id)).not.toContain(
      "local-first",
    );
  });
});
