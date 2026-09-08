import { describe, expect, it, vi } from "vitest";
import { createPexelsClient, importPexelsPhoto } from "../../src/server/assets/pexels";

const PEXELS_PHOTO = {
  id: 123, width: 1200, height: 800, url: "https://www.pexels.com/photo/example-123/",
  photographer: "Ada Photographer", photographer_url: "https://www.pexels.com/@ada",
  alt: "A blue notebook", src: { medium: "https://images.pexels.com/photos/123/medium.jpeg", original: "https://images.pexels.com/photos/123/original.jpeg" },
};
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0x00]);

describe("T045 Pexels gallery", () => {
  it("preserves attribution and rate-limit information returned by Pexels", async () => {
    const request = vi.fn().mockResolvedValue(new Response(JSON.stringify({ photos: [PEXELS_PHOTO], next_page: "https://api.pexels.com/v1/search?page=2" }), { headers: { "x-ratelimit-limit": "20000", "x-ratelimit-remaining": "19999", "x-ratelimit-reset": "1893456000" } }));
    const result = await createPexelsClient("test-key", request).search({ query: "notebook", orientation: "landscape" });
    expect(request).toHaveBeenCalledWith(expect.stringContaining("query=notebook"), { headers: { Authorization: "test-key" } });
    expect(result).toMatchObject({ nextPage: 2, quota: { limit: 20000, remaining: 19999 }, items: [{ providerId: "123", photographer: "Ada Photographer", sourceUrl: PEXELS_PHOTO.url, photographerUrl: PEXELS_PHOTO.photographer_url }] });
  });

  it("imports only a Pexels-resolved selection after license confirmation and removes a failed copy", async () => {
    const api = vi.fn().mockResolvedValue(new Response(JSON.stringify(PEXELS_PHOTO)));
    const image = vi.fn().mockResolvedValue(new Response(JPEG, { headers: { "content-type": "image/jpeg" } }));
    const upload = vi.fn().mockResolvedValue(undefined);
    const create = vi.fn().mockResolvedValue({ id: "asset-123" });
    const remove = vi.fn().mockResolvedValue(undefined);
    const imported = await importPexelsPhoto({ ownerId: "owner", providerId: "123", licenseConfirmed: true, client: createPexelsClient("test-key", api), request: image, store: { upload, create, remove }, createId: () => "asset" });
    expect(imported.assetId).toBe("asset-123");
    expect(upload).toHaveBeenCalledWith("owner/asset/pexels-123.jpeg", JPEG, "image/jpeg");
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ kind: "stock", state: "ready", library_retained: true, rights: expect.objectContaining({ provider: "pexels", providerId: "123", photographer: "Ada Photographer", license: "Pexels License" }) }));
    await expect(importPexelsPhoto({ ownerId: "owner", providerId: "https://evil.test/image", licenseConfirmed: true, client: createPexelsClient("test-key", api), request: image, store: { upload, create, remove } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(importPexelsPhoto({ ownerId: "owner", providerId: "123", licenseConfirmed: false, client: createPexelsClient("test-key", api), request: image, store: { upload, create, remove } })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
