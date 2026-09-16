import { readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
export async function previewManifest() {
  const templates = JSON.parse(await readFile(new URL("../content/templates.json", import.meta.url), "utf8"));
  const renderer = await Promise.all(["slide.tsx", "slide.css", "templates.ts"].map((name) => readFile(new URL(`../src/render/${name}`, import.meta.url))));
  return templates.map((template) => {
    const version = createHash("sha256").update(JSON.stringify(template.document)).update(Buffer.concat(renderer)).digest("hex").slice(0, 12);
    const files = template.document.slides.map((_, index) => `/media/templates/${template.slug}-${version}-${index + 1}.png`);
    return { slug: template.slug, name: template.name, description: template.description, category: template.category, platform: template.document.platform, templateId: template.document.templateId, slideCount: template.document.slides.length, hasImages: template.document.assetRefs.length > 0, thumbnail: files[0], previews: files, previewVersion: version };
  });
}
if (process.argv.includes("--write")) await writeFile(new URL("../content/template-previews.json", import.meta.url), JSON.stringify(await previewManifest(), null, 2) + "\n");
