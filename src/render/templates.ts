import {
  getPlatformDimensions,
  type CarouselDocument,
  type Platform,
} from "../domain/document";
import type { MotifId } from "./motifs";
import type { TextureId } from "./textures";

export const THEME_IDS = [
  "ink",
  "paper",
  "signal",
  "blush",
  "butter",
  "sky",
  // 矢量系列。和上面六套纸艺主题并列但不混搭：图形层是 background.motif 生成的矢量图（见
  // src/render/motif.tsx），配色也刻意不走 pastel——这是用户要的「另立一套」。
  "prism",
  "pulse",
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
      fontPairId: "serif-sans",
      textScale: 1,
      spacing: "comfortable",
      alignment: "left",
      background: {
        kind: "solid",
        value: "#1F1F1D",
        texture: "diagonal-stripes" satisfies TextureId,
        shape: "offset-circle",
        opacity: 1,
      },
      arrow: "line",
      radius: 32,
      counterStyle: "fraction",
      bulletIcon: "arrow-narrow-right",
    },
    1,
  ),
  paper: defineTheme(
    "paper",
    "Paper",
    {
      paletteId: "paper",
      colors: ["#F5F1E8", "#1F1F1D", "#526CB8"],
      fontPairId: "serif-sans",
      textScale: 1,
      spacing: "comfortable",
      alignment: "left",
      background: {
        kind: "solid",
        value: "#F5F1E8",
        texture: "paper-grain" satisfies TextureId,
        opacity: 1,
      },
      arrow: "line",
      radius: 32,
      counterStyle: "fraction",
      bulletIcon: "point-filled",
    },
    1.05,
  ),
  signal: defineTheme(
    "signal",
    "Signal",
    {
      paletteId: "signal",
      colors: ["#526CB8", "#FAFAF5", "#E7CF62"],
      fontPairId: "sans-serif",
      textScale: 1.04,
      spacing: "spacious",
      alignment: "left",
      background: {
        kind: "solid",
        value: "#526CB8",
        texture: "grid-lines" satisfies TextureId,
        shape: "signal-block",
        opacity: 1,
      },
      arrow: "filled",
      radius: 24,
      counterStyle: "number",
      bulletIcon: "chevron-right",
    },
    0.86,
  ),
  blush: defineTheme(
    "blush",
    "Blush",
    {
      paletteId: "blush",
      colors: ["#E8C8D8", "#1F1F1D", "#B65384"],
      fontPairId: "serif-sans",
      textScale: 1,
      spacing: "comfortable",
      alignment: "center",
      background: {
        kind: "solid",
        value: "#E8C8D8",
        texture: "dot-grid" satisfies TextureId,
        shape: "soft-arc",
        opacity: 1,
      },
      arrow: "line",
      radius: 40,
      counterStyle: "fraction",
      bulletIcon: "sparkles",
    },
    0.95,
  ),
  butter: defineTheme(
    "butter",
    "Butter",
    {
      paletteId: "butter",
      colors: ["#E7CF62", "#1F1F1D", "#A66E3E"],
      fontPairId: "sans-serif",
      textScale: 1,
      spacing: "comfortable",
      alignment: "left",
      background: {
        kind: "solid",
        value: "#E7CF62",
        texture: "scales" satisfies TextureId,
        shape: "corner-disc",
        opacity: 1,
      },
      arrow: "filled",
      radius: 28,
      counterStyle: "number",
      bulletIcon: "bulb-filled",
    },
    1,
  ),
  sky: defineTheme(
    "sky",
    "Sky",
    {
      paletteId: "sky",
      colors: ["#BFD5EB", "#1F1F1D", "#526CB8"],
      fontPairId: "mono-sans",
      textScale: 1,
      spacing: "spacious",
      alignment: "center",
      background: {
        kind: "gradient",
        value: "linear-gradient(145deg, #DDEAF5, #BFD5EB)",
        texture: "concentric-rings" satisfies TextureId,
        shape: "horizon",
        opacity: 1,
      },
      arrow: "line",
      radius: 36,
      counterStyle: "fraction",
      bulletIcon: "circle-check",
    },
    0.92,
  ),
  prism: defineTheme(
    "prism",
    "Prism",
    {
      paletteId: "prism",
      colors: ["#1B1338", "#F7F4FF", "#FF6B9A"],
      fontPairId: "sans-serif",
      textScale: 1.02,
      spacing: "spacious",
      alignment: "left",
      background: {
        kind: "solid",
        value: "#1B1338",
        texture: "halftone" satisfies TextureId,
        motif: "ring" satisfies MotifId,
        opacity: 1,
      },
      arrow: "filled",
      radius: 28,
      counterStyle: "number",
      bulletIcon: "chevron-right",
    },
    0.9,
  ),
  pulse: defineTheme(
    "pulse",
    "Pulse",
    {
      paletteId: "pulse",
      colors: ["#F4F3EF", "#14131A", "#F2452F"],
      fontPairId: "mono-sans",
      textScale: 1,
      spacing: "comfortable",
      alignment: "left",
      background: {
        kind: "solid",
        value: "#F4F3EF",
        texture: "dot-grid" satisfies TextureId,
        motif: "bauhaus" satisfies MotifId,
        opacity: 1,
      },
      arrow: "filled",
      radius: 20,
      counterStyle: "fraction",
      bulletIcon: "arrow-bar-right",
    },
    1,
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

/**
 * 每种画幅能装下多少字，相对 1080×1350 这个基准的倍数。
 *
 * 不是渲染缩放，是**文字容量**——超了就报 TEXT_OVERFLOW 冲突。刻意写成一张显式的表
 * 而不是从尺寸推公式：tiktok 的 1.25 是已发货的实测值（面积比其实是 1.42，1.25 是
 * 留了余量的），硬凑一个能还原它的公式只是假装精确。
 *
 * - `square` 1080×1080 是这里最紧的一块：实测（paper 主题）裁切临界 intro 382 /
 *   content 425 / outro 345 字，换算成倍数是 1.51 / 1.12 / 1.26，最紧的是 1.12。
 *   0.8 比它还保守约三成，保持不动——宁可早报，不要放行裁切。
 * - `presentation` 1920×1080 取 1，与竖版基准同档。**这个 1 是量出来的，不是沿用的**：
 *   横屏行更宽，同样字数占的行数更少，实测在 443 字（语料上限）之前 intro / content /
 *   outro 三种 role 都没有裁切，而 1 对应的告警阈值是 378 字，仍在裁切点之前。
 *
 *   这里有过一次返工，值得留个记号：横屏最初**确实**在 146 字就裁切，当时把这个数调到
 *   0.37 去躲。那是治标——真正的病根在 slide.css 全部用 `cqw`（按容器**宽度**定标），
 *   横屏的宽度是长边，于是竖向被放大约 2.2 倍。病根修掉之后（见 slide.tsx 的
 *   `densityFor`），横屏不再需要任何容量折扣。量法、截图与两次测量见
 *   `docs/acceptance/release.md` 的 D2 一节。
 */
const platformCapacityScale: Record<Platform, number> = {
  linkedin: 1,
  instagram: 1,
  tiktok: 1.25,
  square: 0.8,
  presentation: 1,
};

function collectConflicts(
  document: CarouselDocument,
  theme: ThemeDefinition,
): AppearanceConflict[] {
  const conflicts: AppearanceConflict[] = [];
  const platformScale = platformCapacityScale[document.platform];

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
