import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import templatesJson from "../../content/templates.json";
import en from "../../messages/en.json";
import zhHans from "../../messages/zh-Hans.json";
import fontManifest from "../../src/render/font-manifest.json";
import {
  DEFAULT_FONT_PAIR_ID,
  FONT_PAIRS,
  resolveFontPair,
} from "../../src/render/font-pairs";
import { themes, THEME_IDS } from "../../src/render/templates";
import { DEFAULT_BRAND_SETTINGS } from "../../src/server/brands";

const read = (path: string) => readFileSync(join(process.cwd(), path), "utf8");

const pairs = Object.entries(FONT_PAIRS);

/**
 * These pairs were broken for as long as they existed: the brand editor offered three ids and the
 * renderer knew one, so two of the three choices did nothing at all. The bug was invisible because
 * nothing compared the two lists. Each test below is one of those comparisons.
 */
describe("font pairs", () => {
  it("only names fonts the manifest declares", () => {
    const ids = new Set(fontManifest.fonts.map((font) => font.id));
    for (const [id, pair] of pairs) {
      for (const manifestId of pair.manifestIds) {
        expect(ids, `pair ${id}`).toContain(manifestId);
      }
    }
  });

  it("only names families the manifest ships", () => {
    // Catches the near-miss that CSS cannot report: a stack asking for "JetBrains Mono" when the
    // variable font's family is "JetBrains Mono Variable" just silently falls through to the
    // fallback and nobody sees it until someone looks at an export.
    const families = new Set(
      fontManifest.fonts.flatMap((font) =>
        font.package.startsWith("@fontsource-variable/")
          ? [font.family, `${font.family} Variable`]
          : [font.family],
      ),
    );
    for (const [id, pair] of pairs) {
      for (const role of [pair.display, pair.body]) {
        const quoted = [...role.css.matchAll(/"([^"]+)"/g)].map(([, family]) => family);
        for (const family of quoted) expect(families, `pair ${id}`).toContain(family);
        expect(families, `pair ${id} pptx`).toContain(role.pptx);
      }
    }
  });

  it("only names fonts the exporter inlines", () => {
    // render-deck.ts base64-inlines a fixed list into the exported HTML. A pair that needs a font
    // outside that list renders correctly in the editor and wrong in the download.
    const exported = new Set(
      [...read("src/render/render-deck.ts").matchAll(/loadExportFont\("([^"]+)"/g)].map(
        ([, id]) => id,
      ),
    );
    for (const [id, pair] of pairs) {
      for (const manifestId of pair.manifestIds) {
        expect(exported, `pair ${id}`).toContain(manifestId);
      }
    }
  });

  it("only names fonts the browser loads", () => {
    // The exporter inlines its own fonts, so a family missing from the app shell renders correctly
    // in the download and falls back to Inter in the editor — i.e. wrong exactly where the user is
    // looking while they pick a pair. JetBrains Mono shipped that way until a preview was decoded.
    const imported = [...read("src/app/[locale]/layout.tsx").matchAll(/from "|import "(@fontsource[^"]+)"/g)]
      .map(([, spec]) => spec)
      .filter(Boolean)
      .join("\n");
    const needed = new Set(pairs.flatMap(([, pair]) => pair.manifestIds));
    for (const font of fontManifest.fonts) {
      if (!needed.has(font.id)) continue;
      expect(imported, `font ${font.id}`).toContain(font.package);
    }
  });

  it("has a label in every locale", () => {
    for (const [id, pair] of pairs) {
      for (const [locale, messages] of [["zh-Hans", zhHans], ["en", en]] as const) {
        const brands = messages.Brands as Record<string, string | undefined>;
        expect(brands[pair.labelKey], `pair ${id} in ${locale}`).toBeTruthy();
      }
    }
  });

  it("lets the brand editor read the list instead of repeating it", () => {
    // The original bug was a hand-written <option> list. Regenerating it from FONT_PAIRS is what
    // makes the editor and the renderer impossible to disagree; hard-coding one back reopens it.
    const editor = read("src/features/brands/brand-editor.tsx");
    expect(editor).toContain("FONT_PAIRS");
    expect(editor).not.toMatch(/<option value="(serif-sans|sans-serif|mono-sans)"/);
  });

  it("keeps decks saved against the old id on their original fonts", () => {
    expect(resolveFontPair("source-serif-inter")).toBe(FONT_PAIRS["serif-sans"]);
    expect(FONT_PAIRS["serif-sans"].display.pptx).toBe("Source Serif 4");
    expect(FONT_PAIRS["serif-sans"].body.pptx).toBe("Inter");
  });

  it("renders a deck naming an unknown pair rather than failing", () => {
    expect(resolveFontPair("pair-from-a-later-build")).toBe(FONT_PAIRS[DEFAULT_FONT_PAIR_ID]);
  });

  it("is what the shipped themes, templates and brand default actually use", () => {
    expect(FONT_PAIRS).toHaveProperty(DEFAULT_BRAND_SETTINGS.fontPairId);
    for (const id of THEME_IDS) {
      expect(FONT_PAIRS, `theme ${id}`).toHaveProperty(themes[id].settings.fontPairId);
    }
    for (const template of templatesJson) {
      expect(FONT_PAIRS, `template ${template.slug}`).toHaveProperty(
        template.document.theme.fontPairId,
      );
    }
  });
});
