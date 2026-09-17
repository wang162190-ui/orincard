/**
 * Renders one preview image per template slide by driving the real editor.
 *
 * The files under public/media/templates/ used to be copies of two curated photographs
 * renamed to match the manifest, so every template in the gallery looked identical.
 * Nothing here invents an image: it seeds the template document as an anonymous local
 * draft exactly the way the browser does, opens /editor/<id>, and screenshots the slide
 * the product actually draws.
 *
 *   node scripts/render-template-previews.mjs [--base http://localhost:3000]
 *
 * Requires a dev or production server already listening on that origin.
 */
import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { chromium } from "playwright";
import { previewManifest } from "./template-preview-manifest.mjs";

const run = promisify(execFile);

const baseFlag = process.argv.indexOf("--base");
const BASE = baseFlag === -1 ? "http://localhost:3000" : process.argv[baseFlag + 1];
const LOCALE = "en";
const SESSION_ID = "session-template-previews";
const DRAFT_DATABASE = "orincard-local-drafts";
const DRAFT_STORE = "drafts";
const OUT_DIR = new URL("../public/media/templates/", import.meta.url);

/** Read the shipped canvas sizes rather than keeping a second copy of them here. */
async function platformPresets() {
  const source = await readFile(new URL("../src/domain/document.ts", import.meta.url), "utf8");
  const block = source.match(/export const platformPresets = \{([\s\S]*?)\} as const;/);
  if (!block) throw new Error("platformPresets not found in src/domain/document.ts");
  const presets = Object.fromEntries(
    [...block[1].matchAll(/(\w+):\s*\{\s*width:\s*(\d+),\s*height:\s*(\d+)\s*\}/g)]
      .map(([, name, width, height]) => [name, { width: Number(width), height: Number(height) }]),
  );
  if (Object.keys(presets).length === 0) throw new Error("platformPresets parsed empty");
  return presets;
}

/**
 * Rewrites the `public/media/templates/` block of docs/licenses/assets.md from the files that
 * were just written.
 *
 * Every edit to content/templates.json changes each template's version hash, which changes all
 * 61 filenames, which leaves all 61 hand-written licence rows pointing at files that no longer
 * exist — and T088 guard 1 reads the table by path. Generating the rows here is the only way the
 * table cannot drift from the directory.
 */
async function registerLicences(names) {
  const path = new URL("../docs/licenses/assets.md", import.meta.url);
  const rows = [...names].sort().map((name) => {
    const match = name.match(/^(.+)-([0-9a-f]+)-(\d+)\.webp$/);
    if (!match) throw new Error(`unexpected preview filename: ${name}`);
    const [, slug, version, page] = match;
    return `| \`public/media/templates/${name}\` | 模板预览图 | proprietary-owned | orincard-synthesised-media | \`scripts/render-template-previews.mjs\` 截取模板 ${slug} 第 ${Number(page)} 页的真实渲染，版本 ${version} |`;
  });

  const lines = (await readFile(path, "utf8")).split("\n");
  const isPreviewRow = (line) => line.startsWith("| `public/media/templates/");
  const start = lines.findIndex(isPreviewRow);
  if (start === -1) throw new Error("no public/media/templates rows found in docs/licenses/assets.md");
  let end = start;
  while (isPreviewRow(lines[end])) end += 1;

  // The table is sorted by path and the whole block sits together, so replacing the run in place
  // keeps that ordering without touching any other section.
  await writeFile(path, [...lines.slice(0, start), ...rows, ...lines.slice(end)].join("\n"));
  process.stdout.write(`registered ${rows.length} preview rows in docs/licenses/assets.md\n`);
}

async function seedDraft(page, draftId, document) {
  await page.evaluate(async ({ databaseName, storeName, sessionId, id, seeded }) => {
    localStorage.setItem("orincard-anonymous-session", sessionId);
    const database = await new Promise((resolve, reject) => {
      const request = indexedDB.open(databaseName, 1);
      request.onupgradeneeded = () => {
        const store = request.result.createObjectStore(storeName, { keyPath: "key" });
        store.createIndex("owner", "ownerKey", { unique: false });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const now = Date.now();
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(storeName, "readwrite");
      transaction.objectStore(storeName).put({
        key: JSON.stringify(["anonymous", sessionId, id]),
        ownerKey: JSON.stringify(["anonymous", sessionId]),
        draftId: id,
        owner: { kind: "anonymous", sessionId },
        document: seeded,
        createdAt: now,
        updatedAt: now,
        syncState: "local",
      });
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error);
    });
    database.close();
  }, { databaseName: DRAFT_DATABASE, storeName: DRAFT_STORE, sessionId: SESSION_ID, id: draftId, seeded: document });
}

/**
 * Refuse to screenshot a slide that hangs off the viewport.
 *
 * Playwright captures an oversized element by scrolling and stitching, and the stitch repeats
 * whatever is pinned to the element's edges: the tiktok previews came out with the bottom-right
 * arrow duplicated as a clipped arrow at the top-right, because the editor's side panels pushed
 * the 1080px canvas 178px right inside a 1200px window. Pinning the canvas (below) is what keeps
 * this from happening; this check is here so a layout change fails loudly instead of silently
 * producing stitched previews again.
 */
async function assertFits(page, slug) {
  const viewport = page.viewportSize();
  const box = await page.locator(".editor-canvas .orincard-slide").boundingBox();
  if (!box) throw new Error(`${slug}: slide not measurable`);
  const overflows = box.x < -1 || box.y < -1 || box.x + box.width > viewport.width + 1 || box.y + box.height > viewport.height + 1;
  if (overflows) {
    throw new Error(`${slug}: slide at ${Math.round(box.x)},${Math.round(box.y)} sized ${Math.round(box.width)}x${Math.round(box.height)} does not fit viewport ${viewport.width}x${viewport.height}`);
  }
}

/** Wait for the fonts and images this slide draws, so no screenshot catches a blank frame. */
async function settle(page, slideId) {
  await page.evaluate(async (id) => {
    const slide = document.querySelector(`.editor-canvas [data-slide-id="${id}"]`);
    if (!slide) throw new Error(`slide ${id} not mounted`);
    await document.fonts.ready;
    const text = slide.textContent?.trim() ?? "";
    if (text.length > 0) {
      const style = getComputedStyle(slide);
      const families = [style.getPropertyValue("--slide-font-display"), style.getPropertyValue("--slide-font-body")]
        .flatMap((value) => value.split(","))
        .map((family) => family.trim().replace(/^['"]|['"]$/g, ""))
        .filter((family) => family.length > 0 && !["serif", "sans-serif", "monospace"].includes(family));
      await Promise.all(families.map((family) => document.fonts.load(`16px "${family}"`, text).catch(() => undefined)));
    }
    await Promise.all([...slide.querySelectorAll("img")].map((image) => image.decode().catch(() => undefined)));
  }, slideId);
}

const presets = await platformPresets();
const templates = JSON.parse(await readFile(new URL("../content/templates.json", import.meta.url), "utf8"));
const manifest = await previewManifest();
// Write it back out too. The gallery reads content/template-previews.json, and the filenames carry
// a hash of templates.json + the renderer — so rendering without rewriting the manifest leaves the
// page pointing at the files this run just deleted. Doing both here means one command, not two.
await writeFile(
  new URL("../content/template-previews.json", import.meta.url),
  JSON.stringify(manifest, null, 2) + "\n",
);
const expected = new Set(manifest.flatMap((entry) => entry.previews.map((file) => file.split("/").pop())));

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 1200 }, deviceScaleFactor: 1 });
const written = [];

try {
  await page.goto(`${BASE}/${LOCALE}`, { waitUntil: "domcontentloaded" });
  await mkdir(OUT_DIR, { recursive: true });

  for (const entry of manifest) {
    const template = templates.find((item) => item.slug === entry.slug);
    if (!template) throw new Error(`template ${entry.slug} missing from content/templates.json`);
    const canvas = presets[template.document.platform];
    if (!canvas) throw new Error(`unknown platform ${template.document.platform} for ${entry.slug}`);

    // Roomy while the editor mounts, so nothing collapses into a mobile layout. Once the styles
    // below pin the canvas, the viewport shrinks to the exact export size and the frame is the
    // slide; assertFits then catches any layout change that breaks that.
    await page.setViewportSize({ width: canvas.width + 240, height: canvas.height + 240 });

    const draftId = `local-preview-${entry.slug}`;
    await seedDraft(page, draftId, template.document);
    await page.goto(`${BASE}/${LOCALE}/editor/${draftId}`, { waitUntil: "domcontentloaded" });
    // The editor mounts a blank document first and swaps the draft in once IndexedDB
    // answers, so counting before the status settles counts the placeholder.
    await page.getByTestId("draft-status").filter({ hasText: "Saved locally." }).waitFor({ state: "visible", timeout: 30_000 });
    const mounted = await page.locator("[data-editor-slide-id]").count();
    if (mounted !== template.document.slides.length) {
      throw new Error(`${entry.slug}: editor mounted ${mounted} slides, document has ${template.document.slides.length}`);
    }
    // Slide typography is expressed in container query units, so pinning the preview to the
    // export width means the thumbnail has the proportions the exported page will have.
    // Widening the canvas to the export width pushes it under the editor's side panels, so
    // everything outside the canvas is hidden as well — that empties the frame without moving
    // the slide, which any repositioning of the wrapper would do.
    await page.addStyleTag({ content: [
      // Reset the wrapper's centring in flow. Pulling it out with position:absolute instead would
      // uncover the slide list, which lives behind it inside this same canvas and then bleeds its
      // delete buttons into the top of the capture.
      `.editor-canvas div:has(> .orincard-slide){width:${canvas.width}px!important;max-width:none!important;margin:0!important;}`,
      "body *{visibility:hidden!important}",
      ".editor-canvas,.editor-canvas *{visibility:visible!important}",
      // Pinned to the top-left corner so the slide's box starts at 0,0 regardless of how wide
      // the editor's side panels are. Centring the canvas made the offset grow with the window,
      // so there was no viewport size at which a full-width slide fit. With the page itself
      // unscrollable and the viewport set to the export size, the frame is the slide.
      "html,body{overflow:hidden!important;margin:0!important;padding:0!important;height:100%!important}",
      // display:block, not just margin:0 — the canvas is a centring flex container, so the card
      // kept a window-dependent left offset (117px for modern-brief) until the centring was gone.
      ".editor-canvas{display:block!important;position:absolute!important;top:0!important;left:0!important;right:auto!important;bottom:auto!important;margin:0!important;padding:0!important;overflow:visible!important;z-index:2147483647!important}",
      ".editor-canvas > *{margin:0!important;padding:0!important}",
    ].join("\n") });
    await page.setViewportSize({ width: canvas.width, height: canvas.height });

    for (const [index, slide] of template.document.slides.entries()) {
      const trigger = page.locator(`[data-editor-slide-id="${slide.id}"] button[aria-pressed]`);
      if ((await trigger.getAttribute("aria-pressed")) !== "true") await trigger.click();
      await page.locator(`.editor-canvas [data-slide-id="${slide.id}"]`).waitFor({ state: "visible", timeout: 30_000 });
      await settle(page, slide.id);

      // Chromium kept a stale composited tile of the canvas and rastered the slide's single
      // bottom-right arrow a second time across the top edge of every 1080x1920 preview. The
      // arrow exists once in the DOM; only the capture saw two. Detaching and reattaching the
      // canvas invalidates the tiles, and the ghost goes away. Do this last, after any scrolling.
      await page.evaluate(async () => {
        window.scrollTo(0, 0);
        const canvas = document.querySelector(".editor-canvas");
        canvas.style.display = "none";
        void canvas.offsetHeight;
        canvas.style.display = "";
        void canvas.offsetHeight;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      });
      await assertFits(page, entry.slug);
      // Plain viewport capture. Neither locator.screenshot() nor a clip: the first scrolls the
      // element into view and moves the capture window relative to the slide, and the second
      // left a ghost of the bottom-right arrow along the top edge of the tall previews.
      const png = await page.screenshot({ type: "png" });
      const name = entry.previews[index].split("/").pop();
      const pngPath = new URL(`${name}.tmp.png`, OUT_DIR);
      await writeFile(pngPath, png);
      await run("cwebp", ["-q", "82", "-quiet", pngPath.pathname, "-o", new URL(name, OUT_DIR).pathname]);
      await rm(pngPath);
      written.push(name);
      process.stdout.write(`  ${name}\n`);
    }
  }
} finally {
  await browser.close();
}

// Anything left over is a preview for a template or a renderer version that no longer
// exists. Leaving it on disk is how the directory grew to 61 stale files.
for (const file of await readdir(OUT_DIR)) {
  if (!expected.has(file)) await rm(new URL(file, OUT_DIR));
}

await registerLicences(written);

console.log(`rendered ${written.length} previews for ${manifest.length} templates`);
