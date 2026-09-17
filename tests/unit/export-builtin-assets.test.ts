import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";
import { curatedAssets } from "../../src/features/assets/curated";
import { isBuiltinAssetId, loadBuiltinAsset } from "../../src/server/assets/builtin";
import { loadRenderAssets } from "../../src/trigger/export";

/**
 * Regression cover for the export path that templates actually take.
 *
 * `assets.id` is a uuid column and templates reference their pictures by slug
 * (`local-curated-paper-crane-cards`). Sending one to Postgres produces
 * `invalid input syntax for type uuid`, so the old code turned every template with a built-in
 * picture into ASSET_NOT_EXPORTABLE. The point of these tests is that the database is never asked.
 */

/** A client that fails the test if the task queries it. */
function forbiddenClient(): SupabaseClient {
  return {
    from() {
      throw new Error("the assets table must not be queried for built-in ids");
    },
  } as unknown as SupabaseClient;
}

const builtinRef = (id: string) => ({ id, kind: "library", rightsStatus: "verified" });

describe("built-in asset export", () => {
  it("recognises the ids templates actually use", () => {
    expect(curatedAssets.length).toBeGreaterThan(0);
    for (const asset of curatedAssets) {
      expect(isBuiltinAssetId(asset.refId), asset.refId).toBe(true);
    }
    expect(isBuiltinAssetId("9f1c3f34-0b1e-4a42-9f0b-2c4a5a6c7d8e")).toBe(false);
  });

  it("reads the bytes from disk as a data URI the renderer will accept", async () => {
    const asset = await loadBuiltinAsset(curatedAssets[0].refId);

    // render-deck.ts refuses any src that is not data: or file:.
    expect(asset.src.startsWith("data:image/webp;base64,")).toBe(true);
    expect(asset.src.length).toBeGreaterThan(1000);
    expect(asset.state).toBe("ready");
    expect(asset.width).toBe(curatedAssets[0].width);
  });

  it("resolves a template's assets without touching the database", async () => {
    const refs = curatedAssets.map((asset) => builtinRef(asset.refId));

    const assets = await loadRenderAssets(forbiddenClient(), "owner-not-used", { assetRefs: refs });

    expect(Object.keys(assets).sort()).toEqual(refs.map((ref) => ref.id).sort());
    for (const asset of Object.values(assets)) {
      expect(asset.src.startsWith("data:")).toBe(true);
    }
  });

  it("still refuses a built-in id that no longer exists on disk", async () => {
    await expect(loadBuiltinAsset("local-curated-deleted-artwork")).rejects.toThrow(
      "ASSET_NOT_EXPORTABLE",
    );
  });

  it("still refuses restricted rights before reading anything", async () => {
    const refs = [{ ...builtinRef(curatedAssets[0].refId), rightsStatus: "restricted" }];

    await expect(loadRenderAssets(forbiddenClient(), "owner", { assetRefs: refs })).rejects.toThrow(
      "ASSET_NOT_EXPORTABLE",
    );
  });
});
