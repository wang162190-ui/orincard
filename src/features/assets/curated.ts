/** Public editorial assets. Private user assets never enter this catalog. */
/**
 * One entry per artwork that actually exists on disk. The catalog used to claim six
 * collections of two, but every path resolved to one of three files; the gallery showed
 * the same picture twelve times. Keep this list the size of `public/media/curated/`.
 */
const artworks = [
  {
    slug: "paper-lotus-sphere",
    title: { en: "Paper lotus", "zh-Hans": "纸莲花" },
    alt: {
      en: "A glass sphere resting inside folded cream paper petals with a yellow arc behind",
      "zh-Hans": "奶白纸瓣托起一颗玻璃球，身后是一道黄色弧形",
    },
  },
  {
    slug: "paper-arrow-steps",
    title: { en: "Rising arrow", "zh-Hans": "上升的箭头" },
    alt: {
      en: "A folded yellow paper arrow climbing across pink and cream paper blocks",
      "zh-Hans": "一支折纸黄箭头沿着粉色与米白色纸块向上攀升",
    },
  },
  {
    slug: "paper-crane-cards",
    title: { en: "Paper crane", "zh-Hans": "纸鹤" },
    alt: {
      en: "A blue origami crane beside a yellow paper disc and a stack of cream cards",
      "zh-Hans": "一只蓝色纸鹤，旁边是黄色纸圆与一叠米白卡片",
    },
  },
] as const;

export const curatedAssets = artworks.map((artwork) => ({
  id: artwork.slug,
  refId: `local-curated-${artwork.slug}`,
  title: artwork.title,
  alt: artwork.alt,
  src: `/media/curated/${artwork.slug}.webp`,
  mimeType: "image/webp" as const,
  width: 1536, height: 1024, version: "2",
  provenance: "Original AI-assisted artwork made for Orincard with OpenAI ImageGen. No third-party reference photographs.",
}));

export type CuratedAsset = (typeof curatedAssets)[number];
export function curatedLabel(value: { en: string; "zh-Hans": string }, locale: string) { return locale === "zh-Hans" ? value["zh-Hans"] : value.en; }

export const curatedRenderAssets = Object.fromEntries(curatedAssets.map((asset) => [asset.refId, {
  id: asset.refId, src: asset.src, state: "ready" as const, alt: asset.alt.en, width: asset.width, height: asset.height,
}]));
