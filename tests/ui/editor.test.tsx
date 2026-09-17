// @vitest-environment jsdom

import { cleanup, fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { IDBFactory } from "fake-indexeddb";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";

// 编辑器页外面套的是 WorkspaceShell，它的导航文案来自词条文件；
// 语言切换器用的 useRouter 在真实 SSR 里有挂载的 app router，jsdom 里没有。
// 这里只短路 router，外壳渲染出的文案仍然读真实的 messages/en.json。
vi.mock("next-intl/server", async () => (await import("../helpers/intl-server")).createIntlServerStub());
vi.mock("next/navigation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("next/navigation")>()),
  useRouter: () => ({ replace: () => {}, push: () => {}, refresh: () => {}, back: () => {}, forward: () => {}, prefetch: () => {} }),
  usePathname: () => "/editor/local-route-draft",
}));
// 编辑器里的每个子组件都从词条文件取文案，脱离 Provider 渲染会直接抛错。
// 用 RTL 的 wrapper 而不是手动套一层：rerender 会自动沿用 wrapper，手套的那层不会。
function render(ui: ReactNode, options?: Parameters<typeof renderBare>[1]) {
  return renderBare(ui as Parameters<typeof renderBare>[0], {
    ...options,
    wrapper: ({ children }) => <NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>,
  });
}

import fixture from "../fixtures/base-document.json";
import {
  MAX_SLIDE_COUNT,
  MIN_SLIDE_COUNT,
  parseCarouselDocument,
  type CarouselDocument,
} from "../../src/domain/document";
import {
  Editor,
  reorderEditorState,
  updateSupportingParagraph,
} from "../../src/features/editor/editor";
import { createEditorState } from "../../src/features/editor/reducer";
import {
  LocalDraftStore,
  type DraftOwner,
} from "../../src/features/editor/local-drafts";
import EditorPage from "../../src/app/[locale]/(workspace)/editor/[id]/page";

function documentFixture(): CarouselDocument {
  return parseCarouselDocument(structuredClone(fixture));
}

function withSlideCount(count: number): CarouselDocument {
  const document = documentFixture();
  const content = document.slides[1];
  document.slides = [
    structuredClone(document.slides[0]),
    ...Array.from({ length: count - 2 }, (_, index) => ({
      ...structuredClone(content),
      id: `local-content-${index + 1}`,
    })),
    { ...structuredClone(document.slides.at(-1)!), id: "local-outro" },
  ];
  return parseCarouselDocument(document);
}

function filmstripOrder(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll<HTMLElement>("[data-editor-slide-id]"))
    .map((element) => element.dataset.editorSlideId!);
}

afterEach(cleanup);

describe("Editor", () => {
  it("initializes and loads before saving, then restores edits after remount", async () => {
    const user = userEvent.setup();
    const store = new LocalDraftStore({
      indexedDB: new IDBFactory(),
      databaseName: "editor-remount",
    });
    const owner: DraftOwner = { kind: "anonymous", sessionId: "session-remount" };
    const first = render(
      <Editor
        draftId="local-remount"
        draftOwner={owner}
        draftStore={store}
        initialDocument={documentFixture()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("draft-status").textContent).toBe("Saved locally.");
    });
    await user.click(
      screen.getByRole("button", {
        name: "Slide 2: A carousel is not a chopped-up article.",
      }),
    );
    await user.clear(screen.getByLabelText("Headline"));
    await user.type(screen.getByLabelText("Headline"), "Recovered headline");
    await waitFor(async () => {
      expect((await store.loadDraft(owner, "local-remount"))?.document.slides[1].title)
        .toBe("Recovered headline");
    });
    first.unmount();

    render(
      <Editor
        draftId="local-remount"
        draftOwner={owner}
        draftStore={store}
        initialDocument={documentFixture()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Slide 2: Recovered headline" })).toBeTruthy();
    });
  });

  it("isolates the same draft ID by session and reports unavailable persistence without blocking edits", async () => {
    const user = userEvent.setup();
    const store = new LocalDraftStore({
      indexedDB: new IDBFactory(),
      databaseName: "editor-session-isolation",
    });
    const firstOwner: DraftOwner = { kind: "anonymous", sessionId: "session-a" };
    const secondOwner: DraftOwner = { kind: "anonymous", sessionId: "session-b" };
    const firstDocument = documentFixture();
    firstDocument.slides[1].title = "Only session A";
    await store.saveDraft(firstOwner, "local-shared", parseCarouselDocument(firstDocument));

    const isolated = render(
      <Editor
        draftId="local-shared"
        draftOwner={secondOwner}
        draftStore={store}
        initialDocument={documentFixture()}
      />,
    );
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Slide 2: Only session A" })).toBeNull();
      expect(screen.getByTestId("draft-status").textContent).toBe("Saved locally.");
    });
    isolated.unmount();

    render(
      <Editor
        draftId="local-unavailable"
        draftStore={null}
        initialDocument={documentFixture()}
      />,
    );
    await waitFor(() => {
      expect(screen.getByTestId("draft-status").textContent).toContain(
        "Local draft unavailable",
      );
    });
    await user.clear(screen.getByLabelText("Headline"));
    await user.type(screen.getByLabelText("Headline"), "Still editable");
    expect(screen.getByRole("heading", { name: "Still editable" })).toBeTruthy();
  });

  it("edits only the explicit paragraph while preserving other blocks and source references", () => {
    const slide = structuredClone(documentFixture().slides[1]);
    slide.bodyBlocks = [
      {
        kind: "bullets",
        items: ["Keep this bullet"],
        sourceRefs: [{
          sourceId: "local-source",
          segmentId: "local-segment",
          kind: "paraphrase",
        }],
      },
      {
        kind: "paragraph",
        text: "Original paragraph",
        emphasisRanges: [{ start: 0, end: 8 }],
        sourceRefs: [{
          sourceId: "local-source",
          segmentId: "local-paragraph",
          kind: "paraphrase",
        }],
      },
      {
        kind: "quote",
        text: "Keep this quote",
        attribution: "Source",
        sourceRefs: [{
          sourceId: "local-source",
          segmentId: "local-quote",
          kind: "quote",
        }],
      },
    ];

    const updated = updateSupportingParagraph(slide, "Short");

    expect(updated.bodyBlocks[0]).toEqual(slide.bodyBlocks[0]);
    expect(updated.bodyBlocks[2]).toEqual(slide.bodyBlocks[2]);
    expect(updated.bodyBlocks[1]).toEqual({
      ...slide.bodyBlocks[1],
      text: "Short",
      emphasisRanges: [{ start: 0, end: 5 }],
    });
  });

  it("edits eyebrow, headline, supporting copy and CTA on only the selected slide", async () => {
    const user = userEvent.setup();
    const document = documentFixture();
    const { container } = render(
      <Editor draftId="local-editor-test" initialDocument={document} />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Slide 2: A carousel is not a chopped-up article.",
      }),
    );
    await user.type(screen.getByLabelText("Eyebrow"), "POINT");
    await user.clear(screen.getByLabelText("Headline"));
    await user.type(screen.getByLabelText("Headline"), "One page, one job");
    await user.clear(screen.getByLabelText("Supporting line"));
    await user.type(screen.getByLabelText("Supporting line"), "Keep the reader moving.");
    await user.type(screen.getByLabelText("Call to action"), "Continue");

    const preview = container.querySelector<HTMLElement>(
      '[data-slide-id="local-slide-02"]',
    );
    expect(preview?.textContent).toContain("POINT");
    expect(preview?.textContent).toContain("One page, one job");
    expect(preview?.textContent).toContain("Keep the reader moving.");
    expect(preview?.textContent).toContain("Continue");

    await user.click(screen.getByRole("button", { name: "Slide 3: Lead with the conclusion" }));
    expect((screen.getByLabelText("Headline") as HTMLTextAreaElement).value).toBe(
      "Lead with the conclusion",
    );
    await user.click(screen.getByRole("button", { name: "Slide 2: One page, one job" }));
    expect((screen.getByLabelText("Supporting line") as HTMLTextAreaElement).value).toBe(
      "Keep the reader moving.",
    );
  });

  it("keeps mode and image-slot edits isolated while rendering all four modes", async () => {
    const user = userEvent.setup();
    const document = documentFixture();
    document.assetRefs = [
      {
        id: "local-asset-01",
        kind: "upload",
        mimeType: "image/png",
        rightsStatus: "user_asserted",
      },
      {
        id: "local-asset-02",
        kind: "upload",
        mimeType: "image/png",
        rightsStatus: "user_asserted",
      },
      {
        id: "local-asset-03",
        kind: "upload",
        mimeType: "image/png",
        rightsStatus: "user_asserted",
      },
    ];
    document.slides[1].assetSlots = [
      {
        slotId: "primary",
        assetId: "local-asset-01",
        fit: "cover",
        crop: { x: 0, y: 0, width: 1, height: 1 },
        opacity: 1,
        alt: "Notebook",
      },
      {
        slotId: "secondary",
        assetId: "local-asset-02",
        fit: "contain",
        crop: { x: 0, y: 0, width: 1, height: 1 },
        opacity: 0.7,
        alt: "Second image",
      },
    ];
    const store = new LocalDraftStore({
      indexedDB: new IDBFactory(),
      databaseName: "editor-image-slots",
    });
    const owner: DraftOwner = { kind: "anonymous", sessionId: "session-images" };
    const { container } = render(
      <Editor
        draftId="local-image-test"
        draftOwner={owner}
        draftStore={store}
        initialDocument={parseCarouselDocument(document)}
        assets={{
          "local-asset-01": {
            id: "local-asset-01",
            src: "data:image/png;base64,iVBORw0KGgo=",
            state: "ready",
            alt: "Notebook",
          },
          "local-asset-03": {
            id: "local-asset-03",
            src: "data:image/png;base64,iVBORw0KGgo=",
            state: "ready",
            alt: "Replacement",
          },
        }}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: "Slide 2: A carousel is not a chopped-up article.",
      }),
    );
    for (const label of ["Text + image", "Image", "Screenshot", "Text"]) {
      await user.click(screen.getByRole("radio", { name: label }));
      expect(
        container.querySelector('[data-slide-id="local-slide-02"]')?.getAttribute("data-mode"),
      ).toBe(
        label === "Text + image" ? "text_image" : label.toLowerCase(),
      );
    }

    await user.click(screen.getByRole("radio", { name: "Text + image" }));
    await user.selectOptions(screen.getByLabelText("Image slot"), "local-asset-03");
    await user.clear(screen.getByLabelText("Image alt text"));
    await user.type(screen.getByLabelText("Image alt text"), "Open notebook");
    expect(
      container.querySelector<HTMLImageElement>(
        '[data-slide-id="local-slide-02"] img[data-asset-id="local-asset-03"]',
      )?.alt,
    ).toBe("Open notebook");
    await waitFor(async () => {
      const saved = await store.loadDraft(owner, "local-image-test");
      expect(saved?.document.slides[1].assetSlots).toEqual([
        expect.objectContaining({
          slotId: "primary",
          assetId: "local-asset-03",
          alt: "Open notebook",
        }),
        document.slides[1].assetSlots[1],
      ]);
    });

    await user.click(screen.getByRole("button", { name: "Slide 3: Lead with the conclusion" }));
    expect((screen.getByRole("radio", { name: "Text" }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByLabelText("Image slot")).toBeNull();
  });

  it("enforces the four-to-twelve operation boundaries", async () => {
    const user = userEvent.setup();
    const minimum = render(
      <Editor draftId="local-min" initialDocument={withSlideCount(MIN_SLIDE_COUNT)} />,
    );
    await user.click(screen.getByRole("button", { name: /^Slide 2:/ }));
    expect((screen.getByRole("button", { name: "Delete slide 2" }) as HTMLButtonElement).disabled).toBe(true);
    minimum.unmount();

    render(<Editor draftId="local-max" initialDocument={withSlideCount(MAX_SLIDE_COUNT)} />);
    await user.click(screen.getByRole("button", { name: /^Slide 2:/ }));
    expect((screen.getByRole("button", { name: "Add slide" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Duplicate slide 2" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("wires add, duplicate and delete controls without disturbing the boundary slides", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <Editor draftId="local-operations" initialDocument={documentFixture()} />,
    );

    const originalOrder = filmstripOrder(container);
    await user.click(screen.getByRole("button", { name: "Duplicate slide 2" }));
    const duplicatedOrder = filmstripOrder(container);
    expect(duplicatedOrder).toHaveLength(7);
    expect(duplicatedOrder[0]).toBe(originalOrder[0]);
    expect(duplicatedOrder.at(-1)).toBe(originalOrder.at(-1));
    expect(duplicatedOrder[2]).not.toBe(originalOrder[1]);

    await user.click(screen.getByRole("button", { name: "Delete slide 3" }));
    expect(filmstripOrder(container)).toEqual(originalOrder);

    await user.click(screen.getByRole("button", { name: "Add slide" }));
    const addedOrder = filmstripOrder(container);
    expect(addedOrder).toHaveLength(7);
    expect(addedOrder.slice(0, -2)).toEqual(originalOrder.slice(0, -1));
    expect(addedOrder.at(-1)).toBe(originalOrder.at(-1));
  });

  it("activates dnd-kit KeyboardSensor and matches the explicit move path without crossing boundaries", async () => {
    const user = userEvent.setup();
    const document = documentFixture();
    const slideIds = document.slides.map((slide) => slide.id);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function getBoundingClientRect(this: HTMLElement) {
        const item = this.closest<HTMLElement>("[data-editor-slide-id]");
        const index = item ? slideIds.indexOf(item.dataset.editorSlideId!) : 0;
        const top = Math.max(0, index) * 100;
        return {
          bottom: top + 80,
          height: 80,
          left: 0,
          right: 100,
          top,
          width: 100,
          x: 0,
          y: top,
          toJSON: () => undefined,
        };
      },
    );
    const expected = reorderEditorState(
      createEditorState(document),
      "local-slide-04",
      "local-slide-03",
    ).document.slides.map((slide) => slide.id);
    const keyboardView = render(
      <Editor draftId="local-order" initialDocument={document} />,
    );

    const dragHandle = screen.getByRole("button", { name: "Drag slide 4" });
    dragHandle.focus();
    fireEvent.keyDown(dragHandle, { code: "Space", key: " " });
    await waitFor(() => {
      expect(globalThis.document.body.textContent).toContain(
        "Draggable item local-slide-04",
      );
    });
    fireEvent.keyDown(globalThis.document, { code: "ArrowUp", key: "ArrowUp" });
    fireEvent.keyDown(globalThis.document, { code: "Space", key: " " });
    await waitFor(() => {
      expect(filmstripOrder(keyboardView.container)).toEqual(expected);
    });
    const keyboardOrder = filmstripOrder(keyboardView.container);
    expect(filmstripOrder(keyboardView.container)[0]).toBe("local-slide-01");
    expect(filmstripOrder(keyboardView.container).at(-1)).toBe("local-slide-06");
    keyboardView.unmount();

    const explicitView = render(
      <Editor draftId="local-order-buttons" initialDocument={document} />,
    );
    await user.click(screen.getByRole("button", { name: "Move slide 4 up" }));
    expect(filmstripOrder(explicitView.container)).toEqual(keyboardOrder);
  });

  it("declares the approved desktop columns and a single-column canvas-first breakpoint", () => {
    const { container } = render(
      <Editor draftId="local-layout" initialDocument={documentFixture()} />,
    );
    const layout = container.querySelector("style[data-editor-layout]")?.textContent ?? "";

    expect(layout).toContain("grid-template-columns: minmax(0, 0.8fr) minmax(0, 1.4fr) minmax(0, 0.8fr)");
    expect(layout).toContain("@media (max-width: 1000px)");
    expect(layout).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(layout).toContain(".editor-canvas { grid-column: 1; grid-row: 1; }");
    expect(layout).toContain(".editor-content { grid-column: 1; grid-row: 2; }");
    expect(layout).toContain(".editor-controls { grid-column: 1; grid-row: 3; }");
  });
});

describe("editor route", () => {
  it("renders a real parameterized editor page", async () => {
    const page = await EditorPage({
      params: Promise.resolve({ id: "local-route-draft" }),
    });
    const { container } = render(page);

    expect(container.querySelector('[data-page="editor"]')).toBeTruthy();
    expect(container.querySelector('[data-draft-id="local-route-draft"]')).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Edit your carousel." })).toBeTruthy();
  });
});
