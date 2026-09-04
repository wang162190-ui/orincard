// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
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
} from "../../src/features/editor/editor";
import { createEditorState } from "../../src/features/editor/reducer";
import EditorPage from "../../src/app/editor/[id]/page";

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
    ];
    const { container } = render(
      <Editor
        draftId="local-image-test"
        initialDocument={parseCarouselDocument(document)}
        assets={{
          "local-asset-01": {
            id: "local-asset-01",
            src: "data:image/png;base64,iVBORw0KGgo=",
            state: "ready",
            alt: "Notebook",
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
    await user.selectOptions(screen.getByLabelText("Image slot"), "local-asset-01");
    await user.clear(screen.getByLabelText("Image alt text"));
    await user.type(screen.getByLabelText("Image alt text"), "Open notebook");
    expect(
      container.querySelector<HTMLImageElement>(
        '[data-slide-id="local-slide-02"] img[data-asset-id="local-asset-01"]',
      )?.alt,
    ).toBe("Open notebook");

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

  it("uses the same reorder result for the dnd target path and keyboard move button", async () => {
    const user = userEvent.setup();
    const document = documentFixture();
    const expected = reorderEditorState(
      createEditorState(document),
      "local-slide-04",
      "local-slide-03",
    ).document.slides.map((slide) => slide.id);
    const { container } = render(
      <Editor draftId="local-order" initialDocument={document} />,
    );

    await user.click(screen.getByRole("button", { name: "Move slide 4 up" }));
    expect(filmstripOrder(container)).toEqual(expected);
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
