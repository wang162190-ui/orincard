import { readFile } from "node:fs/promises";
import JSZip from "jszip";
import { describe, expect, it, vi } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import { createRecoveryService, inspectRecoveryZip, RecoveryError, type RecoveryStore } from "../../src/server/recovery";

async function document(): Promise<CarouselDocument> { return JSON.parse(await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8")) as CarouselDocument; }
async function packageBytes(value?: CarouselDocument) {
  const source = value ?? await document();
  const zip = new JSZip();
  zip.file("manifest.json", JSON.stringify({ schemaVersion: 1, files: [] }));
  zip.file("project/document.json", JSON.stringify(source));
  return Buffer.from(await zip.generateAsync({ type: "nodebuffer" }));
}

describe("T056 recovery package inspection and confirmation (AC-006, AC-007)", () => {
  it("inspects a bounded recovery ZIP without creating a project", async () => {
    const result = await inspectRecoveryZip(await packageBytes());
    expect(result).toMatchObject({ document: { title: "Make one useful point at a time" }, missingAssets: [] });
    expect(result.inspectionHash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects traversal, missing manifest, and invalid documents before confirmation", async () => {
    const traversal = new JSZip(); traversal.file("../project/document.json", "{}"); traversal.file("manifest.json", JSON.stringify({ schemaVersion: 1 }));
    await expect(inspectRecoveryZip(Buffer.from(await traversal.generateAsync({ type: "nodebuffer" })))).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
    const invalid = new JSZip(); invalid.file("manifest.json", JSON.stringify({ schemaVersion: 1 })); invalid.file("project/document.json", "{}");
    await expect(inspectRecoveryZip(Buffer.from(await invalid.generateAsync({ type: "nodebuffer" })))).rejects.toMatchObject({ code: "INVALID_PACKAGE" });
  });

  it("keeps the inspection owner-private and creates only a new project after matching confirmation", async () => {
    const bytes = await packageBytes();
    const inspection = await inspectRecoveryZip(bytes);
    const save = vi.fn().mockResolvedValue({ id: "inspection-a", expiresAt: "2099-01-01T00:00:00.000Z" });
    const create = vi.fn().mockResolvedValue({ projectId: "new-project", revision: 1 });
    const store: RecoveryStore = {
      load: vi.fn().mockResolvedValue(bytes), save,
      get: vi.fn(async (ownerId) => ownerId === "owner-a" ? { id: "inspection-a", inspectionHash: inspection.inspectionHash, document: inspection.document, missingAssets: [], expiresAt: "2099-01-01T00:00:00.000Z" } : null), create,
    };
    const service = createRecoveryService(store);
    const preview = await service.inspect("owner-a", "asset-a");
    expect(create).not.toHaveBeenCalled();
    await expect(service.confirm("owner-b", "inspection-a", preview.inspectionHash, false)).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
    await expect(service.confirm("owner-a", "inspection-a", "bad", false)).rejects.toMatchObject({ code: "INSPECTION_CHANGED", status: 409 });
    await expect(service.confirm("owner-a", "inspection-a", preview.inspectionHash, false)).resolves.toEqual({ projectId: "new-project", revision: 1 });
    expect(create).toHaveBeenCalledWith("owner-a", inspection.document, "inspection-a");
  });

  it("requires an explicit acceptance when package assets are absent", async () => {
    const value = await document();
    value.assetRefs = [{ id: "local-asset-01", kind: "upload", mimeType: "image/png", rightsStatus: "verified" }];
    value.slides[1]!.mode = "text_image";
    value.slides[1]!.assetSlots = [{ slotId: "asset", assetId: "local-asset-01", fit: "cover", crop: { x: 0, y: 0, width: 1, height: 1 }, opacity: 1, alt: "" }];
    const result = await inspectRecoveryZip(await packageBytes(value));
    expect(result.missingAssets).toEqual(["local-asset-01"]);
  });
});
