/**
 * The font pairs a theme may name, and everything each consumer needs to honour one.
 *
 * This file exists because the pairs used to be described in four places that had drifted apart:
 * the brand editor offered three ids, while the renderer, the preflight check and the PPTX exporter
 * only knew `source-serif-inter` — so two of the three choices silently did nothing. Anything that
 * resolves a pair now reads this table, and tests/unit/font-pairs.test.ts fails if a consumer or
 * the brand editor knows an id this table does not.
 *
 * **中文一律是 Noto Sans SC，各配对不做区分。** src/render/render-deck.ts 会把每个 manifest 条目
 * base64 内联进导出 HTML，而 fontsource 的中文包只有切成 unicode-range 分片的才控得住体积
 * （Noto Sans SC 的 chinese-simplified 子集约 1.1MB）。霞鹜文楷整包 56MB 只有 23 个文件、没有分片，
 * 单个 woff2 就有数 MB；Noto Serif SC 有分片但整包 87MB，本机拉不下来。等哪天换成按需子集化，
 * 再给衬线配对配一套中文衬线。
 */

/** A family stack, plus the single family PPTX gets — PowerPoint takes one name, not a stack. */
export type FontRole = {
  /** CSS `font-family` value, latin first and the CJK face behind it. */
  readonly css: string;
  /** Family PPTX uses for latin runs. */
  readonly pptx: string;
};

export type FontPair = {
  /** Message key under `brands` in `messages/*.json`. */
  readonly labelKey: string;
  readonly display: FontRole;
  readonly body: FontRole;
  /** Entries in src/render/font-manifest.json this pair needs inlined. */
  readonly manifestIds: readonly string[];
};

/** Every pair falls back to this for CJK; see the file comment for why there is only one. */
export const CJK_FAMILY = "Noto Sans SC";

const CJK_IDS = ["noto-sans-sc-simplified-400", "noto-sans-sc-simplified-700"] as const;

const INTER: FontRole = {
  css: `"Inter Variable", "${CJK_FAMILY}", sans-serif`,
  pptx: "Inter",
};
const SOURCE_SERIF: FontRole = {
  css: `"Source Serif 4 Variable", "${CJK_FAMILY}", serif`,
  pptx: "Source Serif 4",
};
const JETBRAINS_MONO: FontRole = {
  css: `"JetBrains Mono Variable", "${CJK_FAMILY}", monospace`,
  pptx: "JetBrains Mono",
};

export const FONT_PAIRS: Readonly<Record<string, FontPair>> = {
  "serif-sans": {
    labelKey: "fontSerifSans",
    display: SOURCE_SERIF,
    body: INTER,
    manifestIds: ["source-serif-4-latin-variable", "inter-latin-variable", ...CJK_IDS],
  },
  "sans-serif": {
    labelKey: "fontSansSerif",
    display: INTER,
    body: SOURCE_SERIF,
    manifestIds: ["inter-latin-variable", "source-serif-4-latin-variable", ...CJK_IDS],
  },
  "mono-sans": {
    labelKey: "fontMonoSans",
    display: JETBRAINS_MONO,
    body: INTER,
    manifestIds: ["jetbrains-mono-latin-variable", "inter-latin-variable", ...CJK_IDS],
  },
};

export const DEFAULT_FONT_PAIR_ID = "serif-sans";

export const FONT_PAIR_IDS = Object.keys(FONT_PAIRS);

/**
 * Ids that shipped before the pairs were named after what they are.
 *
 * Documents are stored, so a deck saved against the old id has to keep rendering in the fonts it
 * was designed in; `serif-sans` is the same two families under a truthful name.
 */
const ALIASES: Readonly<Record<string, string>> = {
  "source-serif-inter": "serif-sans",
};

/** The pair a theme names, or the default when it names one this build does not know. */
export function resolveFontPair(fontPairId: string): FontPair {
  return FONT_PAIRS[ALIASES[fontPairId] ?? fontPairId] ?? FONT_PAIRS[DEFAULT_FONT_PAIR_ID];
}
