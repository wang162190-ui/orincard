import { readFile, writeFile } from "node:fs/promises";

const path = new URL("../content/templates.json", import.meta.url);
const templates = JSON.parse(await readFile(path, "utf8"));
const selected = new Set(["clear-idea", "bold-launch", "vertical-story", "modern-brief", "minimal-note", "education-breakdown"]);
for (const template of templates) {
  if (!selected.has(template.slug)) continue;
  template.document.assetRefs = [1, 2].map((i) => ({ id: `local-curated-${template.slug}-0${i}`, kind: "library", mimeType: "image/webp", rightsStatus: "verified" }));
  for (const index of [0, 1]) {
    const slide = template.document.slides[index];
    slide.mode = "text_image";
    slide.layoutId = index === 0 ? "intro-split" : "content-split";
    slide.assetSlots = [{ slotId: `curated-${index + 1}`, assetId: template.document.assetRefs[index].id, fit: "cover", crop: { x: 0, y: 0, width: 1, height: 1 }, opacity: 1, alt: `${template.name} — original editorial illustration` }];
  }
}
await writeFile(path, `${JSON.stringify(templates, null, 2)}\n`);
