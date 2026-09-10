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

function familyOf(font: string): string {
  return font.replace(/^\s*\d+px\s+/, "").replace(/^['"]|['"]$/g, "");
}

/**
 * A FontFaceSet that behaves the way a real one does: a family only reports ready for the
 * exact text it was asked to load. Real webfonts ship as unicode-range subsets and the
 * browser fetches only the subsets a rendered glyph needs, so a family is never "loaded"
 * as a whole — it is loaded for some text.
 */
function installFontSet(
  options: { readonly unavailable?: readonly string[]; readonly rejects?: readonly string[] } = {},
) {
  const unavailable = new Set(options.unavailable ?? []);
  const rejects = new Set(options.rejects ?? []);
  const loaded = new Set<string>();
  const key = (family: string, text: string) => JSON.stringify([family, text]);

  const load = vi.fn(async (font: string, text: string) => {
    const family = familyOf(font);
    if (rejects.has(family)) {
      throw new Error(`${family} failed to load`);
    }
    if (!unavailable.has(family)) {
      loaded.add(key(family, text));
    }
    return [];
  });
  const check = vi.fn((font: string, text = " ") => loaded.has(key(familyOf(font), text)));

  Object.defineProperty(document, "fonts", {
    configurable: true,
    value: { ready: Promise.resolve(), load, check },
  });
  return { load, check };
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
    const { check } = installFontSet();

    const result = await preflightVisualExport(
      [input],
      createDomPreflightAdapter(container),
    );

    // Fonts resolve, so the only issue left is the clipping this test set up.
    expect(result.issues).toEqual([
      expect.objectContaining({ code: "TEXT_OVERFLOW", slideId: input.slide.id }),
    ]);
    expect(check.mock.calls.map(([font]) => font)).toEqual([
      '16px "Source Serif 4 Variable"',
      '16px "Inter Variable"',
      '16px "Noto Sans SC"',
    ]);
  });

  it("does not treat a background shape that bleeds past the card as clipped text", async () => {
    // Five of the six themes place `.orincard-slide__shape` outside the card with negative
    // offsets and let `overflow: hidden` clip it. The card's own scrollWidth/scrollHeight
    // therefore exceed its client box on a perfectly typeset slide.
    const input = renderInput("text");
    input.slide.eyebrow = "EYEBROW";
    input.slide.cta = "Continue";
    input.slide.counterVisible = true;
    const { container } = render(<SlideRenderer input={input} />);

    const card = container.querySelector<HTMLElement>("[data-slide-id]");
    expect(card).toBeTruthy();

    // The card itself also carries data-slide-content, so size its descendants first and
    // give the card its bleeding dimensions last.
    const content = card!.querySelectorAll<HTMLElement>("[data-slide-content]");
    expect(content.length).toBeGreaterThan(0);
    for (const element of content) {
      Object.defineProperties(element, {
        clientWidth: { configurable: true, value: 907 },
        clientHeight: { configurable: true, value: 200 },
        scrollWidth: { configurable: true, value: 907 },
        scrollHeight: { configurable: true, value: 200 },
      });
    }
    Object.defineProperties(card!, {
      clientWidth: { configurable: true, value: 1080 },
      clientHeight: { configurable: true, value: 1350 },
      scrollWidth: { configurable: true, value: 1188 },
      scrollHeight: { configurable: true, value: 1544 },
    });
    installFontSet();

    const result = await preflightVisualExport(
      [input],
      createDomPreflightAdapter(container),
    );

    expect(result.issues).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("blocks a selected family the page cannot supply for this text", async () => {
    const input = renderInput();
    const { container } = render(<SlideRenderer input={input} />);
    installFontSet({ unavailable: ["Noto Sans SC"] });
    const adapter = createDomPreflightAdapter(container);

    await expect(adapter.waitForFonts(input)).resolves.toBe(false);
  });

  it("blocks a selected family whose load is rejected", async () => {
    const input = renderInput();
    const { container } = render(<SlideRenderer input={input} />);
    installFontSet({ rejects: ["Noto Sans SC"] });
    const adapter = createDomPreflightAdapter(container);

    await expect(adapter.waitForFonts(input)).resolves.toBe(false);
  });

  it("asks for the slide's own text so unicode-range subsets are fetched", async () => {
    const input = renderInput();
    const { container } = render(<SlideRenderer input={input} />);
    const text = container
      .querySelector<HTMLElement>("[data-slide-id]")!
      .textContent!.trim();
    const { load, check } = installFontSet();
    const adapter = createDomPreflightAdapter(container);

    await expect(adapter.waitForFonts(input)).resolves.toBe(true);
    expect(load.mock.calls).toEqual([
      ['16px "Source Serif 4 Variable"', text],
      ['16px "Inter Variable"', text],
      ['16px "Noto Sans SC"', text],
    ]);
    // Never the bare family: checking without text asks about a subset the slide will not draw.
    expect(check.mock.calls.every(([, asked]) => asked === text)).toBe(true);
  });

  it("does not report a font issue for a slide that typesets nothing", async () => {
    const input = renderInput();
    const { container } = render(<SlideRenderer input={input} />);
    const slide = container.querySelector<HTMLElement>("[data-slide-id]")!;
    slide.textContent = "";
    const { load } = installFontSet({ unavailable: ["Noto Sans SC"] });
    const adapter = createDomPreflightAdapter(container);

    await expect(adapter.waitForFonts(input)).resolves.toBe(true);
    expect(load).not.toHaveBeenCalled();
  });

  it("blocks when the slide is not rendered at all", async () => {
    const input = renderInput();
    render(<SlideRenderer input={input} />);
    installFontSet();
    const adapter = createDomPreflightAdapter(document.createElement("div"));

    await expect(adapter.waitForFonts(input)).resolves.toBe(false);
  });
});
