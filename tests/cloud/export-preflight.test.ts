import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import {
  evaluateProjectExportPreflight,
  type ExportPreflightStore,
} from "../../src/app/api/v1/projects/[id]/preflight/route";
import {
  listOwnedExportHistory,
  type ExportHistoryStore,
} from "../../src/app/api/v1/exports/route";

async function fixture(): Promise<CarouselDocument> {
  return JSON.parse(
    await readFile(new URL("../fixtures/base-document.json", import.meta.url), "utf8"),
  ) as CarouselDocument;
}

describe("T035 export preflight and history (AC-006, AC-007)", () => {
  it("checks an authorized fixed revision and blocks concrete slide issues", async () => {
    const document = await fixture();
    const load = vi.fn().mockResolvedValue({
      projectVersionId: "22222222-2222-4222-8222-222222222222",
      revision: 3,
      document,
      issues: [
        {
          code: "TEXT_OVERFLOW",
          slideId: document.slides[2]!.id,
          repairAction: "Shorten the slide or choose another layout.",
        },
      ],
    });
    const store: ExportPreflightStore = { load };

    const result = await evaluateProjectExportPreflight(store, {
      ownerId: "owner-a",
      projectId: "11111111-1111-4111-8111-111111111111",
      expectedRevision: 3,
      format: "pdf",
      options: {},
    });

    expect(load).toHaveBeenCalledWith({
      ownerId: "owner-a",
      projectId: "11111111-1111-4111-8111-111111111111",
      expectedRevision: 3,
      format: "pdf",
      options: {},
    });
    expect(result.canExport).toBe(false);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "TEXT_OVERFLOW", slideId: document.slides[2]!.id }),
    ]));
    expect(result.documentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(result.projectVersionId).toBe("22222222-2222-4222-8222-222222222222");
  });

  it("does not substitute the current draft when the requested revision is unavailable", async () => {
    const store: ExportPreflightStore = { load: vi.fn().mockResolvedValue(null) };
    await expect(
      evaluateProjectExportPreflight(store, {
        ownerId: "owner-a",
        projectId: "11111111-1111-4111-8111-111111111111",
        expectedRevision: 2,
        format: "png_zip",
        options: {},
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
  });

  it("lists only the authenticated owner's history and marks expired artifacts", async () => {
    const list = vi.fn().mockResolvedValue([
      {
        id: "export-ready",
        projectId: "project-a",
        projectVersionId: "version-a",
        revision: 4,
        format: "pdf",
        state: "ready",
        expiresAt: "2026-09-07T00:00:00.000Z",
        createdAt: "2026-09-06T00:00:00.000Z",
      },
      {
        id: "export-old",
        projectId: "project-a",
        projectVersionId: "version-a",
        revision: 4,
        format: "png_zip",
        state: "ready",
        expiresAt: "2026-09-05T00:00:00.000Z",
        createdAt: "2026-09-04T00:00:00.000Z",
      },
    ]);
    const store: ExportHistoryStore = { list };

    const result = await listOwnedExportHistory(
      store,
      { ownerId: "owner-a", projectId: "project-a", limit: 20 },
      new Date("2026-09-06T12:00:00.000Z"),
    );

    expect(list).toHaveBeenCalledWith({ ownerId: "owner-a", projectId: "project-a", limit: 20 });
    expect(result.items.map((item) => item.state)).toEqual(["ready", "expired"]);
    expect(result.items[1]?.canRegenerate).toBe(true);
    expect(JSON.stringify(result)).not.toContain("object_key");
  });
});
