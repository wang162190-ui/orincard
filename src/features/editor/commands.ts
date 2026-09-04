import type { CarouselDocument } from "../../domain/document";

export type Slide = CarouselDocument["slides"][number];

export type EditorCommand =
  | { readonly type: "slide/add"; readonly slide: Slide; readonly index?: number }
  | { readonly type: "slide/delete"; readonly slideId: string }
  | {
      readonly type: "slide/duplicate";
      readonly slideId: string;
      readonly duplicateId: string;
    }
  | {
      readonly type: "slide/move";
      readonly slideId: string;
      readonly toIndex: number;
    }
  | { readonly type: "history/undo" }
  | { readonly type: "history/redo" };

export function addSlide(slide: Slide, index?: number): EditorCommand {
  return { type: "slide/add", slide, index };
}

export function deleteSlide(slideId: string): EditorCommand {
  return { type: "slide/delete", slideId };
}

export function duplicateSlide(
  slideId: string,
  duplicateId: string,
): EditorCommand {
  return { type: "slide/duplicate", slideId, duplicateId };
}

export function moveSlide(slideId: string, toIndex: number): EditorCommand {
  return { type: "slide/move", slideId, toIndex };
}

export function undo(): EditorCommand {
  return { type: "history/undo" };
}

export function redo(): EditorCommand {
  return { type: "history/redo" };
}
