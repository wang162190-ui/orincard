// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import baseDocument from "../fixtures/base-document.json";
import { parseCarouselDocument } from "../../src/domain/document";
import {
  SlideRenderer,
  type SlideRenderAsset,
  type SlideRenderInput,
} from "../../src/render/slide";
import {
  VISUAL_EXPORT_FORMATS,
  preflightVisualExport,
  type PreflightMeasurementAdapter,
} from "../../src/render/preflight";

afterEach(cleanup);

const documentFixture = parseCarouselDocument(baseDocument);

const readyAsset: SlideRenderAsset = {
  id: "local-asset-01",
  src: "/assets/example.png",
  state: "ready",
  alt: "A notebook on a desk",
};

function renderInput(
  mode: SlideRenderInput["slide"]["mode"] = "text",
  assetOverride?: SlideRenderAsset | null,
): SlideRenderInput {
  const asset =
    assetOverride === null
      ? undefined
      : (assetOverride ?? (mode === "text" ? undefined : readyAsset));
  const slide = structuredClone(documentFixture.slides[1]);
  slide.mode = mode;
  slide.assetSlots =
    mode === "text"
      ? []
      : [
          {
            slotId: "hero",
            assetId: readyAsset.id,
            fit: "cover",
            crop: { x: 0, y: 0, width: 1, height: 1 },
            opacity: 1,
            alt: readyAsset.alt,
          },
        ];

  return {
    slide,
    platform: documentFixture.platform,
    theme: documentFixture.theme,
    brandSnapshot: documentFixture.brandSnapshot,
    assets: asset ? { [asset.id]: asset } : {},
    slideNumber: 2,
    slideCount: documentFixture.slides.length,
  };
}

function measurements(
  overrides: Partial<PreflightMeasurementAdapter> = {},
): PreflightMeasurementAdapter {
  return {
    waitForFonts: vi.fn().mockResolvedValue(true),
    waitForImage: vi.fn().mockResolvedValue(true),
    measureText: vi.fn().mockResolvedValue({
      clientWidth: 800,
      clientHeight: 900,
      scrollWidth: 800,
      scrollHeight: 900,
    }),
    ...overrides,
  };
}

describe("SlideRenderer", () => {
  it.each(["text", "text_image", "image", "screenshot"] as const)(
    "renders %s mode through the shared input contract",
    (mode) => {
      const { container, getByRole } = render(<SlideRenderer input={renderInput(mode)} />);
      const slide = container.querySelector<HTMLElement>("[data-slide-id]");

      expect(slide?.dataset.mode).toBe(mode);
      expect(slide?.dataset.platform).toBe("linkedin");
      expect(getByRole("heading", { name: documentFixture.slides[1].title! })).toBeTruthy();

      const image = container.querySelector<HTMLImageElement>("img[data-asset-id]");
      if (mode === "text") {
        expect(image).toBeNull();
      } else {
        expect(image?.dataset.assetId).toBe(readyAsset.id);
        expect(image?.alt).toBe(readyAsset.alt);
      }
    },
  );
});

describe("preflightVisualExport", () => {
  it("waits for fonts and images before measuring, then blocks every visual format on overflow", async () => {
    const calls: string[] = [];
    const adapter = measurements({
      waitForFonts: vi.fn(async () => {
        calls.push("fonts");
        return true;
      }),
      waitForImage: vi.fn(async () => {
        calls.push("image");
        return true;
      }),
      measureText: vi.fn(async () => {
        calls.push("measure");
        return {
          clientWidth: 800,
          clientHeight: 900,
          scrollWidth: 800,
          scrollHeight: 901,
        };
      }),
    });

    const result = await preflightVisualExport([renderInput("text_image")], adapter);

    expect(calls).toEqual(["fonts", "image", "measure"]);
    expect(result.ok).toBe(false);
    expect(result.blockedFormats).toEqual(VISUAL_EXPORT_FORMATS);
    expect(result.issues).toEqual([
      {
        slideId: documentFixture.slides[1].id,
        code: "TEXT_OVERFLOW",
        repairAction: "Shorten the text, split the slide, or choose a roomier layout.",
      },
    ]);
  });

  it("blocks without measuring when a font is not ready", async () => {
    const adapter = measurements({ waitForFonts: vi.fn().mockResolvedValue(false) });

    const result = await preflightVisualExport([renderInput()], adapter);

    expect(adapter.measureText).not.toHaveBeenCalled();
    expect(result.issues).toEqual([
      {
        slideId: documentFixture.slides[1].id,
        code: "FONT_NOT_READY",
        repairAction: "Wait for the selected font to finish loading, then retry.",
      },
    ]);
  });

  it("distinguishes an image that is not ready from a missing required image", async () => {
    const loading = { ...readyAsset, state: "loading" as const };
    const unavailable = await preflightVisualExport(
      [renderInput("image", loading)],
      measurements({ waitForImage: vi.fn().mockResolvedValue(false) }),
    );
    const missing = await preflightVisualExport(
      [renderInput("screenshot", null)],
      measurements(),
    );

    expect(unavailable.issues).toEqual([
      {
        slideId: documentFixture.slides[1].id,
        code: "ASSET_NOT_READY",
        repairAction: "Wait for the image to finish loading, then retry.",
      },
    ]);
    expect(missing.issues).toEqual([
      {
        slideId: documentFixture.slides[1].id,
        code: "ASSET_MISSING",
        repairAction: "Choose or upload an available image for this slide.",
      },
    ]);
  });

  it("allows every visual format only after resources and text fit", async () => {
    const result = await preflightVisualExport(
      [renderInput("text"), renderInput("text_image")],
      measurements(),
    );

    expect(result).toEqual({ ok: true, issues: [], blockedFormats: [] });
  });
});
