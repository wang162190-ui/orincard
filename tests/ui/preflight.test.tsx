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
  createDomPreflightAdapter,
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

type FakeFontFace = {
  readonly family: string;
  readonly status: "unloaded" | "loading" | "loaded" | "error";
};

const loadedFontFaces: readonly FakeFontFace[] = [
  { family: '"Source Serif 4 Variable"', status: "loaded" },
  { family: "Inter Variable", status: "loaded" },
  { family: "Noto Sans SC", status: "loaded" },
];

function installFontFaces(
  faces: readonly FakeFontFace[],
  checkResult = true,
) {
  const check = vi.fn().mockReturnValue(checkResult);
  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: {
      ready: Promise.resolve(),
      check,
      forEach(callback: (face: FakeFontFace) => void) {
        faces.forEach(callback);
      },
    },
  });
  return check;
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

  it("applies the selected layout, slide overrides, and complete theme chrome", () => {
    const input = renderInput("text");
    input.slide.layoutId = "numbered-point";
    input.slide.overrides = { background: "#112233", titleScale: 0.88 };
    input.theme.background = {
      kind: "solid",
      value: "#f5f1e8",
      opacity: 0.72,
      texture: "paper-grain",
    };
    input.theme.arrow = "filled";

    const { container } = render(<SlideRenderer input={input} />);
    const slide = container.querySelector<HTMLElement>("[data-slide-id]");

    expect(slide?.dataset.layout).toBe("numbered-point");
    expect(slide?.classList.contains("orincard-slide--layout-numbered-point")).toBe(
      true,
    );
    expect(slide?.dataset.fontPair).toBe("source-serif-inter");
    expect(slide?.dataset.backgroundTexture).toBe("paper-grain");
    expect(slide?.dataset.arrow).toBe("filled");
    expect(slide?.style.getPropertyValue("--slide-bg")).toBe("#112233");
    expect(slide?.style.getPropertyValue("--slide-bg-opacity")).toBe("0.72");
    expect(slide?.style.getPropertyValue("--slide-title-scale")).toBe("0.88");
    expect(slide?.style.getPropertyValue("--slide-font-display")).toContain(
      "Source Serif 4 Variable",
    );
    expect(slide?.style.getPropertyValue("--slide-font-body")).toContain(
      "Inter Variable",
    );
    expect(container.querySelector(".orincard-slide__background")).toBeTruthy();
    expect(container.querySelector(".orincard-slide__arrow--filled")).toBeTruthy();
  });

  it.each(["text_image", "image", "screenshot"] as const)(
    "renders every configured asset slot in %s mode",
    (mode) => {
      const baseInput = renderInput(mode);
      const secondAsset = {
        ...readyAsset,
        id: "local-asset-02",
        alt: "Second asset",
      };
      const input: SlideRenderInput = {
        ...baseInput,
        assets: {
          [readyAsset.id]: readyAsset,
          [secondAsset.id]: secondAsset,
        },
      };
      input.slide.assetSlots.push({
        slotId: "detail",
        assetId: secondAsset.id,
        fit: "contain",
        crop: { x: 0, y: 0, width: 1, height: 1 },
        opacity: 0.8,
        alt: secondAsset.alt,
      });

      const { container } = render(<SlideRenderer input={input} />);
      expect(
        Array.from(
          container.querySelectorAll<HTMLImageElement>("img[data-slot-id]"),
        ).map((image) => image.dataset.slotId),
      ).toEqual(["hero", "detail"]);
      const slots = Array.from(
        container.querySelectorAll<HTMLElement>(".orincard-slide__asset-slot"),
      );
      expect(slots.map((slot) => slot.style.gridColumn)).toEqual(["1", "2"]);
      expect(slots[0]?.parentElement?.style.gridTemplateColumns).toBe(
        "repeat(2, minmax(0, 1fr))",
      );
      if (mode === "screenshot") {
        expect(
          container.querySelector<HTMLElement>(".orincard-slide__screenshot-bar")
            ?.style.gridColumn,
        ).toBe("1 / -1");
      }
    },
  );

  it("applies background opacity to the full-bleed image veil", () => {
    const input = renderInput("image");
    input.theme.background.opacity = 0.42;

    const { container } = render(<SlideRenderer input={input} />);

    expect(
      container.querySelector<HTMLElement>(".orincard-slide__veil")?.style.opacity,
    ).toBe("0.42");
  });
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

  it("checks every asset slot before measuring", async () => {
    const baseInput = renderInput("screenshot");
    const secondAsset = { ...readyAsset, id: "local-asset-02", alt: "Second asset" };
    const input: SlideRenderInput = {
      ...baseInput,
      assets: {
        [readyAsset.id]: readyAsset,
        [secondAsset.id]: secondAsset,
      },
    };
    input.slide.assetSlots.push({
      slotId: "detail",
      assetId: secondAsset.id,
      fit: "contain",
      crop: { x: 0, y: 0, width: 1, height: 1 },
      opacity: 1,
      alt: secondAsset.alt,
    });
    const waitForImage = vi.fn().mockResolvedValue(true);

    await preflightVisualExport([input], measurements({ waitForImage }));

    expect(waitForImage.mock.calls.map((call) => call[1].id)).toEqual([
      readyAsset.id,
      secondAsset.id,
    ]);
  });

  it.each([
    ".orincard-slide__eyebrow",
    ".orincard-slide__counter",
    ".orincard-slide__footer",
    ".orincard-slide__cta",
  ])("detects content clipped outside %s", async (selector) => {
    const input = renderInput("text");
    input.slide.eyebrow = "EYEBROW";
    input.slide.cta = "Continue";
    input.slide.counterVisible = true;
    const { container } = render(<SlideRenderer input={input} />);
    const clipped = container.querySelector<HTMLElement>(selector);
    expect(clipped).toBeTruthy();
    Object.defineProperties(clipped!, {
      clientWidth: { configurable: true, value: 100 },
      clientHeight: { configurable: true, value: 20 },
      scrollWidth: { configurable: true, value: 101 },
      scrollHeight: { configurable: true, value: 20 },
    });
    const check = installFontFaces(loadedFontFaces);

    const result = await preflightVisualExport(
      [input],
      createDomPreflightAdapter(container),
    );

    expect(result.issues).toEqual([
      expect.objectContaining({ code: "TEXT_OVERFLOW", slideId: input.slide.id }),
    ]);
    expect(check.mock.calls.map(([font]) => font)).toEqual([
      '16px "Source Serif 4 Variable"',
      '16px "Inter Variable"',
      '16px "Noto Sans SC"',
    ]);
  });

  it("blocks a selected family that check claims is available but is absent", async () => {
    installFontFaces(loadedFontFaces.slice(0, 2), true);
    const adapter = createDomPreflightAdapter(document);

    await expect(adapter.waitForFonts(renderInput())).resolves.toBe(false);
  });

  it.each(["loading", "error"] as const)(
    "blocks a selected family whose actual face status is %s",
    async (status) => {
      installFontFaces([
        ...loadedFontFaces.slice(0, 2),
        { family: "Noto Sans SC", status },
      ]);
      const adapter = createDomPreflightAdapter(document);

      await expect(adapter.waitForFonts(renderInput())).resolves.toBe(false);
    },
  );

  it("allows the selected manifest families only when actual faces are loaded", async () => {
    const check = installFontFaces(loadedFontFaces);
    const adapter = createDomPreflightAdapter(document);

    await expect(adapter.waitForFonts(renderInput())).resolves.toBe(true);
    expect(check).toHaveBeenCalledTimes(3);
  });
});
