/**
 * Renders one swatch per theme.background.texture so the patterns can be looked at rather than
 * assumed. A texture is a picture; the only honest way to check one is to look at it, and three
 * of the shipped set were drawn wrong on the first attempt and only caught this way.
 *
 * Writes a single PNG and touches nothing else — it reads slide.css and textures.ts, so it cannot
 * go stale against them.
 *
 *   node scripts/texture-sheet.mjs [out.png] [id-substring]
 */
import { readFile, writeFile } from "node:fs/promises";
import { chromium } from "playwright";

const OUT = process.argv[2] ?? "/tmp/texture-sheet.png";
/** Optional filter, so one suspect texture can be re-rendered large instead of cropped out of a grid. */
const ONLY = process.argv[3] ?? "";
const CSS = await readFile(new URL("../src/render/slide.css", import.meta.url), "utf8");

/** Read the shipped list rather than keeping a second copy of it here. */
const source = await readFile(new URL("../src/render/textures.ts", import.meta.url), "utf8");
const TEXTURE_IDS = [...source.match(/export const TEXTURE_IDS = \[([\s\S]*?)\] as const;/)[1]
  .matchAll(/"([a-z-]+)"/g)].map(([, id]) => id);
if (TEXTURE_IDS.length === 0) throw new Error("TEXTURE_IDS parsed empty");

const PALETTES = [
  { id: "paper", bg: "#F5F1E8" },
  { id: "ink", bg: "#1F1F1D" },
  { id: "sky", bg: "linear-gradient(145deg, #DDEAF5, #BFD5EB)" },
];

const shown = TEXTURE_IDS.filter((id) => id.includes(ONLY));
if (shown.length === 0) throw new Error(`no texture matches "${ONLY}"`);

const cards = PALETTES.flatMap((palette) =>
  shown.map(
    (texture) => `
      <figure>
        <article class="orincard-slide orincard-slide--text orincard-slide--content orincard-slide--palette-${palette.id} orincard-slide--layout-statement"
                 data-background-texture="${texture}"
                 style="--slide-aspect: 1 / 1; --slide-bg: ${palette.bg}; --slide-bg-opacity: 1; --slide-radius: 24px; --slide-text-scale: 1; --slide-title-scale: 1; --slide-density: 1">
          <span class="orincard-slide__background" aria-hidden="true"></span>
        </article>
        <figcaption>${palette.id} · ${texture}</figcaption>
      </figure>`,
  ),
);

const html = `<!doctype html><meta charset="utf-8"><style>
  body { margin: 0; padding: 24px; background: #fff; font: 13px/1.4 ui-monospace, monospace; }
  .sheet { display: grid; grid-template-columns: repeat(4, 540px); gap: 16px; }
  figure { margin: 0; }
  figcaption { margin-top: 6px; color: #444; }
  ${CSS}
</style><div class="sheet">${cards.join("")}</div>`;

const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 540 * 4 + 48 + 16 * 4, height: 1200 } });
  await page.setContent(html);
  await writeFile(OUT, await page.screenshot({ fullPage: true }));
} finally {
  await browser.close();
}
console.log(`wrote ${OUT}`);
