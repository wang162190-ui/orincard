/** Public editorial assets. Private user assets never enter this catalog. */
const collections = [
  ["clear-idea", "Clear ideas", "知识解释", "Layered paper and light", "纸张与光线"],
  ["bold-launch", "Product launch", "产品发布", "An idea takes flight", "让想法起飞"],
  ["vertical-story", "Storytelling", "故事叙述", "A journey in paper", "纸上的旅程"],
  ["modern-brief", "Editorial brief", "简报解读", "Order from complexity", "从复杂到有序"],
  ["minimal-note", "Simple notes", "简洁笔记", "Room to think", "留白与思考"],
  ["education-breakdown", "Step by step", "教程拆解", "Building understanding", "搭建理解"],
] as const;

export const curatedAssets = collections.flatMap(([collection, en, zh, altEn, altZh]) => [1, 2].map((number) => ({
  id: `${collection}-${String(number).padStart(2, "0")}`,
  refId: `local-curated-${collection}-${String(number).padStart(2, "0")}`,
  collection,
  title: { en: `${en} ${number}`, "zh-Hans": `${zh} ${number}` },
  alt: { en: altEn, "zh-Hans": altZh },
  src: `/media/curated/${collection}-${String(number).padStart(2, "0")}.png`,
  width: 1536, height: 1024, version: "1",
  provenance: "Original AI-assisted artwork made for Orincard with OpenAI ImageGen. No third-party reference photographs.",
})));

export type CuratedAsset = (typeof curatedAssets)[number];
export function curatedLabel(value: { en: string; "zh-Hans": string }, locale: string) { return locale === "zh-Hans" ? value["zh-Hans"] : value.en; }

export const curatedRenderAssets = Object.fromEntries(curatedAssets.map((asset) => [asset.refId, {
  id: asset.refId, src: asset.src, state: "ready" as const, alt: asset.alt.en, width: asset.width, height: asset.height,
}]));
