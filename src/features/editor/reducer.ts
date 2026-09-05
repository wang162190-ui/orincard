import {
  MAX_SLIDE_COUNT,
  MIN_SLIDE_COUNT,
  carouselDocumentSchema,
  type CarouselDocument,
} from "../../domain/document";
import type { EditorCommand, Slide } from "./commands";

export interface EditorState {
  readonly document: CarouselDocument;
  readonly past: readonly CarouselDocument[];
  readonly future: readonly CarouselDocument[];
}

export const EDITOR_HISTORY_LIMIT = 100;

export function appendEditorHistory(
  history: readonly CarouselDocument[],
  document: CarouselDocument,
): readonly CarouselDocument[] {
  return [...history, document].slice(-EDITOR_HISTORY_LIMIT);
}

export function createEditorState(document: CarouselDocument): EditorState {
  return { document, past: [], future: [] };
}

function commitDocument(
  state: EditorState,
  document: CarouselDocument,
): EditorState {
  if (!carouselDocumentSchema.safeParse(document).success) {
    return state;
  }

  return {
    document,
    past: appendEditorHistory(state.past, state.document),
    future: [],
  };
}

function replaceSlides(
  document: CarouselDocument,
  slides: Slide[],
): CarouselDocument {
  return { ...document, slides };
}

function add(state: EditorState, command: Extract<EditorCommand, { type: "slide/add" }>) {
  const { slides } = state.document;
  const index = command.index ?? slides.length - 1;

  if (
    slides.length >= MAX_SLIDE_COUNT ||
    command.slide.role !== "content" ||
    !Number.isInteger(index) ||
    index < 1 ||
    index > slides.length - 1 ||
    slides.some((slide) => slide.id === command.slide.id)
  ) {
    return state;
  }

  const nextSlides = [...slides];
  nextSlides.splice(index, 0, structuredClone(command.slide));
  return commitDocument(state, replaceSlides(state.document, nextSlides));
}

function remove(
  state: EditorState,
  command: Extract<EditorCommand, { type: "slide/delete" }>,
) {
  const { slides } = state.document;
  const index = slides.findIndex((slide) => slide.id === command.slideId);

  if (
    slides.length <= MIN_SLIDE_COUNT ||
    index < 0 ||
    slides[index].role !== "content"
  ) {
    return state;
  }

  const nextSlides = slides.filter((_, slideIndex) => slideIndex !== index);
  return commitDocument(state, replaceSlides(state.document, nextSlides));
}

function duplicate(
  state: EditorState,
  command: Extract<EditorCommand, { type: "slide/duplicate" }>,
) {
  const { slides } = state.document;
  const sourceIndex = slides.findIndex((slide) => slide.id === command.slideId);

  if (
    slides.length >= MAX_SLIDE_COUNT ||
    sourceIndex < 0 ||
    slides.some((slide) => slide.id === command.duplicateId)
  ) {
    return state;
  }

  const duplicatedSlide: Slide = {
    ...structuredClone(slides[sourceIndex]),
    id: command.duplicateId,
    revision: 1,
    role: "content",
  };
  const insertionIndex = Math.min(sourceIndex + 1, slides.length - 1);
  const nextSlides = [...slides];
  nextSlides.splice(insertionIndex, 0, duplicatedSlide);
  return commitDocument(state, replaceSlides(state.document, nextSlides));
}

function move(
  state: EditorState,
  command: Extract<EditorCommand, { type: "slide/move" }>,
) {
  const { slides } = state.document;
  const sourceIndex = slides.findIndex((slide) => slide.id === command.slideId);

  if (
    sourceIndex < 0 ||
    slides[sourceIndex].role !== "content" ||
    !Number.isInteger(command.toIndex) ||
    command.toIndex < 1 ||
    command.toIndex > slides.length - 2 ||
    sourceIndex === command.toIndex
  ) {
    return state;
  }

  const nextSlides = [...slides];
  const [slide] = nextSlides.splice(sourceIndex, 1);
  nextSlides.splice(command.toIndex, 0, slide);
  return commitDocument(state, replaceSlides(state.document, nextSlides));
}

function undoHistory(state: EditorState): EditorState {
  const previous = state.past.at(-1);
  if (!previous) {
    return state;
  }

  return {
    document: previous,
    past: state.past.slice(0, -1),
    future: [state.document, ...state.future],
  };
}

function redoHistory(state: EditorState): EditorState {
  const next = state.future[0];
  if (!next) {
    return state;
  }

  return {
    document: next,
    past: appendEditorHistory(state.past, state.document),
    future: state.future.slice(1),
  };
}

export function editorReducer(
  state: EditorState,
  command: EditorCommand,
): EditorState {
  switch (command.type) {
    case "slide/add":
      return add(state, command);
    case "slide/delete":
      return remove(state, command);
    case "slide/duplicate":
      return duplicate(state, command);
    case "slide/move":
      return move(state, command);
    case "history/undo":
      return undoHistory(state);
    case "history/redo":
      return redoHistory(state);
  }
}
