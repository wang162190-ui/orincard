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
import { TEXTURE_IDS } from "../../src/render/textures";

afterEach(cleanup);

const documentFixture = parseCarouselDocument(baseDocument);
// Resolved from the cwd rather than import.meta.url: under jsdom that URL is an http: one, the same
// reason src/render/render-deck.ts reads this file by cwd path.
const css = readFileSync(join(process.cwd(), "src/render/slide.css"), "utf8");

/**
 * The ids slide.css actually draws. jsdom does not apply stylesheets, so a rendered-DOM assertion
 * cannot tell whether a texture has a rule — reading the file is the only way to catch an id that
 * is listed but never painted.
 */
function drawnTextureIds(): string[] {
  return [...css.matchAll(/\[data-background-texture="([a-z-]+)"\]/g)].map(([, id]) => id);
}

function renderSlide(theme: CarouselDocument["theme"]): HTMLElement {
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

function withTexture(texture: string | null): CarouselDocument["theme"] {
  return {
    ...documentFixture.theme,
    background: { ...documentFixture.theme.background, texture },
  };
}

describe("slide textures", () => {
  it("draws every id listed in textures.ts", () => {
    expect([...drawnTextureIds()].sort()).toEqual([...TEXTURE_IDS].sort());
  });

  it("puts the texture on the slide so the CSS can key off it", () => {
    expect(renderSlide(withTexture("lattice")).dataset.backgroundTexture).toBe("lattice");
  });

  it("omits the attribute entirely when no texture is set", () => {
    // Not `data-background-texture=""` — the bare-attribute rule that positions the ::after layer
    // would still match an empty value and paint an invisible box over the background.
    expect(renderSlide(withTexture(null)).hasAttribute("data-background-texture")).toBe(false);
  });

  it("keeps a deck saved against an unknown texture renderable", () => {
    // The field is a plain string in the schema on purpose: a texture added in a later build must
    // degrade to flat rather than fail to render.
    expect(renderSlide(withTexture("not-a-real-texture")).dataset.backgroundTexture).toBe(
      "not-a-real-texture",
    );
  });

  it("only ships themes whose texture is drawn", () => {
    for (const id of THEME_IDS) {
      const texture = themes[id].settings.background.texture;
      expect(texture, `theme ${id} has no texture`).toBeTruthy();
      expect(TEXTURE_IDS, `theme ${id}`).toContain(texture);
    }
  });

  it("tints from the foreground colour rather than baking in black or white", () => {
    // A single rule has to read on ink's near-black and on butter's cream, which only works if it
    // draws --slide-texture-ink (mixed from --slide-fg). paper-grain predates that and layers fixed
    // white-on-black grain instead; it is the one exception, and listing it here means adding a
    // second one is a deliberate act rather than a copy-paste.
    for (const id of TEXTURE_IDS) {
      const rule = css.slice(css.indexOf(`[data-background-texture="${id}"]`));
      const body = rule.slice(0, rule.indexOf("\n}"));
      if (id === "paper-grain") {
        expect(body).toContain("rgb(");
        continue;
      }
      expect(body, `texture ${id}`).toContain("var(--slide-texture-ink)");
      expect(body, `texture ${id}`).not.toMatch(/#[0-9a-fA-F]{3,8}|\brgba?\(/);
    }
  });
});
