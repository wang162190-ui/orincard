import { describe, expect, it, vi } from "vitest";
import { AssetLibraryError, createAssetLibraryService, type AssetLibraryStore } from "../../src/server/assets/library";

const OWNER = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ASSET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: ASSET, kind: "ai_image" as const, purpose: "media", mime: "image/png", bytes: 42, width: 2, height: 2,
    rights: { candidate: true }, accepted_at: null, library_retained: false, state: "ready" as const, error_code: null,
    created_at: "2026-09-09T00:00:00.000Z", ...overrides,
  };
}

function store(overrides: Partial<AssetLibraryStore> = {}): AssetLibraryStore {
  return {
    list: vi.fn().mockResolvedValue([]),
    find: vi.fn().mockResolvedValue(row()),
    accept: vi.fn().mockResolvedValue(row({ accepted_at: "2026-09-09T01:00:00.000Z", library_retained: true })),
    references: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(row({ state: "deleted" })),
    removeObject: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("T049 asset lifecycle", () => {
  it("lists only the owner-scoped library, filters by kind, and does not expose object storage keys", async () => {
    const backing = store({ list: vi.fn().mockResolvedValue([row(), row({ id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", created_at: "2026-09-08T00:00:00.000Z" })]) });
    const result = await createAssetLibraryService({ store: backing }).list(OWNER, { kind: "ai_image", limit: 1 });
    expect(backing.list).toHaveBeenCalledWith({ ownerId: OWNER, kind: "ai_image", before: null, limit: 2 });
    expect(result).toMatchObject({ nextCursor: "2026-09-09T00:00:00.000Z", items: [{ id: ASSET, state: "ready" }] });
    expect(JSON.stringify(result)).not.toContain("object_key");
  });

  it("records an explicit acceptance for a ready AI candidate and makes it available for library use", async () => {
    const backing = store();
    const service = createAssetLibraryService({ store: backing, now: () => new Date("2026-09-09T01:00:00.000Z") });
    await expect(service.accept(OWNER, ASSET, { rightsConfirmation: true, keepInLibrary: true })).resolves.toMatchObject({ acceptedAt: "2026-09-09T01:00:00.000Z", libraryRetained: true });
    expect(backing.accept).toHaveBeenCalledWith({ ownerId: OWNER, assetId: ASSET, keepInLibrary: true, acceptedAt: "2026-09-09T01:00:00.000Z" });
  });

  it("refuses acceptance without rights confirmation, for a foreign asset, or before a candidate is ready", async () => {
    const service = createAssetLibraryService({ store: store() });
    await expect(service.accept(OWNER, ASSET, { rightsConfirmation: false, keepInLibrary: true })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(createAssetLibraryService({ store: store({ find: vi.fn().mockResolvedValue(null) }) }).accept(OWNER, ASSET, { rightsConfirmation: true, keepInLibrary: true })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(createAssetLibraryService({ store: store({ find: vi.fn().mockResolvedValue(row({ state: "pending_upload" })) }) }).accept(OWNER, ASSET, { rightsConfirmation: true, keepInLibrary: true })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("returns the active project and Brand Kit impact list without deleting a referenced asset", async () => {
    const backing = store({ references: vi.fn().mockResolvedValue([{ type: "project", id: "project-1", name: "Launch", slotKey: "slide-1:image" }, { type: "brand", id: "brand-1", name: "Orincard", slotKey: "logo" }]) });
    await expect(createAssetLibraryService({ store: backing }).remove(OWNER, ASSET, { expectedState: "ready" })).rejects.toMatchObject({ code: "ASSET_IN_USE", status: 409, references: [{ type: "project", id: "project-1" }, { type: "brand", id: "brand-1" }] });
    expect(backing.delete).not.toHaveBeenCalled();
    expect(backing.removeObject).not.toHaveBeenCalled();
  });

  it("deletes a currently unreferenced owner asset only when its expected state still matches", async () => {
    const backing = store();
    await expect(createAssetLibraryService({ store: backing }).remove(OWNER, ASSET, { expectedState: "ready" })).resolves.toBeUndefined();
    expect(backing.delete).toHaveBeenCalledWith({ ownerId: OWNER, assetId: ASSET, expectedState: "ready" });
    expect(backing.removeObject).toHaveBeenCalledWith(expect.objectContaining({ id: ASSET, state: "deleted" }));
    await expect(createAssetLibraryService({ store: store({ delete: vi.fn().mockResolvedValue(null) }) }).remove(OWNER, ASSET, { expectedState: "ready" })).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 409 });
  });

  it("does not turn malformed lifecycle requests into ownership probes", async () => {
    const service = createAssetLibraryService({ store: store() });
    await expect(service.remove(OWNER, "not-an-asset-id", { expectedState: "ready" })).rejects.toBeInstanceOf(AssetLibraryError);
    await expect(service.remove(OWNER, ASSET, { expectedState: "anything" })).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
});
