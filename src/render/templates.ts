import {
  getPlatformDimensions,
  type CarouselDocument,
  type Platform,
} from "../domain/document";

export const THEME_IDS = [
  "ink",
  "paper",
  "signal",
  "blush",
  "butter",
  "sky",
] as const;

export type ThemeId = (typeof THEME_IDS)[number];
type Slide = CarouselDocument["slides"][number];
type SlideRole = Slide["role"];
type SlideMode = Slide["mode"];
type Layouts = Record<SlideRole, Record<SlideMode, readonly string[]>>;

export interface ThemeDefinition {
  readonly id: ThemeId;
  readonly name: string;
  readonly templateId: ThemeId;
  readonly templateVersion: 1;
  readonly settings: CarouselDocument["theme"];
  readonly layouts: Layouts;
  readonly capacityScale: number;
}

export type AppearanceConflictCode =
  | "ASSET_REQUIRED"
  | "LAYOUT_UNSUPPORTED"
  | "TEXT_CAPACITY_REVIEW";

export interface AppearanceConflict {
  readonly slideId: string;
  readonly code: AppearanceConflictCode;
  readonly message: string;
  readonly repairAction: string;
}

export interface AppearancePreview {
  readonly document: CarouselDocument;
  readonly canvas: {
    readonly width: number;
    readonly height: number;
  };
  readonly conflicts: readonly AppearanceConflict[];
}

export interface AppearanceSelection {
  readonly themeId?: ThemeId;
  readonly platform?: Platform;
}

const layouts: Layouts = {
  intro: {
    text: ["intro-centered", "intro-editorial"],
    text_image: ["intro-split"],
    image: ["intro-overlay"],
    screenshot: ["intro-screenshot"],
  },
  content: {
    text: ["statement", "numbered-point", "quote", "content-editorial"],
    text_image: ["content-split"],
    image: ["image-overlay"],
    screenshot: ["browser-frame"],
  },
  outro: {
    text: ["outro-cta", "outro-centered"],
    text_image: ["outro-split"],
    image: ["outro-overlay"],
    screenshot: ["outro-screenshot"],
  },
};

function defineTheme(
  id: ThemeId,
  name: string,
  settings: CarouselDocument["theme"],
  capacityScale: number,
): ThemeDefinition {
  return {
    id,
    name,
    templateId: id,
    templateVersion: 1,
    settings,
    layouts,
    capacityScale,
  };
}

export const themes: Record<ThemeId, ThemeDefinition> = {
  ink: defineTheme(
    "ink",
    "Ink",
    {
      paletteId: "ink",
      colors: ["#1F1F1D", "#F5F1E8", "#E7CF62"],
      fontPairId: "source-serif-inter",
      textScale: 1,
      spacing: "comfortable",
      alignment: "left",
      background: {
        kind: "solid",
        value: "#1F1F1D",
        shape: "offset-circle",
        opacity: 1,
      },
      arrow: "line",
      radius: 32,
      counterStyle: "fraction",
    },
    1,
  ),
  paper: defineTheme(
    "paper",
    "Paper",
    {
      paletteId: "paper",
      colors: ["#F5F1E8", "#1F1F1D", "#526CB8"],
      fontPairId: "source-serif-inter",
      textScale: 1,
      spacing: "comfortable",
      alignment: "left",
      background: {
        kind: "solid",
        value: "#F5F1E8",
        texture: "paper-grain",
        opacity: 1,
      },
      arrow: "line",
      radius: 32,
      counterStyle: "fraction",
    },
    1.05,
  ),
  signal: defineTheme(
    "signal",
    "Signal",
    {
      paletteId: "signal",
      colors: ["#526CB8", "#FAFAF5", "#E7CF62"],
      fontPairId: "source-serif-inter",
      textScale: 1.04,
      spacing: "spacious",
      alignment: "left",
      background: {
        kind: "solid",
        value: "#526CB8",
        shape: "signal-block",
        opacity: 1,
      },
      arrow: "filled",
      radius: 24,
      counterStyle: "number",
    },
    0.86,
  ),
  blush: defineTheme(
    "blush",
    "Blush",
    {
      paletteId: "blush",
      colors: ["#E8C8D8", "#1F1F1D", "#B65384"],
      fontPairId: "source-serif-inter",
      textScale: 1,
      spacing: "comfortable",
      alignment: "center",
      background: {
        kind: "solid",
        value: "#E8C8D8",
        shape: "soft-arc",
        opacity: 1,
      },
      arrow: "line",
      radius: 40,
      counterStyle: "fraction",
    },
    0.95,
  ),
  butter: defineTheme(
    "butter",
    "Butter",
    {
      paletteId: "butter",
      colors: ["#E7CF62", "#1F1F1D", "#A66E3E"],
      fontPairId: "source-serif-inter",
      textScale: 1,
      spacing: "comfortable",
      alignment: "left",
      background: {
        kind: "solid",
        value: "#E7CF62",
        shape: "corner-disc",
        opacity: 1,
      },
      arrow: "filled",
      radius: 28,
      counterStyle: "number",
    },
    1,
  ),
  sky: defineTheme(
    "sky",
    "Sky",
    {
      paletteId: "sky",
      colors: ["#BFD5EB", "#1F1F1D", "#526CB8"],
      fontPairId: "source-serif-inter",
      textScale: 1,
      spacing: "spacious",
      alignment: "center",
      background: {
        kind: "gradient",
        value: "linear-gradient(145deg, #DDEAF5, #BFD5EB)",
        shape: "horizon",
        opacity: 1,
      },
      arrow: "line",
      radius: 36,
      counterStyle: "fraction",
    },
    0.92,
  ),
};

const textCapacity: Record<SlideRole, Record<SlideMode, number>> = {
  intro: { text: 240, text_image: 170, image: 120, screenshot: 130 },
  content: { text: 360, text_image: 240, image: 150, screenshot: 180 },
  outro: { text: 260, text_image: 180, image: 120, screenshot: 140 },
};

const assetModes = new Set<SlideMode>(["text_image", "image", "screenshot"]);

function cloneThemeSettings(
  settings: CarouselDocument["theme"],
): CarouselDocument["theme"] {
  return {
    ...settings,
    colors: settings.colors ? [...settings.colors] : undefined,
    background: { ...settings.background },
  };
}

function textLength(slide: Slide): number {
  const bodyLength = slide.bodyBlocks.reduce((total, block) => {
    if (block.kind === "bullets") {
      return total + block.items.reduce((sum, item) => sum + Array.from(item).length, 0);
    }
    return total + Array.from(block.text).length;
  }, 0);

  return [slide.eyebrow, slide.title, slide.cta].reduce(
    (total, value) => total + Array.from(value ?? "").length,
    bodyLength,
  );
}

function collectConflicts(
  document: CarouselDocument,
  theme: ThemeDefinition,
): AppearanceConflict[] {
  const conflicts: AppearanceConflict[] = [];
  const platformScale = document.platform === "tiktok" ? 1.25 : 1;

  for (const slide of document.slides) {
    if (!theme.layouts[slide.role][slide.mode].includes(slide.layoutId)) {
      conflicts.push({
        slideId: slide.id,
        code: "LAYOUT_UNSUPPORTED",
        message: `${theme.name} does not support the current ${slide.mode} layout.`,
        repairAction: "Choose a supported layout before exporting.",
      });
    }

    if (assetModes.has(slide.mode) && slide.assetSlots.length === 0) {
      conflicts.push({
        slideId: slide.id,
        code: "ASSET_REQUIRED",
        message: `The ${slide.mode} layout has no attached asset.`,
        repairAction: "Attach an image or switch this slide to a text layout.",
      });
    }

    const capacity =
      textCapacity[slide.role][slide.mode] * theme.capacityScale * platformScale;
    if (textLength(slide) > capacity) {
      conflicts.push({
        slideId: slide.id,
        code: "TEXT_CAPACITY_REVIEW",
        message: "This copy may not fit the selected theme at a readable size.",
        repairAction: "Shorten the copy, split the slide, or choose a roomier layout.",
      });
    }
  }

  return conflicts;
}

export function getThemeId(document: CarouselDocument): ThemeId {
  const templateId = THEME_IDS.find((id) => id === document.templateId);
  if (templateId) {
    return templateId;
  }

  const paletteId = THEME_IDS.find((id) => id === document.theme.paletteId);
  return paletteId ?? "paper";
}

export function previewAppearance(
  document: CarouselDocument,
  selection: AppearanceSelection,
): AppearancePreview {
  const platform = selection.platform ?? document.platform;
  const theme = themes[selection.themeId ?? getThemeId(document)];
  const nextDocument: CarouselDocument = selection.themeId
    ? {
        ...document,
        platform,
        templateId: theme.templateId,
        templateVersion: theme.templateVersion,
        theme: cloneThemeSettings(theme.settings),
      }
    : { ...document, platform };

  return {
    document: nextDocument,
    canvas: getPlatformDimensions(platform),
    conflicts: collectConflicts(nextDocument, theme),
  };
}
