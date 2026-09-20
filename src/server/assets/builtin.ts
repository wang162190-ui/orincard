import { readFile } from "node:fs/promises";
import { join } from "node:path";
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

  // asset.src is a site-absolute path such as /media/curated/paper-crane-cards.webp.
  //
  // 锚在工作目录上，和 src/render/render-deck.ts:116 同一个理由：打包器会把 import.meta.url
  // 改写成入口模块，在部署的 Trigger worker 里那是 src/trigger/。而且带动态段的
  // `new URL(..., import.meta.url)` 连 Turbopack 的静态分析都过不去——它会当成模块引用去解析，
  // `pnpm build` 因此以 `Can't resolve '../../../public' <dynamic>` 整体失败。
  // 字节进容器靠 trigger.config.ts 的 additionalFiles，和 slide.css 走同一条路。
  const path = join(process.cwd(), "public", asset.src);
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
