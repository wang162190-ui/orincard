import { mkdir } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import baseDocumentFixture from "../fixtures/base-document.json" with { type: "json" };
import corpusFixture from "../fixtures/corpus.json" with { type: "json" };
import {
  DEFAULT_SLIDE_COUNT,
  MAX_SLIDE_COUNT,
  MIN_SLIDE_COUNT,
  getPlatformDimensions,
  parseCarouselDocument,
  platformPresets,
  type CarouselDocument,
  type Platform,
} from "../../src/domain/document";
import { createRequire } from "node:module";
import type {
  PreflightMeasurementAdapter,
  TextMeasurement,
} from "../../src/render/preflight";
import { THEME_IDS, previewAppearance, type ThemeId } from "../../src/render/templates";
import type { SlideRenderInput } from "../../src/render/slide";

// `src/render/preflight.ts` imports `font-manifest.json` without an import
// attribute, which Node's ESM linker rejects when Playwright loads the module
// graph. Requiring it goes through Playwright's CommonJS transform, where the
// JSON import is a plain `require` — same shipped classifier, no source change.
const { VISUAL_EXPORT_FORMATS, preflightVisualExport } = createRequire(
  import.meta.url,
)("../../src/render/preflight") as typeof import("../../src/render/preflight");

type Slide = CarouselDocument["slides"][number];

const captureVisuals = process.env.ORINCARD_CAPTURE_VISUALS === "1";

// The matrix dimensions are the shipped constants, never a second list kept in the test.
const PLATFORMS = Object.keys(platformPresets) as readonly Platform[];
const PAGE_COUNTS = [MIN_SLIDE_COUNT, DEFAULT_SLIDE_COUNT, MAX_SLIDE_COUNT] as const;

const SESSION_ID = "session-visual-matrix";
const DRAFT_DATABASE = "orincard-local-drafts";
const DRAFT_STORE = "drafts";

const baseDocument = parseCarouselDocument(baseDocumentFixture);
const introTemplate = baseDocument.slides[0];
const outroTemplate = baseDocument.slides[baseDocument.slides.length - 1];
const contentTemplates = baseDocument.slides.filter((slide) => slide.role === "content");

type CorpusSample = {
  readonly id: string;
  readonly material: { readonly kind: string; readonly text?: string };
};

function corpusText(id: string): string {
  const sample = (corpusFixture.samples as readonly CorpusSample[]).find(
    (candidate) => candidate.id === id,
  );
  const text = sample?.material.kind === "inline" ? sample.material.text : undefined;
  if (!text) {
    throw new Error(`Corpus sample ${id} carries no inline material.`);
  }
  return text;
}

// Text boundaries come from the T090 corpus so every string on a rendered page has a
// declared rights id. Nothing here is newly authored copy.
const chineseWithEmoji = corpusText("topic-zh-emoji");
const longUnbrokenToken = corpusText("text-long-token");
const mixedScriptSentences = corpusText("text-zh-en-mixed")
  .split(/(?<=。)/u)
  .map((sentence) => sentence.trim())
  .filter((sentence) => sentence.length > 0);

const BOUNDARY_TEXTS = [chineseWithEmoji, ...mixedScriptSentences];

function withText(slide: Slide, text: string): Slide {
  // Some fixture layouts ship a title only. Every content page in the matrix has to
  // carry boundary text, so an empty slide gets the paragraph it is missing.
  if (slide.bodyBlocks.length === 0) {
    return {
      ...slide,
      bodyBlocks: [{ kind: "paragraph", text, emphasisRanges: [] }],
    };
  }

  return {
    ...slide,
    bodyBlocks: slide.bodyBlocks.map((block) => {
      switch (block.kind) {
        case "paragraph":
          return { ...block, text, emphasisRanges: [] };
        case "quote":
          return { ...block, text };
        case "bullets":
          return { ...block, items: [text] };
      }
    }),
  };
}

function matrixDocument(input: {
  readonly themeId: ThemeId;
  readonly platform: Platform;
  readonly pageCount: number;
}): CarouselDocument {
  const contentCount = input.pageCount - 2;
  const slides: Slide[] = [
    introTemplate,
    ...Array.from({ length: contentCount }, (_unused, index) =>
      withText(
        contentTemplates[index % contentTemplates.length],
        BOUNDARY_TEXTS[index % BOUNDARY_TEXTS.length],
      ),
    ),
    outroTemplate,
  ].map((slide, index) => ({ ...slide, id: `local-matrix-slide-${index + 1}` }));

  const preview = previewAppearance(
    parseCarouselDocument({ ...baseDocument, slides }),
    { themeId: input.themeId, platform: input.platform },
  );

  // The appearance model owns the fit rules. A document that already conflicts would
  // make a preflight failure ambiguous, so the fixture has to be clean before it renders.
  expect(preview.conflicts, `${input.themeId}/${input.platform}/${input.pageCount}`).toEqual([]);
  expect(preview.canvas).toEqual(getPlatformDimensions(input.platform));

  return preview.document;
}

function renderInputs(document: CarouselDocument): readonly SlideRenderInput[] {
  return document.slides.map((slide, index) => ({
    slide,
    platform: document.platform,
    theme: document.theme,
    brandSnapshot: document.brandSnapshot,
    assets: {},
    slideNumber: index + 1,
    slideCount: document.slides.length,
  }));
}

// The editor keeps anonymous drafts in IndexedDB, so the matrix seeds a draft the same
// way the browser would and then asserts the editor really loaded it. The key shape
// mirrors LocalDraftStore; the assertions after the load fail loudly if it ever drifts.
async function seedDraft(page: Page, draftId: string, document: CarouselDocument) {
  await page.evaluate(
    async ({ databaseName, storeName, sessionId, id, seeded }) => {
      localStorage.setItem("orincard-anonymous-session", sessionId);
      const database = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(databaseName, 1);
        request.onupgradeneeded = () => {
          const store = request.result.createObjectStore(storeName, { keyPath: "key" });
          store.createIndex("owner", "ownerKey", { unique: false });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const now = Date.now();
      await new Promise<void>((resolve, reject) => {
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
    },
    {
      databaseName: DRAFT_DATABASE,
      storeName: DRAFT_STORE,
      sessionId: SESSION_ID,
      id: draftId,
      seeded: document as unknown as Record<string, unknown>,
    },
  );
}

async function openDraft(page: Page, draftId: string, document: CarouselDocument) {
  await seedDraft(page, draftId, document);
  await page.goto(`/editor/${draftId}`);
  await expect(page.getByTestId("draft-status")).toHaveText("Saved locally.");
  await expect(page.locator("[data-editor-slide-id]")).toHaveCount(document.slides.length);
  // Pin the preview to the platform's export width. Slide typography is expressed in
  // container query units, so measuring at the exported width measures the exported page.
  await page.addStyleTag({
    content: `.editor-canvas div:has(> .orincard-slide){width:${getPlatformDimensions(document.platform).width}px!important;max-width:none!important;}`,
  });
}

async function selectSlide(page: Page, slideId: string) {
  const trigger = page.locator(`[data-editor-slide-id="${slideId}"] button[aria-pressed]`);
  if ((await trigger.getAttribute("aria-pressed")) !== "true") {
    await trigger.click();
  }
  await expect(page.locator(".editor-canvas [data-slide-id]")).toHaveAttribute(
    "data-slide-id",
    slideId,
  );
}

// The browser half of createDomPreflightAdapter, driven from the test process: the same
// [data-slide-id] / [data-slide-content] / img[data-asset-id] contract and the same
// document.fonts gate, evaluated inside the page because the shipped adapter needs a
// live layout the Node process does not have. Classification stays in
// preflightVisualExport so the issue codes are the product's, not the test's.
function canvasPreflightAdapter(page: Page): PreflightMeasurementAdapter {
  return {
    async waitForFonts(input) {
      await selectSlide(page, input.slide.id);
      return page.evaluate(async (slideId) => {
        await document.fonts.ready;
        const slide = document.querySelector<HTMLElement>(
          `.editor-canvas [data-slide-id="${slideId}"]`,
        );
        if (!slide) {
          return false;
        }
        const style = getComputedStyle(slide);
        const families = [
          style.getPropertyValue("--slide-font-display"),
          style.getPropertyValue("--slide-font-body"),
        ]
          .flatMap((value) => value.split(","))
          .map((family) => family.trim().replace(/^['"]|['"]$/g, ""))
          .filter(
            (family) =>
              family.length > 0 && !["serif", "sans-serif", "monospace"].includes(family),
          );
        if (families.length === 0) {
          return false;
        }
        // Same gate as the shipped createDomPreflightAdapter: ask for the glyphs this slide
        // actually draws. Noto Sans SC ships as ~100 unicode-range subsets, so checking the
        // bare family is false on any page that has not rendered CJK yet.
        const text = slide.textContent?.trim() ?? "";
        if (text.length === 0) {
          return true;
        }
        const ready = await Promise.all(
          families.map(async (family) => {
            const font = `16px "${family}"`;
            try {
              await document.fonts.load(font, text);
            } catch {
              return false;
            }
            return document.fonts.check(font, text);
          }),
        );
        return ready.every(Boolean);
      }, input.slide.id);
    },

    async waitForImage(input, asset) {
      await selectSlide(page, input.slide.id);
      return page.evaluate(
        async ({ slideId, assetId }) => {
          const image = document.querySelector<HTMLImageElement>(
            `.editor-canvas [data-slide-id="${slideId}"] img[data-asset-id="${assetId}"]`,
          );
          if (!image) {
            return false;
          }
          try {
            await image.decode();
          } catch {
            return false;
          }
          return image.complete && image.naturalWidth > 0;
        },
        { slideId: input.slide.id, assetId: asset.id },
      );
    },

    async measureText(input) {
      await selectSlide(page, input.slide.id);
      const measurements = await page.evaluate((slideId) => {
        const slide = document.querySelector<HTMLElement>(
          `.editor-canvas [data-slide-id="${slideId}"]`,
        );
        if (!slide) {
          return null;
        }
        // Same boxes as the shipped createDomPreflightAdapter: the card itself is excluded
        // because a theme's background shape bleeds past its edge by design and is clipped
        // by `overflow: hidden`, which the card's scrollWidth/scrollHeight cannot tell apart
        // from clipped text.
        const content = slide.querySelectorAll<HTMLElement>("[data-slide-content]");
        return (content.length > 0 ? Array.from(content) : [slide]).map(
          (element) => ({
            clientWidth: element.clientWidth,
            clientHeight: element.clientHeight,
            scrollWidth: element.scrollWidth,
            scrollHeight: element.scrollHeight,
          }),
        );
      }, input.slide.id);

      if (!measurements) {
        throw new Error(`Slide ${input.slide.id} is not rendered.`);
      }
      return measurements as readonly TextMeasurement[];
    },
  };
}

async function capture(page: Page, name: string) {
  if (!captureVisuals) {
    return;
  }
  await mkdir("output/playwright", { recursive: true });
  await page
    .locator(".editor-canvas .orincard-slide")
    .screenshot({ path: `output/playwright/${name}.png` });
}

for (const themeId of THEME_IDS) {
  test(`${themeId} exports every platform and page count without clipped text or unresolved resources`, async ({
    page,
  }) => {
    test.setTimeout(10 * 60_000);
    await page.setViewportSize({ width: 1440, height: 1200 });
    await page.goto("/");

    const adapter = canvasPreflightAdapter(page);
    for (const platform of PLATFORMS) {
      for (const pageCount of PAGE_COUNTS) {
        const combination = `${themeId}-${platform}-${pageCount}`;
        const document = matrixDocument({ themeId, platform, pageCount });
        await openDraft(page, `local-matrix-${combination}`, document);

        const result = await preflightVisualExport(renderInputs(document), adapter);

        expect(result.issues, combination).toEqual([]);
        expect(result.blockedFormats, combination).toEqual([]);
        expect(result.ok, combination).toBe(true);

        await selectSlide(page, document.slides[0].id);
        await capture(page, `export-matrix-${combination}`);
      }
    }
  });
}

test("reports the unbroken token in the corpus instead of clipping it", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");

  const document = (() => {
    const slides = matrixDocument({
      themeId: "paper",
      platform: "linkedin",
      pageCount: MIN_SLIDE_COUNT,
    }).slides;
    return parseCarouselDocument({
      ...baseDocument,
      slides: slides.map((slide, index) =>
        index === 1 ? withText({ ...slide, title: longUnbrokenToken }, longUnbrokenToken) : slide,
      ),
    });
  })();
  await openDraft(page, "local-matrix-overflow-control", document);

  const result = await preflightVisualExport(renderInputs(document), canvasPreflightAdapter(page));

  expect(result.issues).toContainEqual(
    expect.objectContaining({ slideId: document.slides[1].id, code: "TEXT_OVERFLOW" }),
  );
  expect(result.blockedFormats).toEqual(VISUAL_EXPORT_FORMATS);
  expect(result.ok).toBe(false);
});

test("reports a slide whose image slot has no asset", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 });
  await page.goto("/");

  const slides = matrixDocument({
    themeId: "paper",
    platform: "linkedin",
    pageCount: MIN_SLIDE_COUNT,
  }).slides;
  const document = parseCarouselDocument({
    ...baseDocument,
    slides: slides.map((slide, index) =>
      index === 1
        ? { ...slide, mode: "image", layoutId: "image-overlay", assetSlots: [] }
        : slide,
    ),
  });
  await openDraft(page, "local-matrix-asset-control", document);

  const result = await preflightVisualExport(renderInputs(document), canvasPreflightAdapter(page));

  expect(result.issues).toContainEqual(
    expect.objectContaining({ slideId: document.slides[1].id, code: "ASSET_MISSING" }),
  );
  expect(result.blockedFormats).toEqual(VISUAL_EXPORT_FORMATS);
  expect(result.ok).toBe(false);
});
