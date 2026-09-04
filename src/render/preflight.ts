import type { SlideRenderAsset, SlideRenderInput } from "./slide";

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
  readonly measureText: (input: SlideRenderInput) => Promise<TextMeasurement>;
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

function requiredAssetIds(input: SlideRenderInput): readonly (string | null)[] {
  const ids: Array<string | null> = [];
  if (input.slide.mode !== "text") {
    ids.push(input.slide.assetSlots[0]?.assetId ?? null);
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
  let fontsReady = false;
  if (inputs.length > 0) {
    try {
      fontsReady = await adapter.waitForFonts(inputs[0]);
    } catch {
      fontsReady = false;
    }
  }

  const issues: PreflightIssue[] = [];
  for (const input of inputs) {
    const currentIssues = await resourceIssues(input, adapter, fontsReady);
    issues.push(...currentIssues);
    if (currentIssues.length > 0) {
      continue;
    }

    try {
      const measurement = await adapter.measureText(input);
      if (!hasUsableBounds(measurement)) {
        issues.push(issue(input, "MEASUREMENT_FAILED"));
      } else if (hasOverflow(measurement)) {
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
    async waitForFonts() {
      const fonts = ownerDocument(root)?.fonts;
      if (!fonts) {
        return false;
      }
      await fonts.ready;
      return fonts.status === "loaded";
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
      const content = findSlide(root, input.slide.id)?.querySelector<HTMLElement>(
        "[data-slide-content]",
      );
      if (!content) {
        throw new Error(`Slide ${input.slide.id} is not rendered.`);
      }

      return {
        clientWidth: content.clientWidth,
        clientHeight: content.clientHeight,
        scrollWidth: content.scrollWidth,
        scrollHeight: content.scrollHeight,
      };
    },
  };
}
