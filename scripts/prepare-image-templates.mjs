import { readFile, writeFile } from "node:fs/promises";

// One artwork per template. There are three curated images on disk, so three templates
// carry one each; an earlier version handed the same two files to six templates and gave
// every one of them two slots, which is how the gallery ended up showing one picture
// twelve times. Adding a row here requires adding the matching file to public/media/curated/.
const artworkByTemplate = {
  "clear-idea": { artwork: "paper-lotus-sphere", alt: "A glass sphere resting inside folded cream paper petals" },
  "bold-launch": { artwork: "paper-arrow-steps", alt: "A folded yellow paper arrow climbing across paper blocks" },
  "vertical-story": { artwork: "paper-crane-cards", alt: "A blue origami crane beside a stack of cream cards" },
};

const path = new URL("../content/templates.json", import.meta.url);
const templates = JSON.parse(await readFile(path, "utf8"));

for (const template of templates) {
  const assignment = artworkByTemplate[template.slug];

  // Clear whatever a previous run left behind so this script is idempotent and so a
  // template dropped from the map above really loses its image.
  template.document.assetRefs = [];
  for (const slide of template.document.slides) {
    if (!slide.assetSlots?.some((slot) => slot.assetId.startsWith("local-curated-"))) continue;
    slide.assetSlots = [];
    slide.mode = "text";
    slide.layoutId = slide.role === "intro" ? "intro-centered" : "statement";
  }

  if (!assignment) continue;

  const assetId = `local-curated-${assignment.artwork}`;
  template.document.assetRefs = [{ id: assetId, kind: "library", mimeType: "image/webp", rightsStatus: "verified" }];
  const intro = template.document.slides[0];
  intro.mode = "text_image";
  intro.layoutId = "intro-split";
  intro.assetSlots = [{ slotId: "curated-1", assetId, fit: "cover", crop: { x: 0, y: 0, width: 1, height: 1 }, opacity: 1, alt: assignment.alt }];
}

await writeFile(path, `${JSON.stringify(templates, null, 2)}\n`);
