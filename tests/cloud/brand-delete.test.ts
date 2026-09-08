import { describe, expect, it, vi } from "vitest";
import { createBrandService, DEFAULT_BRAND_SETTINGS, type BrandStore } from "../../src/server/brands";

const OWNER = "11111111-1111-4111-8111-111111111111";
const KIT_ID = "22222222-2222-4222-8222-222222222222";
const PROJECT_A = "33333333-3333-4333-8333-333333333333";
const PROJECT_B = "44444444-4444-4444-8444-444444444444";
const KIT = { id: KIT_ID, name: "Personal", settings: DEFAULT_BRAND_SETTINGS, revision: 3, updated_at: "2026-09-09T00:00:00.000Z" };

function store(overrides: Partial<BrandStore> = {}): BrandStore {
  return {
    list: vi.fn(), get: vi.fn().mockResolvedValue(KIT), create: vi.fn(), update: vi.fn(),
    listAffectedProjects: vi.fn().mockResolvedValue([{ id: PROJECT_B, title: "Second" }, { id: PROJECT_A, title: "First" }]),
    delete: vi.fn().mockResolvedValue(true), availableAssetIds: vi.fn(), ...overrides,
  };
}

describe("T052 Brand Kit deletion impact confirmation", () => {
  it("returns a stable same-owner project impact before deletion", async () => {
    const data = store();
    const impact = await createBrandService(data).deleteImpact(OWNER, KIT_ID);
    expect(impact).toMatchObject({ kit: { id: KIT_ID, revision: 3 }, affectedProjects: [{ id: PROJECT_A, title: "First" }, { id: PROJECT_B, title: "Second" }] });
    expect(data.listAffectedProjects).toHaveBeenCalledWith(OWNER, KIT_ID);
  });

  it("soft-deletes only after the caller confirms the exact affected-project set", async () => {
    const data = store();
    await createBrandService(data).delete(OWNER, KIT_ID, { expectedRevision: 3, expectedProjectIds: [PROJECT_B, PROJECT_A] });
    expect(data.delete).toHaveBeenCalledWith({ ownerId: OWNER, brandKitId: KIT_ID, expectedRevision: 3 });
  });

  it("rejects stale impacts and revisions without deleting", async () => {
    const data = store();
    const service = createBrandService(data);
    await expect(service.delete(OWNER, KIT_ID, { expectedRevision: 3, expectedProjectIds: [PROJECT_A] })).rejects.toMatchObject({ code: "IMPACT_CHANGED", status: 409, details: { affectedProjects: expect.arrayContaining([expect.objectContaining({ id: PROJECT_B })]) } });
    await expect(service.delete(OWNER, KIT_ID, { expectedRevision: 2, expectedProjectIds: [PROJECT_A, PROJECT_B] })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
    expect(data.delete).not.toHaveBeenCalled();
  });

  it("does not remove shared asset references while marking the kit deleted", async () => {
    const data = store({ listAffectedProjects: vi.fn().mockResolvedValue([]) });
    await createBrandService(data).delete(OWNER, KIT_ID, { expectedRevision: 3, expectedProjectIds: [] });
    expect(data.delete).toHaveBeenCalledTimes(1);
    expect(data.availableAssetIds).not.toHaveBeenCalled();
  });

  it("does not reveal another owner's Brand Kit", async () => {
    const data = store({ get: vi.fn().mockResolvedValue(null) });
    await expect(createBrandService(data).deleteImpact(OWNER, KIT_ID)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    expect(data.listAffectedProjects).not.toHaveBeenCalled();
  });
});
