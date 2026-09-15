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
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
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
  appendEditorHistory,
  createEditorState,
  editorReducer,
  type EditorState,
} from "./reducer";
import {
  LocalDraftStore,
  type DraftOwner,
} from "./local-drafts";
import { EditorOnboarding } from "./onboarding";
import { SlidePanel } from "./slide-panel";
import { AssistantPanel } from "./assistant";
import { ThemePanel } from "./theme-panel";
import { EditorMedia } from "../assets/editor-media";
import { VersionHistory } from "./versions";

const EMPTY_ASSETS: Readonly<Record<string, SlideRenderAsset | undefined>> = {};
const MODES: ReadonlyArray<{ id: Slide["mode"]; messageKey: string }> = [
  { id: "text", messageKey: "modeText" },
  { id: "text_image", messageKey: "modeTextImage" },
  { id: "image", messageKey: "modeImage" },
  { id: "screenshot", messageKey: "modeScreenshot" },
];

export interface EditorProps {
  readonly draftId: string;
  readonly initialDocument?: CarouselDocument;
  readonly projectRevision?: number;
  readonly assets?: Readonly<Record<string, SlideRenderAsset | undefined>>;
  readonly draftOwner?: DraftOwner;
  readonly draftStore?: EditorDraftStore | null;
}

export type EditorDraftStore = Pick<
  LocalDraftStore,
  "initialize" | "loadDraft" | "saveDraft" | "close"
>;

type DraftStatus = "loading" | "saving" | "saved" | "unavailable";

const SESSION_OWNER_KEY = "orincard-anonymous-session";

function browserDraftOwner(): DraftOwner {
  const storage = globalThis.localStorage;
  let sessionId = storage.getItem(SESSION_OWNER_KEY);
  if (!sessionId) {
    const random = globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`;
    sessionId = `session-${random}`;
    storage.setItem(SESSION_OWNER_KEY, sessionId);
  }
  return { kind: "anonymous", sessionId };
}

function supportingParagraphText(slide: Slide): string {
  const paragraph = slide.bodyBlocks.find((block) => block.kind === "paragraph");
  return paragraph?.text ?? "";
}

export function updateSupportingParagraph(slide: Slide, text: string): Slide {
  const paragraphIndex = slide.bodyBlocks.findIndex(
    (block) => block.kind === "paragraph",
  );
  if (paragraphIndex < 0) {
    return text
      ? {
          ...slide,
          bodyBlocks: [
            ...slide.bodyBlocks,
            { kind: "paragraph", text, emphasisRanges: [] },
          ],
        }
      : slide;
  }

  if (!text) {
    return {
      ...slide,
      bodyBlocks: slide.bodyBlocks.filter((_, index) => index !== paragraphIndex),
    };
  }

  const textLength = Array.from(text).length;
  return {
    ...slide,
    bodyBlocks: slide.bodyBlocks.map((block, index) => {
      if (index !== paragraphIndex || block.kind !== "paragraph") {
        return block;
      }
      const emphasisRanges = block.emphasisRanges.flatMap((range) => {
        const start = Math.min(range.start, textLength);
        const end = Math.min(range.end, textLength);
        return end > start ? [{ start, end }] : [];
      });
      return { ...block, text, emphasisRanges };
    }),
  };
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
    past: appendEditorHistory(state.past, state.document),
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

// 起始文档是空白编辑器里唯一的内容，中文用户第一眼看到的是它。
// 它是内容不是界面 chrome，但同样要跟着语言走，所以翻译函数从组件传进来。
function createStarterDocument(t: (key: string) => string): CarouselDocument {
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
    title: t("starterTitle"),
    platform: "linkedin",
    templateId: "paper",
    templateVersion: 1,
    theme: themes.paper.settings,
    brandSnapshot: null,
    slides: [
      {
        ...content("local-slide-01", t("starterTitle"), t("starterEyebrow")),
        role: "intro",
        layoutId: "intro-centered",
        counterVisible: false,
      },
      content("local-slide-02", t("starterSlide2"), "01"),
      content("local-slide-03", t("starterSlide3"), "02"),
      content("local-slide-04", t("starterSlide4"), "03"),
      content("local-slide-05", t("starterSlide5"), "04"),
      {
        ...content("local-slide-06", t("starterOutro"), null),
        role: "outro",
        layoutId: "outro-cta",
        cta: t("starterCta"),
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
  projectRevision,
  assets = EMPTY_ASSETS,
  draftOwner,
  draftStore,
}: EditorProps) {
  const t = useTranslations("Editor");
  const [state, setState] = useState(() =>
    createEditorState(initialDocument ?? createStarterDocument(t)),
  );
  const [selectedSlideId, setSelectedSlideId] = useState(
    () => state.document.slides[0].id,
  );
  const [draftContext, setDraftContext] = useState<{
    readonly owner: DraftOwner;
    readonly store: EditorDraftStore;
  } | null>(null);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>("loading");
  const [libraryAssets, setLibraryAssets] = useState<Readonly<Record<string, SlideRenderAsset>>>({});
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

  useEffect(() => {
    let active = true;
    let ownedStore: EditorDraftStore | null = null;
    setDraftContext(null);
    setDraftStatus("loading");

    async function loadDraft() {
      try {
        if (draftStore === null) {
          throw new Error("Local draft storage was disabled.");
        }
        const owner = draftOwner ?? browserDraftOwner();
        const store = draftStore ?? new LocalDraftStore();
        if (draftStore === undefined) {
          ownedStore = store;
        }
        await store.initialize();
        const saved = await store.loadDraft(owner, draftId);
        if (!active) {
          return;
        }
        if (saved) {
          setState(createEditorState(saved.document));
          setSelectedSlideId(saved.document.slides[0].id);
        }
        setDraftContext({ owner, store });
        setDraftStatus(saved ? "saved" : "saving");
      } catch {
        if (active) {
          setDraftStatus("unavailable");
        }
      }
    }

    void loadDraft();
    return () => {
      active = false;
      if (ownedStore) {
        void ownedStore.close();
      }
    };
  }, [draftId, draftOwner, draftStore]);

  useEffect(() => {
    if (!draftContext) {
      return;
    }
    let active = true;
    setDraftStatus("saving");
    void draftContext.store
      .saveDraft(draftContext.owner, draftId, state.document)
      .then(() => {
        if (active) {
          setDraftStatus("saved");
        }
      })
      .catch(() => {
        if (active) {
          setDraftStatus("unavailable");
          setDraftContext(null);
        }
      });
    return () => {
      active = false;
    };
  }, [draftContext, draftId, state.document]);

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
      title: t("newSlide"),
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
      const current = slide.assetSlots[0];
      if (!assetId) {
        return {
          ...slide,
          assetSlots: current ? slide.assetSlots.slice(1) : slide.assetSlots,
        };
      }
      const nextSlot = {
        slotId: current?.slotId ?? `primary-${slide.id}`,
        assetId,
        fit: current?.fit ?? "cover",
        crop: current?.crop ?? { x: 0, y: 0, width: 1, height: 1 },
        opacity: current?.opacity ?? 1,
        alt: current?.alt ?? assets[assetId]?.alt ?? "",
      } satisfies Slide["assetSlots"][number];
      return {
        ...slide,
        assetSlots: current
          ? [nextSlot, ...slide.assetSlots.slice(1)]
          : [nextSlot, ...slide.assetSlots],
      };
    });
  }

  const currentSlot = selectedSlide.assetSlots[0];
  const renderAssets = { ...assets, ...libraryAssets };

  return (
    <div
      className="stack"
      data-draft-id={draftId}
      data-page="editor"
      style={{ gap: "var(--gap-md)" }}
    >
      <header className="row-between wrap">
        <div>
          <p className="eyebrow">{t("eyebrow")}</p>
          <h1 style={{ fontSize: 38 }}>{t("heading")}</h1>
          <p className="lead" style={{ fontSize: 16, marginTop: 8 }}>
            {t("lead")}
          </p>
        </div>
        <div className="row">
          <p className="meta" data-testid="draft-status" role="status">
            {draftStatus === "loading" ? t("draftLoading") : null}
            {draftStatus === "saving" ? t("draftSaving") : null}
            {draftStatus === "saved" ? t("draftSaved") : null}
            {draftStatus === "unavailable"
              ? t("draftUnavailable")
              : null}
          </p>
          <Button
            disabled={state.past.length === 0}
            onClick={() => applyCommand(undo())}
            variant="ghost"
          >
            {t("undo")}
          </Button>
          <Button
            disabled={state.future.length === 0}
            onClick={() => applyCommand(redo())}
            variant="ghost"
          >
            {t("redo")}
          </Button>
        </div>
      </header>

      <style data-editor-layout>{`
        .editor-workbench {
          align-items: start;
          display: grid;
          gap: var(--gap-md);
          grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.4fr) minmax(0, 0.8fr);
        }
        .editor-content { grid-column: 1; grid-row: 1; }
        .editor-canvas { grid-column: 2; grid-row: 1; min-width: 0; }
        .editor-controls { grid-column: 3; grid-row: 1; min-width: 0; }
        .editor-workbench .field {
          display: flex;
          flex-direction: column;
          gap: 6px;
          color: var(--muted);
          font-size: 13px;
        }
        .editor-workbench .input,
        .editor-workbench .textarea,
        .editor-workbench .select {
          width: 100%;
          padding: 9px 13px;
          border: 1px solid var(--border);
          border-radius: var(--radius);
          background: var(--surface);
          color: var(--fg);
          font: inherit;
          font-size: 14px;
        }
        .editor-workbench .textarea {
          min-height: 82px;
          resize: vertical;
          line-height: 1.5;
        }
        .editor-workbench .input:focus,
        .editor-workbench .textarea:focus,
        .editor-workbench .select:focus {
          outline: none;
          border-color: var(--focus);
          box-shadow: 0 0 0 3px var(--focus-soft);
        }
        .editor-workbench fieldset {
          min-width: 0;
          margin: 0;
          padding: 12px;
          border: 1px solid var(--border);
          border-radius: var(--radius);
        }
        .editor-workbench legend {
          padding-inline: 5px;
          color: var(--muted);
          font-size: 12px;
        }
        .editor-filmstrip {
          display: flex;
          gap: 10px;
          margin: 0;
          padding: 0 0 6px;
          overflow-x: auto;
          list-style: none;
        }
        .theme-panel,
        .theme-panel__themes,
        .theme-panel__platforms {
          display: flex;
          flex-wrap: wrap;
          gap: 8px;
        }
        .theme-panel { flex-direction: column; gap: 14px; }
        .theme-panel__option,
        .theme-panel__platforms label {
          display: inline-flex;
          align-items: center;
          gap: 5px;
          color: var(--fg);
          font-size: 13px;
        }
        .theme-panel__option [data-theme-preview] {
          width: 14px;
          height: 14px;
          border: 1px solid var(--fg-line);
          border-radius: 50%;
          background: var(--tpl-paper-bg);
        }
        .theme-panel__option [data-theme-preview="ink"] { background: var(--tpl-ink-bg); }
        .theme-panel__option [data-theme-preview="signal"] { background: var(--tpl-signal-bg); }
        .theme-panel__option [data-theme-preview="blush"] { background: var(--tpl-blush-bg); }
        .theme-panel__option [data-theme-preview="butter"] { background: var(--tpl-butter-bg); }
        .theme-panel__option [data-theme-preview="sky"] { background: var(--tpl-sky-bg); }
        .theme-panel [role="status"] p { margin: 0; color: var(--muted); font-size: 12px; }
        @media (max-width: 1000px) {
          .editor-workbench { grid-template-columns: minmax(0, 1fr); }
          .editor-canvas { grid-column: 1; grid-row: 1; }
          .editor-content { grid-column: 1; grid-row: 2; }
          .editor-controls { grid-column: 1; grid-row: 3; }
        }
      `}</style>
      <EditorOnboarding />
      <div className="editor-workbench">
        <Panel aria-label={t("slideContent")} className="editor-content">
          <PanelHeader><h2 className="h3">{t("content")}</h2></PanelHeader>
          <PanelBody className="stack">
            <label className="field">
              <span>{t("eyebrowField")}</span>
              <input
                className="input"
                onChange={(event) => editSelected((slide) => ({
                  ...slide,
                  eyebrow: event.target.value || null,
                }))}
                placeholder={t("leaveEmpty")}
                type="text"
                value={selectedSlide.eyebrow ?? ""}
              />
            </label>
            <label className="field">
              <span>{t("headline")}</span>
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
              <span>{t("supporting")}</span>
              <textarea
                className="textarea"
                onChange={(event) => {
                  const text = event.target.value;
                  editSelected((slide) => ({
                    ...slide,
                    ...updateSupportingParagraph(slide, text),
                  }));
                }}
                value={supportingParagraphText(selectedSlide)}
              />
            </label>
            <label className="field">
              <span>{t("cta")}</span>
              <input
                className="input"
                onChange={(event) => editSelected((slide) => ({
                  ...slide,
                  cta: event.target.value || null,
                }))}
                placeholder={t("leaveEmpty")}
                type="text"
                value={selectedSlide.cta ?? ""}
              />
            </label>
          </PanelBody>
        </Panel>

        <section aria-label={t("canvas")} className="editor-canvas stack" style={{ alignItems: "center" }}>
          <div style={{ maxWidth: 520, width: "100%" }}>
            <SlideRenderer
              input={{
                slide: selectedSlide,
                platform: state.document.platform,
                theme: state.document.theme,
                brandSnapshot: state.document.brandSnapshot,
                assets: renderAssets,
                slideNumber: selectedIndex + 1,
                slideCount,
              }}
            />
          </div>
          <p className="meta" aria-live="polite">
            {t("slideOf", { current: selectedIndex + 1, total: slideCount, platform: state.document.platform })}
          </p>

          <Panel style={{ width: "100%" }}>
            <PanelHeader className="row-between">
              <h2 className="h3">{t("slideCount", { count: slideCount })}</h2>
              <Button disabled={atMaximum} onClick={addNewSlide} size="small" variant="ghost">
                {t("addSlide")}
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
                    aria-label={t("slides")}
                    className="editor-filmstrip"
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

        <div className="editor-controls stack">
          <Panel aria-label={t("slideControls")}>
            <PanelHeader><h2 className="h3">{t("slideControls")}</h2></PanelHeader>
            <PanelBody className="stack">
              <fieldset>
                <legend>{t("slideMode")}</legend>
                {MODES.map((mode) => (
                  <label key={mode.id} style={{ display: "block", paddingBlock: 4 }}>
                    <input
                      checked={selectedSlide.mode === mode.id}
                      name="slide-mode"
                      onChange={() => selectMode(mode.id)}
                      type="radio"
                      value={mode.id}
                    />{" "}{t(mode.messageKey)}
                  </label>
                ))}
              </fieldset>

              {selectedSlide.mode === "text" ? null : (
                <>
                  <label className="field">
                    <span>{t("imageSlot")}</span>
                    <select
                      className="select"
                      onChange={(event) => selectAsset(event.target.value)}
                      value={currentSlot?.assetId ?? ""}
                    >
                      <option value="">{t("noImage")}</option>
                      {state.document.assetRefs.map((asset) => (
                        <option key={asset.id} value={asset.id}>{asset.id}</option>
                      ))}
                    </select>
                  </label>
                  <label className="field">
                    <span>{t("imageAlt")}</span>
                    <input
                      className="input"
                      disabled={!currentSlot}
                      onChange={(event) => editSelected((slide) => ({
                        ...slide,
                        assetSlots: slide.assetSlots.map((slot) =>
                          slot.slotId === currentSlot?.slotId
                            ? { ...slot, alt: event.target.value }
                            : slot,
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
                {t("deleteSlide")}
              </Button>
            </PanelBody>
          </Panel>

          <Panel aria-label={t("mediaLibrary")}>
            <PanelBody>
              <EditorMedia
                document={state.document}
                onDocumentChange={(document) => setState((current) => replaceDocument(current, document))}
                onRenderAssetsChange={(next) => setLibraryAssets((current) => ({ ...current, ...next }))}
                selectedSlideId={selectedSlideId}
              />
            </PanelBody>
          </Panel>

          <Panel>
            <PanelHeader><h2 className="h3">{t("appearance")}</h2></PanelHeader>
            <PanelBody>
              <ThemePanel document={state.document} onChange={applyAppearance} />
            </PanelBody>
          </Panel>

          {/* 助手只在云端项目上出现：它要一个真实的 revision 才能安全地 apply，
              本地草稿（local-generated-*）既没有 revision 也没有可写的服务端项目。 */}
          {draftOwner?.kind === "account" && projectRevision ? (
            <AssistantPanel
              projectId={draftId}
              projectRevision={projectRevision}
              selectedSlideId={selectedSlideId}
            />
          ) : null}

          {draftOwner?.kind === "account" && projectRevision ? <VersionHistory projectId={draftId} revision={projectRevision} /> : null}
        </div>
      </div>
    </div>
  );
}
