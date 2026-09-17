import { readFile } from "node:fs/promises";
import { curatedAssets } from "../../features/assets/curated";
import type { SlideRenderAsset } from "../../render/slide";

/**
 * Resolves the artwork that ships with the product, for export.
 *
 * Templates put ids like `local-curated-paper-crane-cards` into `assetRefs`, but `assets.id` is a
 * uuid column: passing one of these to the database is not a miss, it is
 * `invalid input syntax for type uuid`, which surfaced as ASSET_NOT_EXPORTABLE and made every
 * template that uses a built-in picture unexportable. These ids never belonged in that query —
 * the bytes are on disk in the deployment, not in a per-owner bucket.
 *
 * The result is a data URI because src/render/render-deck.ts refuses to render an asset whose src
 * is not `data:` or `file:`; a relative /media/... path would render as a broken image in the
 * headless browser that produces the PDF.
 */
export const BUILTIN_ASSET_PREFIX = "local-curated-";

export function isBuiltinAssetId(id: string): boolean {
  return id.startsWith(BUILTIN_ASSET_PREFIX);
}

export async function loadBuiltinAsset(refId: string): Promise<SlideRenderAsset> {
  const asset = curatedAssets.find((candidate) => candidate.refId === refId);
  if (!asset) throw new Error("ASSET_NOT_EXPORTABLE");

  // asset.src is a site-absolute path such as /media/curated/paper-crane-cards.webp; the file
  // lives under public/ in both dev and the deployed bundle.
  const path = new URL(`../../../public${asset.src}`, import.meta.url);
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new Error("ASSET_NOT_EXPORTABLE");
  }

  return {
    id: refId,
    src: `data:${asset.mimeType};base64,${bytes.toString("base64")}`,
    state: "ready",
    alt: asset.alt.en,
    width: asset.width,
    height: asset.height,
  };
}
