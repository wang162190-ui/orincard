// @vitest-environment jsdom

import { cleanup, render as renderBare, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import messages from "../../messages/en.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/base-document.json";
import {
  THEME_IDS,
  themes,
  previewAppearance,
  type AppearancePreview,
} from "../../src/render/templates";
import { ThemePanel } from "../../src/features/editor/theme-panel";
import { parseCarouselDocument } from "../../src/domain/document";

// ThemePanel 的文案来自词条文件，脱离 Provider 渲染会直接抛错。
function render(ui: ReactNode, options?: Parameters<typeof renderBare>[1]) {
  return renderBare(ui as Parameters<typeof renderBare>[0], {
    ...options,
    wrapper: ({ children }) => createElement(NextIntlClientProvider, { children, locale: "en", messages }),
  });
}

function documentFixture() {
  return parseCarouselDocument(structuredClone(fixture));
}

afterEach(cleanup);

describe("theme catalogue", () => {
  it("defines the six approved original themes with complete role and mode layouts", () => {
    expect(THEME_IDS).toEqual([
      "ink",
      "paper",
      "signal",
      "blush",
      "butter",
      "sky",
    ]);

    for (const id of THEME_IDS) {
      const theme = themes[id];
      expect(theme.name).toBe(id[0].toUpperCase() + id.slice(1));
      expect(theme.templateId).toBe(id);
      expect(theme.templateVersion).toBe(1);
      expect(theme.settings.colors).toHaveLength(3);
      expect(Object.keys(theme.layouts)).toEqual([
        "intro",
        "content",
        "outro",
      ]);
      for (const role of ["intro", "content", "outro"] as const) {
        expect(Object.keys(theme.layouts[role])).toEqual([
          "text",
          "text_image",
          "image",
          "screenshot",
        ]);
      }
    }
  });
});

describe("appearance previews", () => {
  it("changes only global theme settings while preserving slide content and local overrides", () => {
    const document = documentFixture();
    document.slides[1].overrides = {
      titleScale: 0.92,
      background: "#112233",
    };
    document.slides[1].assetSlots = [
      {
        slotId: "hero",
        assetId: "local-asset-01",
        fit: "cover",
        crop: { x: 0, y: 0, width: 1, height: 1 },
        opacity: 0.8,
        alt: "A notebook on a desk",
      },
    ];
    document.assetRefs = [
      {
        id: "local-asset-01",
        kind: "upload",
        mimeType: "image/png",
        rightsStatus: "user_asserted",
      },
    ];
    const slidesBefore = structuredClone(document.slides);
    const assetsBefore = structuredClone(document.assetRefs);

    const result = previewAppearance(document, { themeId: "ink" });

    expect(result.document).not.toBe(document);
    expect(result.document.templateId).toBe("ink");
    expect(result.document.theme).toEqual(themes.ink.settings);
    expect(result.document.slides).toEqual(slidesBefore);
    expect(result.document.assetRefs).toEqual(assetsBefore);
    expect(result.document.platform).toBe("linkedin");
    expect(result.canvas).toEqual({ width: 1080, height: 1350 });
  });

  it.each([
    ["linkedin", 1080, 1350],
    ["instagram", 1080, 1350],
    ["tiktok", 1080, 1920],
  ] as const)(
    "switches to the fixed %s canvas without changing project content",
    (platform, width, height) => {
      const document = documentFixture();
      const projectBefore = {
        title: document.title,
        templateId: document.templateId,
        templateVersion: document.templateVersion,
        theme: structuredClone(document.theme),
        brandSnapshot: document.brandSnapshot,
        slides: structuredClone(document.slides),
        caption: document.caption,
        assetRefs: structuredClone(document.assetRefs),
      };

      const result = previewAppearance(document, { platform });

      expect(result.document.platform).toBe(platform);
      expect(result.canvas).toEqual({ width, height });
      expect({
        title: result.document.title,
        templateId: result.document.templateId,
        templateVersion: result.document.templateVersion,
        theme: result.document.theme,
        brandSnapshot: result.document.brandSnapshot,
        slides: result.document.slides,
        caption: result.document.caption,
        assetRefs: result.document.assetRefs,
      }).toEqual(projectBefore);
    },
  );

  it("returns slide-scoped conflicts with repair actions for later preflight", () => {
    const document = documentFixture();
    document.slides[1].bodyBlocks = [
      {
        kind: "paragraph",
        text: "Long copy ".repeat(80),
        emphasisRanges: [],
      },
    ];
    document.slides[2].mode = "image";
    document.slides[2].assetSlots = [];

    const result = previewAppearance(document, {
      platform: "tiktok",
      themeId: "signal",
    });

    expect(result.conflicts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          slideId: document.slides[1].id,
          code: "TEXT_CAPACITY_REVIEW",
          repairAction: expect.any(String),
        }),
        expect.objectContaining({
          slideId: document.slides[2].id,
          code: "ASSET_REQUIRED",
          repairAction: expect.any(String),
        }),
      ]),
    );
    expect(result.conflicts.every((conflict) => conflict.repairAction.length > 0)).toBe(
      true,
    );
  });
});

describe("ThemePanel", () => {
  it("uses native labelled controls for all themes and platforms", () => {
    render(
      createElement(ThemePanel, {
        document: documentFixture(),
        onChange: () => undefined,
      }),
    );

    expect(screen.getByRole("group", { name: "Theme" })).toBeTruthy();
    expect(screen.getAllByRole("radio", { name: /Ink|Paper|Signal|Blush|Butter|Sky/ })).toHaveLength(
      6,
    );
    expect(screen.getByRole("group", { name: "Platform" })).toBeTruthy();
    expect(screen.getAllByRole("radio", { name: /LinkedIn|Instagram|TikTok/ })).toHaveLength(
      3,
    );
    expect(screen.getByRole("status").textContent).toContain("No layout conflicts");
  });

  it("stays controlled and reports the complete preview to its parent", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn<(preview: AppearancePreview) => void>();
    const document = documentFixture();
    const view = render(createElement(ThemePanel, { document, onChange }));
    const ink = screen.getByRole("radio", { name: "Ink" });
    const paper = screen.getByRole("radio", { name: "Paper" });

    expect((paper as HTMLInputElement).checked).toBe(true);
    await user.click(ink);

    expect(onChange).toHaveBeenCalledOnce();
    expect(onChange.mock.calls[0][0].document.templateId).toBe("ink");
    expect((ink as HTMLInputElement).checked).toBe(false);

    view.rerender(
      createElement(ThemePanel, {
        document: onChange.mock.calls[0][0].document,
        onChange,
      }),
    );
    expect((ink as HTMLInputElement).checked).toBe(true);
  });
});
