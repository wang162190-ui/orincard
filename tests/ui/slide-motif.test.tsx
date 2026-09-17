// @vitest-environment jsdom

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import baseDocument from "../fixtures/base-document.json";
import {
  parseCarouselDocument,
  type CarouselDocument,
} from "../../src/domain/document";
import { SlideRenderer, type SlideRenderInput } from "../../src/render/slide";
import { themes, THEME_IDS } from "../../src/render/templates";
import { MOTIF_IDS } from "../../src/render/motifs";
import { boringAvatars } from "../../src/assets/generated/boring-avatars";

afterEach(cleanup);

const documentFixture = parseCarouselDocument(baseDocument);
// Read by cwd path for the same reason tests/ui/slide-texture.test.tsx does: under jsdom
// import.meta.url is an http: URL.
const css = readFileSync(join(process.cwd(), "src/render/slide.css"), "utf8");

function renderSlide(motif: string | null): HTMLElement {
  const theme: CarouselDocument["theme"] = {
    ...documentFixture.theme,
    background: { ...documentFixture.theme.background, motif },
  };
  const input: SlideRenderInput = {
    slide: documentFixture.slides[1],
    platform: "linkedin",
    theme,
    brandSnapshot: documentFixture.brandSnapshot,
    assets: {},
    slideNumber: 2,
    slideCount: documentFixture.slides.length,
  };
  const { container } = render(<SlideRenderer input={input} />);
  return container.querySelector(".orincard-slide") as HTMLElement;
}

describe("slide motifs", () => {
  it("draws an inline svg for every id listed in motifs.ts", () => {
    for (const motif of MOTIF_IDS) {
      const slide = renderSlide(motif);
      expect(slide.dataset.backgroundMotif, motif).toBe(motif);
      const layer = slide.querySelector(".orincard-slide__motif");
      expect(layer?.getAttribute("data-motif"), motif).toBe(motif);
      // Inline <svg>, not <img>: render-deck.ts's assertLocalAssets rejects remote srcs, and a
      // data-URI could not reach the --motif-* custom properties.
      expect(layer?.querySelector("svg"), motif).toBeTruthy();
      expect(layer?.querySelector("img"), motif).toBeNull();
    }
  });

  it("omits the attribute and the layer entirely when no motif is set", () => {
    const slide = renderSlide(null);
    expect(slide.hasAttribute("data-background-motif")).toBe(false);
    expect(slide.querySelector(".orincard-slide__motif")).toBeNull();
  });

  it("keeps a deck saved against an unknown motif renderable", () => {
    // Same contract as texture: the schema takes any string so a motif added in a later build
    // degrades to no drawing instead of failing validation.
    const slide = renderSlide("not-a-real-motif");
    expect(slide.dataset.backgroundMotif).toBe("not-a-real-motif");
    expect(slide.querySelector(".orincard-slide__motif")).toBeNull();
  });

  it("seeds the composition from the slide id", () => {
    // Deterministic per slide, so an unchanged deck re-exports the same drawing, and different
    // slides in one deck do not all get the same one. React.useId() numbers the mask differently
    // per render tree, so compare with those ids stripped.
    const draw = (slide: CarouselDocument["slides"][number]) => {
      const input: SlideRenderInput = {
        slide,
        platform: "linkedin",
        theme: {
          ...documentFixture.theme,
          background: { ...documentFixture.theme.background, motif: "ring" },
        },
        brandSnapshot: documentFixture.brandSnapshot,
        assets: {},
        slideNumber: 2,
        slideCount: documentFixture.slides.length,
      };
      const { container } = render(<SlideRenderer input={input} />);
      const html = container.querySelector(".orincard-slide__motif")!.innerHTML;
      cleanup();
      return html.replaceAll(/_r_[0-9a-z]+_/gi, "ID");
    };

    expect(draw(documentFixture.slides[1])).toBe(draw(documentFixture.slides[1]));
    expect(draw(documentFixture.slides[2])).not.toBe(draw(documentFixture.slides[1]));
  });

  it("only ships motifs the generated module can draw", () => {
    for (const motif of MOTIF_IDS) {
      expect(Object.keys(boringAvatars), motif).toContain(motif);
    }
    // `beam` is vendored but deliberately not offered: it draws a face, which is a person, not a
    // background pattern. Listing the exclusion here means dropping it back in is a deliberate act.
    expect(MOTIF_IDS).not.toContain("beam");
  });

  it("only ships themes whose motif is drawable", () => {
    for (const id of THEME_IDS) {
      const motif = themes[id].settings.background.motif;
      if (motif == null) continue;
      expect(MOTIF_IDS, `theme ${id}`).toContain(motif);
    }
  });

  it("paints from the palette rather than upstream's demo colours", () => {
    // The generators take a `colors` array. If motif.tsx ever passes hex strings the drawing stops
    // following the theme, which is the whole reason this layer exists.
    const source = readFileSync(join(process.cwd(), "src/render/motif.tsx"), "utf8");
    const colors = source.slice(source.indexOf("const MOTIF_COLORS"));
    const body = colors.slice(0, colors.indexOf("];"));
    expect(body).not.toMatch(/#[0-9a-fA-F]{3,8}|\brgba?\(/);
    expect([...body.matchAll(/var\(--motif-\d\)/g)]).toHaveLength(5);
  });

  it("declares the generic --motif fallbacks before the palettes that override them", () => {
    // Custom properties on .orincard-slide and on .orincard-slide--palette-* have equal
    // specificity, so source order decides. This ordering was wrong once and pulse silently drew
    // in prism's accent; the assertion is here so it cannot regress quietly.
    expect(css.indexOf("--motif-1: var(--slide-accent")).toBeGreaterThan(-1);
    expect(css.indexOf("--motif-1: var(--slide-accent")).toBeLessThan(
      css.indexOf(".orincard-slide--palette-prism"),
    );
  });

  it("paints nothing the palette did not supply", () => {
    // Upstream hard-codes `fill="#FFFFFF"`, but only inside the <mask> (where it means "keep this
    // area", not a colour) — drop the masks and every remaining fill has to come from --motif-*.
    // A literal surviving anywhere else would be a colour the theme cannot reach.
    for (const motif of MOTIF_IDS) {
      const svg = renderSlide(motif).querySelector("svg")!;
      for (const mask of svg.querySelectorAll("mask")) mask.remove();
      for (const node of svg.querySelectorAll("[fill], [stop-color]")) {
        for (const attribute of ["fill", "stop-color"]) {
          const value = node.getAttribute(attribute);
          // url(#…) points at a gradient in the same svg; its stops are checked by this same loop.
          if (value == null || value === "none" || value.startsWith("url(#")) continue;
          expect(value, `${motif} ${node.nodeName}@${attribute}`).toMatch(/^var\(--motif-\d\)$/);
        }
      }
      cleanup();
    }
  });
});
