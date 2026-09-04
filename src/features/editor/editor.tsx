"use client";

import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  sortableKeyboardCoordinates,
  SortableContext,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { useState } from "react";
import { Button, Panel, PanelBody, PanelHeader } from "../../components/ui";
import {
  MAX_SLIDE_COUNT,
  MIN_SLIDE_COUNT,
  carouselDocumentSchema,
  type CarouselDocument,
} from "../../domain/document";
import {
  getThemeId,
  themes,
  type AppearancePreview,
} from "../../render/templates";
import {
  SlideRenderer,
  type SlideRenderAsset,
} from "../../render/slide";
import {
  addSlide,
  deleteSlide,
  duplicateSlide,
  moveSlide,
  redo,
  undo,
  type EditorCommand,
  type Slide,
} from "./commands";
import {
  createEditorState,
  editorReducer,
  type EditorState,
} from "./reducer";
import { SlidePanel } from "./slide-panel";
import { ThemePanel } from "./theme-panel";

const EMPTY_ASSETS: Readonly<Record<string, SlideRenderAsset | undefined>> = {};
const MODES: ReadonlyArray<{ id: Slide["mode"]; label: string }> = [
  { id: "text", label: "Text" },
  { id: "text_image", label: "Text + image" },
  { id: "image", label: "Image" },
  { id: "screenshot", label: "Screenshot" },
];

export interface EditorProps {
  readonly draftId: string;
  readonly initialDocument?: CarouselDocument;
  readonly assets?: Readonly<Record<string, SlideRenderAsset | undefined>>;
}

function paragraphText(slide: Slide): string {
  return slide.bodyBlocks
    .flatMap((block) => {
      if (block.kind === "bullets") {
        return block.items;
      }
      return [block.text];
    })
    .join("\n");
}

function replaceDocument(
  state: EditorState,
  document: CarouselDocument,
): EditorState {
  if (!carouselDocumentSchema.safeParse(document).success) {
    return state;
  }

  return {
    document,
    past: [...state.past, state.document],
    future: [],
  };
}

function updateSlide(
  state: EditorState,
  slideId: string,
  update: (slide: Slide) => Slide,
): EditorState {
  let changed = false;
  const slides = state.document.slides.map((slide) => {
    if (slide.id !== slideId) {
      return slide;
    }
    changed = true;
    const next = update(slide);
    return { ...next, revision: slide.revision + 1 };
  });

  return changed
    ? replaceDocument(state, { ...state.document, slides })
    : state;
}

export function reorderEditorState(
  state: EditorState,
  activeId: string,
  overId: string,
): EditorState {
  const toIndex = state.document.slides.findIndex((slide) => slide.id === overId);
  return toIndex < 0
    ? state
    : editorReducer(state, moveSlide(activeId, toIndex));
}

function createStarterDocument(): CarouselDocument {
  const content = (id: string, title: string, eyebrow: string | null): Slide => ({
    id,
    revision: 1,
    role: "content",
    mode: "text",
    layoutId: "numbered-point",
    eyebrow,
    title,
    bodyBlocks: [],
    cta: null,
    assetSlots: [],
    counterVisible: true,
    overrides: {},
  });

  return carouselDocumentSchema.parse({
    schemaVersion: 1,
    title: "Make one useful point at a time",
    platform: "linkedin",
    templateId: "paper",
    templateVersion: 1,
    theme: themes.paper.settings,
    brandSnapshot: null,
    slides: [
      {
        ...content("local-slide-01", "Make one useful point at a time", "WRITING"),
        role: "intro",
        layoutId: "intro-centered",
        counterVisible: false,
      },
      content("local-slide-02", "Lead with the conclusion", "01"),
      content("local-slide-03", "Give every page one job", "02"),
      content("local-slide-04", "Make the next step obvious", "03"),
      content("local-slide-05", "End before attention fades", "04"),
      {
        ...content("local-slide-06", "Build the next useful page.", null),
        role: "outro",
        layoutId: "outro-cta",
        cta: "Save this for your next carousel.",
        counterVisible: false,
      },
    ],
    caption: "",
    assetRefs: [],
  });
}

function uniqueSlideId(prefix: string): string {
  const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
  return `local-${prefix}-${random}`;
}

export function Editor({
  draftId,
  initialDocument,
  assets = EMPTY_ASSETS,
}: EditorProps) {
  const [state, setState] = useState(() =>
    createEditorState(initialDocument ?? createStarterDocument()),
  );
  const [selectedSlideId, setSelectedSlideId] = useState(
    () => state.document.slides[0].id,
  );
  const sensors = useSensors(
    useSensor(PointerSensor),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const selectedIndex = Math.max(
    0,
    state.document.slides.findIndex((slide) => slide.id === selectedSlideId),
  );
  const selectedSlide = state.document.slides[selectedIndex];
  const slideCount = state.document.slides.length;
  const atMaximum = slideCount >= MAX_SLIDE_COUNT;
  const atMinimum = slideCount <= MIN_SLIDE_COUNT;

  function applyCommand(command: EditorCommand) {
    const next = editorReducer(state, command);
    if (next === state) {
      return;
    }
    setState(next);
    if (!next.document.slides.some((slide) => slide.id === selectedSlideId)) {
      setSelectedSlideId(next.document.slides[0].id);
    }
  }

  function editSelected(update: (slide: Slide) => Slide) {
    setState((current) => updateSlide(current, selectedSlideId, update));
  }

  function reorder(activeId: string, overId: string) {
    setState((current) => reorderEditorState(current, activeId, overId));
  }

  function onDragEnd(event: DragEndEvent) {
    if (event.over && event.active.id !== event.over.id) {
      reorder(String(event.active.id), String(event.over.id));
    }
  }

  function addNewSlide() {
    if (atMaximum) {
      return;
    }
    const newSlide: Slide = {
      id: uniqueSlideId("slide"),
      revision: 1,
      role: "content",
      mode: "text",
      layoutId: themes[getThemeId(state.document)].layouts.content.text[0],
      eyebrow: null,
      title: "New slide",
      bodyBlocks: [],
      cta: null,
      assetSlots: [],
      counterVisible: true,
      overrides: {},
    };
    const next = editorReducer(state, addSlide(newSlide));
    if (next !== state) {
      setState(next);
      setSelectedSlideId(newSlide.id);
    }
  }

  function duplicateCurrent(slideId: string) {
    if (atMaximum) {
      return;
    }
    const duplicateId = uniqueSlideId("copy");
    const next = editorReducer(state, duplicateSlide(slideId, duplicateId));
    if (next !== state) {
      setState(next);
      setSelectedSlideId(duplicateId);
    }
  }

  function deleteCurrent(slideId: string) {
    const index = state.document.slides.findIndex((slide) => slide.id === slideId);
    const next = editorReducer(state, deleteSlide(slideId));
    if (next !== state) {
      setState(next);
      setSelectedSlideId(next.document.slides[Math.min(index, next.document.slides.length - 1)].id);
    }
  }

  function applyAppearance(preview: AppearancePreview) {
    setState((current) => replaceDocument(current, preview.document));
  }

  function selectMode(mode: Slide["mode"]) {
    editSelected((slide) => ({
      ...slide,
      mode,
      layoutId: themes[getThemeId(state.document)].layouts[slide.role][mode][0],
    }));
  }

  function selectAsset(assetId: string) {
    editSelected((slide) => {
      if (!assetId) {
        return { ...slide, assetSlots: [] };
      }
      const current = slide.assetSlots[0];
      return {
        ...slide,
        assetSlots: [
          {
            slotId: current?.slotId ?? `primary-${slide.id}`,
            assetId,
            fit: current?.fit ?? "cover",
            crop: current?.crop ?? { x: 0, y: 0, width: 1, height: 1 },
            opacity: current?.opacity ?? 1,
            alt: current?.alt ?? assets[assetId]?.alt ?? "",
          },
        ],
      };
    });
  }

  const currentSlot = selectedSlide.assetSlots[0];

  return (
    <div
      className="stack"
      data-draft-id={draftId}
      data-page="editor"
      style={{ gap: "var(--gap-md)" }}
    >
      <header className="row-between wrap">
        <div>
          <p className="eyebrow">Carousel editor</p>
          <h1 style={{ fontSize: 38 }}>Edit your carousel.</h1>
          <p className="lead" style={{ fontSize: 16, marginTop: 8 }}>
            Refine each slide before export.
          </p>
        </div>
        <div className="row">
          <Button
            disabled={state.past.length === 0}
            onClick={() => applyCommand(undo())}
            variant="ghost"
          >
            Undo
          </Button>
          <Button
            disabled={state.future.length === 0}
            onClick={() => applyCommand(redo())}
            variant="ghost"
          >
            Redo
          </Button>
        </div>
      </header>

      <div
        style={{
          alignItems: "start",
          display: "grid",
          gap: "var(--gap-md)",
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 280px), 1fr))",
        }}
      >
        <Panel aria-label="Slide content">
          <PanelHeader><h2 className="h3">Content</h2></PanelHeader>
          <PanelBody className="stack">
            <label className="field">
              <span>Eyebrow</span>
              <input
                className="input"
                onChange={(event) => editSelected((slide) => ({
                  ...slide,
                  eyebrow: event.target.value || null,
                }))}
                placeholder="Leave empty to hide"
                type="text"
                value={selectedSlide.eyebrow ?? ""}
              />
            </label>
            <label className="field">
              <span>Headline</span>
              <textarea
                className="textarea"
                onChange={(event) => editSelected((slide) => ({
                  ...slide,
                  title: event.target.value || null,
                }))}
                value={selectedSlide.title ?? ""}
              />
            </label>
            <label className="field">
              <span>Supporting line</span>
              <textarea
                className="textarea"
                onChange={(event) => {
                  const text = event.target.value;
                  editSelected((slide) => ({
                    ...slide,
                    bodyBlocks: text
                      ? [{ kind: "paragraph", text, emphasisRanges: [] }]
                      : [],
                  }));
                }}
                value={paragraphText(selectedSlide)}
              />
            </label>
            <label className="field">
              <span>Call to action</span>
              <input
                className="input"
                onChange={(event) => editSelected((slide) => ({
                  ...slide,
                  cta: event.target.value || null,
                }))}
                placeholder="Leave empty to hide"
                type="text"
                value={selectedSlide.cta ?? ""}
              />
            </label>
          </PanelBody>
        </Panel>

        <section aria-label="Canvas" className="stack" style={{ alignItems: "center" }}>
          <div style={{ maxWidth: 520, width: "100%" }}>
            <SlideRenderer
              input={{
                slide: selectedSlide,
                platform: state.document.platform,
                theme: state.document.theme,
                brandSnapshot: state.document.brandSnapshot,
                assets,
                slideNumber: selectedIndex + 1,
                slideCount,
              }}
            />
          </div>
          <p className="meta" aria-live="polite">
            Slide {selectedIndex + 1} of {slideCount} · {state.document.platform}
          </p>

          <Panel style={{ width: "100%" }}>
            <PanelHeader className="row-between">
              <h2 className="h3">{slideCount} slides</h2>
              <Button disabled={atMaximum} onClick={addNewSlide} size="small" variant="ghost">
                Add slide
              </Button>
            </PanelHeader>
            <PanelBody>
              <DndContext
                collisionDetection={closestCenter}
                onDragEnd={onDragEnd}
                sensors={sensors}
              >
                <SortableContext
                  items={state.document.slides.map((slide) => slide.id)}
                  strategy={verticalListSortingStrategy}
                >
                  <ol
                    aria-label="Slides"
                    style={{ display: "grid", gap: 8, listStyle: "none", margin: 0, padding: 0 }}
                  >
                    {state.document.slides.map((slide, index) => (
                      <SlidePanel
                        key={slide.id}
                        canDelete={!atMinimum && slide.role === "content"}
                        canDuplicate={!atMaximum}
                        canMoveDown={slide.role === "content" && index < slideCount - 2}
                        canMoveUp={slide.role === "content" && index > 1}
                        index={index}
                        onDelete={() => deleteCurrent(slide.id)}
                        onDuplicate={() => duplicateCurrent(slide.id)}
                        onMoveDown={() => reorder(slide.id, state.document.slides[index + 1].id)}
                        onMoveUp={() => reorder(slide.id, state.document.slides[index - 1].id)}
                        onSelect={() => setSelectedSlideId(slide.id)}
                        selected={slide.id === selectedSlide.id}
                        slide={slide}
                      />
                    ))}
                  </ol>
                </SortableContext>
              </DndContext>
            </PanelBody>
          </Panel>
        </section>

        <div className="stack">
          <Panel aria-label="Slide controls">
            <PanelHeader><h2 className="h3">Slide controls</h2></PanelHeader>
            <PanelBody className="stack">
              <fieldset>
                <legend>Slide mode</legend>
                {MODES.map((mode) => (
                  <label key={mode.id} style={{ display: "block", paddingBlock: 4 }}>
                    <input
                      checked={selectedSlide.mode === mode.id}
                      name="slide-mode"
                      onChange={() => selectMode(mode.id)}
                      type="radio"
                      value={mode.id}
                    />{" "}{mode.label}
                  </label>
                ))}
              </fieldset>

              {selectedSlide.mode === "text" ? null : (
                <>
                  <label className="field">
                    <span>Image slot</span>
                    <select
                      className="select"
                      onChange={(event) => selectAsset(event.target.value)}
                      value={currentSlot?.assetId ?? ""}
                    >
                      <option value="">No image selected</option>
                      {state.document.assetRefs.map((asset) => (
                        <option key={asset.id} value={asset.id}>{asset.id}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>Image alt text</span>
                    <input
                      className="input"
                      disabled={!currentSlot}
                      onChange={(event) => editSelected((slide) => ({
                        ...slide,
                        assetSlots: slide.assetSlots.map((slot, index) =>
                          index === 0 ? { ...slot, alt: event.target.value } : slot,
                        ),
                      }))}
                      type="text"
                      value={currentSlot?.alt ?? ""}
                    />
                  </label>
                </>
              )}

              <Button
                disabled={atMinimum || selectedSlide.role !== "content"}
                onClick={() => deleteCurrent(selectedSlide.id)}
                variant="danger"
              >
                Delete slide
              </Button>
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader><h2 className="h3">Appearance</h2></PanelHeader>
            <PanelBody>
              <ThemePanel document={state.document} onChange={applyAppearance} />
            </PanelBody>
          </Panel>
        </div>
      </div>
    </div>
  );
}
