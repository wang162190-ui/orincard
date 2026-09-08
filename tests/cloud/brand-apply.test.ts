import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import { createBrandService, DEFAULT_BRAND_SETTINGS, type BrandStore } from "../../src/server/brands";
import type { ProjectRecord, ProjectService } from "../../src/server/projects";

const OWNER = "11111111-1111-4111-8111-111111111111";
const KIT_ID = "22222222-2222-4222-8222-222222222222";
const COPY_ID = "33333333-3333-4333-8333-333333333333";
const PROJECT_ID = "44444444-4444-4444-8444-444444444444";
const KIT = {
  id: KIT_ID,
  name: "Personal",
  settings: { ...DEFAULT_BRAND_SETTINGS, displayName: "Ada", website: "https://ada.example/", cta: "Follow Ada", colors: ["#123456", "#ABCDEF"], fontPairId: "modern-serif", counterDefaults: { visible: false, style: "fraction" } },
  revision: 3,
  updated_at: "2026-09-09T00:00:00.000Z",
};

async function document(): Promise<CarouselDocument> {
  return JSON.parse(await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8")) as CarouselDocument;
}

function brandStore(overrides: Partial<BrandStore> = {}): BrandStore {
  return {
    list: vi.fn().mockResolvedValue([KIT]),
    get: vi.fn().mockResolvedValue(KIT),
    create: vi.fn().mockResolvedValue({ ...KIT, id: COPY_ID, name: "Personal copy", revision: 1 }),
    update: vi.fn(),
    availableAssetIds: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function projectRecord(value: CarouselDocument, revision = 4): ProjectRecord {
  return { id: PROJECT_ID, title: value.title, platform: value.platform, document: value, revision, state: "draft", updatedAt: "2026-09-09T00:00:00.000Z" };
}

describe("T051 Brand Kit apply and duplicate", () => {
  it("requires preview confirmation, writes a revision-checked project snapshot, and preserves slide overrides", async () => {
    const original = await document();
    const data = brandStore();
    const save = vi.fn().mockImplementation(async (_owner, _projectId, input) => projectRecord(input.document, 5));
    const projects = { get: vi.fn().mockResolvedValue(projectRecord(original)), save } as Pick<ProjectService, "get" | "save">;
    const service = createBrandService(data, projects);

    await expect(service.apply(OWNER, KIT_ID, { projectId: PROJECT_ID, expectedProjectRevision: 4, previewConfirmed: false, idempotencyKey: "apply-brand-1234" })).rejects.toMatchObject({ code: "INVALID_REQUEST", status: 400 });
    expect(save).not.toHaveBeenCalled();

    const applied = await service.apply(OWNER, KIT_ID, { projectId: PROJECT_ID, expectedProjectRevision: 4, previewConfirmed: true, idempotencyKey: "apply-brand-1234" });

    expect(applied).toMatchObject({ projectId: PROJECT_ID, revision: 5, brandSnapshot: { kitId: KIT_ID, kitVersion: 3, displayName: "Ada" } });
    expect(save).toHaveBeenCalledWith(OWNER, PROJECT_ID, expect.objectContaining({ expectedRevision: 4, document: expect.objectContaining({ brandSnapshot: expect.objectContaining({ kitId: KIT_ID, kitVersion: 3 }), theme: expect.objectContaining({ colors: ["#123456", "#ABCDEF"], fontPairId: "modern-serif", counterStyle: "none" }), slides: original.slides }) }), "apply-brand-1234");
  });

  it("copies only the current same-owner kit into a new independent ID", async () => {
    const data = brandStore();
    const service = createBrandService(data);
    const copy = await service.duplicate(OWNER, KIT_ID, { expectedRevision: 3, name: "Personal copy" });

    expect(copy).toMatchObject({ id: COPY_ID, name: "Personal copy", revision: 1 });
    expect(data.create).toHaveBeenCalledWith({ ownerId: OWNER, name: "Personal copy", settings: KIT.settings });
    await expect(service.duplicate(OWNER, KIT_ID, { expectedRevision: 2, name: "Stale copy" })).rejects.toMatchObject({ code: "VERSION_CONFLICT", status: 409 });
  });

  it("does not duplicate a kit whose referenced asset is no longer available to its owner", async () => {
    const data = brandStore({ get: vi.fn().mockResolvedValue({ ...KIT, settings: { ...KIT.settings, logoAssetId: "55555555-5555-4555-8555-555555555555" } }), availableAssetIds: vi.fn().mockResolvedValue([]) });
    const service = createBrandService(data);
    await expect(service.duplicate(OWNER, KIT_ID, { expectedRevision: 3, name: "Personal copy" })).rejects.toMatchObject({ code: "ASSET_NOT_AVAILABLE", status: 422 });
    expect(data.create).not.toHaveBeenCalled();
  });
});
