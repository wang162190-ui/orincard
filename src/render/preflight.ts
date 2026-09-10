import type { SlideRenderAsset, SlideRenderInput } from "./slide";
import fontManifestJson from "./font-manifest.json";

export const VISUAL_EXPORT_FORMATS = ["png", "jpg", "pdf", "pptx", "mp4"] as const;

export type VisualExportFormat = (typeof VISUAL_EXPORT_FORMATS)[number];
export type PreflightIssueCode =
  | "FONT_NOT_READY"
  | "ASSET_NOT_READY"
  | "ASSET_MISSING"
  | "TEXT_OVERFLOW"
  | "MEASUREMENT_FAILED";

export type PreflightIssue = {
  readonly slideId: string;
  readonly code: PreflightIssueCode;
  readonly repairAction: string;
};

export type TextMeasurement = {
  readonly clientWidth: number;
  readonly clientHeight: number;
  readonly scrollWidth: number;
  readonly scrollHeight: number;
};

export type PreflightMeasurementAdapter = {
  readonly waitForFonts: (input: SlideRenderInput) => Promise<boolean>;
  readonly waitForImage: (
    input: SlideRenderInput,
    asset: SlideRenderAsset,
  ) => Promise<boolean>;
  readonly measureText: (
    input: SlideRenderInput,
  ) => Promise<TextMeasurement | readonly TextMeasurement[]>;
};

export type VisualPreflightResult = {
  readonly ok: boolean;
  readonly issues: readonly PreflightIssue[];
  readonly blockedFormats: readonly VisualExportFormat[];
};

const REPAIR_ACTIONS: Record<PreflightIssueCode, string> = {
  FONT_NOT_READY: "Wait for the selected font to finish loading, then retry.",
  ASSET_NOT_READY: "Wait for the image to finish loading, then retry.",
  ASSET_MISSING: "Choose or upload an available image for this slide.",
  TEXT_OVERFLOW: "Shorten the text, split the slide, or choose a roomier layout.",
  MEASUREMENT_FAILED: "Reload the slide preview, then retry the export check.",
};

function issue(input: SlideRenderInput, code: PreflightIssueCode): PreflightIssue {
  return {
    slideId: input.slide.id,
    code,
    repairAction: REPAIR_ACTIONS[code],
  };
}

type FontManifest = {
  readonly fonts: readonly {
    readonly id: string;
    readonly family: string;
    readonly package: string;
  }[];
};

const FONT_PAIR_MANIFEST_IDS: Readonly<Record<string, readonly string[]>> = {
  "source-serif-inter": [
    "source-serif-4-latin-variable",
    "inter-latin-variable",
    "noto-sans-sc-simplified-400",
  ],
};

function selectedFontFamilies(fontPairId: string): readonly string[] {
  const ids = FONT_PAIR_MANIFEST_IDS[fontPairId];
  if (!ids) {
    return [];
  }

  const manifest = fontManifestJson as FontManifest;
  const entries = ids.map((id) => manifest.fonts.find((font) => font.id === id));
  return entries.every((entry) => entry !== undefined)
    ? entries.map((entry) =>
        entry.package.startsWith("@fontsource-variable/")
          ? `${entry.family} Variable`
          : entry.family,
      )
    : [];
}

function requiredAssetIds(input: SlideRenderInput): readonly (string | null)[] {
  const ids: Array<string | null> = [];
  if (input.slide.mode !== "text") {
    if (input.slide.assetSlots.length === 0) {
      ids.push(null);
    } else {
      ids.push(...input.slide.assetSlots.map((slot) => slot.assetId));
    }
  }

  if (input.slide.role === "intro" || input.slide.role === "outro") {
    const brandAssetId =
      input.brandSnapshot?.headshotAssetId ?? input.brandSnapshot?.logoAssetId;
    if (brandAssetId) {
      ids.push(brandAssetId);
    }
  }

  return ids;
}

async function resourceIssues(
  input: SlideRenderInput,
  adapter: PreflightMeasurementAdapter,
  fontsReady: boolean,
): Promise<PreflightIssue[]> {
  const issues: PreflightIssue[] = [];
  if (!fontsReady) {
    issues.push(issue(input, "FONT_NOT_READY"));
  }

  for (const assetId of requiredAssetIds(input)) {
    const asset = assetId ? input.assets[assetId] : undefined;
    if (!asset || asset.state === "failed") {
      if (!issues.some((current) => current.code === "ASSET_MISSING")) {
        issues.push(issue(input, "ASSET_MISSING"));
      }
      continue;
    }

    let imageReady = false;
    try {
      imageReady = await adapter.waitForImage(input, asset);
    } catch {
      imageReady = false;
    }
    if (
      !imageReady &&
      !issues.some((current) => current.code === "ASSET_NOT_READY")
    ) {
      issues.push(issue(input, "ASSET_NOT_READY"));
    }
  }

  return issues;
}

function hasOverflow(measurement: TextMeasurement): boolean {
  return (
    measurement.scrollWidth > measurement.clientWidth ||
    measurement.scrollHeight > measurement.clientHeight
  );
}

function hasUsableBounds(measurement: TextMeasurement): boolean {
  return measurement.clientWidth > 0 && measurement.clientHeight > 0;
}

export async function preflightVisualExport(
  inputs: readonly SlideRenderInput[],
  adapter: PreflightMeasurementAdapter,
): Promise<VisualPreflightResult> {
  const issues: PreflightIssue[] = [];
  for (const input of inputs) {
    let fontsReady = false;
    try {
      fontsReady = await adapter.waitForFonts(input);
    } catch {
      fontsReady = false;
    }
    const currentIssues = await resourceIssues(input, adapter, fontsReady);
    issues.push(...currentIssues);
    if (currentIssues.length > 0) {
      continue;
    }

    try {
      const measured = await adapter.measureText(input);
      const measurements = Array.isArray(measured) ? measured : [measured];
      const usableMeasurements = measurements.filter(hasUsableBounds);
      if (usableMeasurements.length === 0) {
        issues.push(issue(input, "MEASUREMENT_FAILED"));
      } else if (usableMeasurements.some(hasOverflow)) {
        issues.push(issue(input, "TEXT_OVERFLOW"));
      }
    } catch {
      issues.push(issue(input, "MEASUREMENT_FAILED"));
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    blockedFormats: issues.length === 0 ? [] : VISUAL_EXPORT_FORMATS,
  };
}

function findSlide(root: ParentNode, slideId: string): HTMLElement | null {
  const candidate = root as ParentNode & Partial<Element>;
  if (candidate.matches?.("[data-slide-id]") && candidate.getAttribute?.("data-slide-id") === slideId) {
    return candidate as HTMLElement;
  }

  return (
    Array.from(root.querySelectorAll<HTMLElement>("[data-slide-id]")).find(
      (element) => element.dataset.slideId === slideId,
    ) ?? null
  );
}

function ownerDocument(root: ParentNode): Document | null {
  return root.nodeType === 9 ? (root as Document) : (root as Node).ownerDocument;
}

export function createDomPreflightAdapter(root: ParentNode): PreflightMeasurementAdapter {
  return {
    async waitForFonts(input) {
      const fonts = ownerDocument(root)?.fonts;
      const families = selectedFontFamilies(input.theme.fontPairId);
      if (
        !fonts ||
        typeof fonts.check !== "function" ||
        typeof fonts.load !== "function" ||
        families.length === 0
      ) {
        return false;
      }

      // Gate on the glyphs this slide actually renders, not on the whole family. A CJK
      // webfont ships as ~100 unicode-range subsets and a browser only fetches the subsets
      // a rendered glyph needs, so "every face reports loaded" is never true on a real page
      // and would block every export. Asking for the slide's own text loads exactly the
      // subsets the export will draw with, which is what FONT_NOT_READY is meant to catch.
      const slide = findSlide(root, input.slide.id);
      if (!slide) {
        return false;
      }
      const text = slide.textContent?.trim() ?? "";
      if (text.length === 0) {
        // Nothing to typeset, so no glyph can render in a fallback face.
        return true;
      }

      await fonts.ready;
      const ready = await Promise.all(
        families.map(async (family) => {
          const font = `16px "${family}"`;
          try {
            await fonts.load(font, text);
          } catch {
            return false;
          }
          return fonts.check(font, text);
        }),
      );
      return ready.every(Boolean);
    },

    async waitForImage(input, asset) {
      const slide = findSlide(root, input.slide.id);
      const image = Array.from(
        slide?.querySelectorAll<HTMLImageElement>("img[data-asset-id]") ?? [],
      ).find((element) => element.dataset.assetId === asset.id);
      if (!image) {
        return false;
      }

      if (typeof image.decode === "function") {
        try {
          await image.decode();
        } catch {
          return false;
        }
      }
      return image.complete && image.naturalWidth > 0;
    },

    async measureText(input) {
      const slide = findSlide(root, input.slide.id);
      if (!slide) {
        throw new Error(`Slide ${input.slide.id} is not rendered.`);
      }

      // Measure the text-bearing boxes, not the card itself. A theme's background shape is
      // absolutely positioned past the card edge on purpose and clipped by the card's
      // `overflow: hidden`, so the card's own scrollWidth/scrollHeight report that bleed as
      // if it were clipped text — five of the six themes ship such a shape. Each
      // data-slide-content box is height- and width-constrained by the card, so text that
      // does not fit still surfaces as scroll > client on the box that holds it.
      const content = slide.querySelectorAll<HTMLElement>("[data-slide-content]");
      const measured = content.length > 0 ? Array.from(content) : [slide];
      return measured.map((element) => ({
        clientWidth: element.clientWidth,
        clientHeight: element.clientHeight,
        scrollWidth: element.scrollWidth,
        scrollHeight: element.scrollHeight,
      }));
    },
  };
}
