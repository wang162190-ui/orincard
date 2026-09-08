import { describe, expect, it, vi } from "vitest";
import { createBrandService, DEFAULT_BRAND_SETTINGS, type BrandStore } from "../../src/server/brands";

const OWNER = "11111111-1111-4111-8111-111111111111";
const ASSET = "22222222-2222-4222-8222-222222222222";
const ROW = { id: "33333333-3333-4333-8333-333333333333", name: "Personal", settings: DEFAULT_BRAND_SETTINGS, revision: 1, updated_at: "2026-09-09T00:00:00.000Z" };

function store(overrides: Partial<BrandStore> = {}): BrandStore {
  return { list: vi.fn().mockResolvedValue([ROW]), get: vi.fn().mockResolvedValue(ROW), create: vi.fn().mockResolvedValue(ROW), update: vi.fn().mockResolvedValue({ ...ROW, revision: 2 }), availableAssetIds: vi.fn().mockResolvedValue([ASSET]), ...overrides };
}

describe("T050 Brand Kit foundation", () => {
  it("creates private settings after validating an owner-scoped ready asset", async () => {
    const data = store();
    const service = createBrandService(data);
    const created = await service.create(OWNER, { name: " Personal ", settings: { ...DEFAULT_BRAND_SETTINGS, displayName: "Ada", logoAssetId: ASSET } });
    expect(created).toMatchObject({ name: "Personal", revision: 1 });
    expect(data.availableAssetIds).toHaveBeenCalledWith(OWNER, [ASSET]);
    expect(data.create).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, name: "Personal", settings: expect.objectContaining({ displayName: "Ada", logoAssetId: ASSET }) }));
  });

  it("rejects foreign or unavailable asset references and invalid public settings", async () => {
    const service = createBrandService(store({ availableAssetIds: vi.fn().mockResolvedValue([]) }));
    await expect(service.create(OWNER, { name: "Personal", settings: { ...DEFAULT_BRAND_SETTINGS, logoAssetId: ASSET } })).rejects.toMatchObject({ code: "ASSET_NOT_AVAILABLE", status: 422 });
    await expect(service.create(OWNER, { name: "Personal", settings: { ...DEFAULT_BRAND_SETTINGS, website: "javascript:alert(1)" } })).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 422 });
  });

  it("lists only the service store result and prepares a revision-checked update", async () => {
    const data = store(); const service = createBrandService(data);
    await expect(service.list(OWNER, 99)).resolves.toEqual([expect.objectContaining({ id: ROW.id, name: "Personal" })]);
    expect(data.list).toHaveBeenCalledWith(OWNER, 50);
    await service.update(OWNER, ROW.id, { expectedRevision: 1, name: "Revised", settings: DEFAULT_BRAND_SETTINGS });
    expect(data.update).toHaveBeenCalledWith(expect.objectContaining({ ownerId: OWNER, brandKitId: ROW.id, expectedRevision: 1, name: "Revised" }));
  });
});
