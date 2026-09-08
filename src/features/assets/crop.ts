export type AssetCrop = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
};

export const FULL_ASSET_CROP: AssetCrop = {
  x: 0,
  y: 0,
  width: 1,
  height: 1,
};

function unit(value: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

/** Keeps an asset crop inside its source image without changing its requested size first. */
export function normalizeAssetCrop(input: Partial<AssetCrop>): AssetCrop {
  const width = Math.max(0.01, unit(input.width ?? 1, 1));
  const height = Math.max(0.01, unit(input.height ?? 1, 1));
  const x = Math.min(unit(input.x ?? 0, 0), 1 - width);
  const y = Math.min(unit(input.y ?? 0, 0), 1 - height);
  return { x, y, width, height };
}

export function assetCropPosition(crop: AssetCrop): string {
  const normalized = normalizeAssetCrop(crop);
  return `${(normalized.x + normalized.width / 2) * 100}% ${(normalized.y + normalized.height / 2) * 100}%`;
}
