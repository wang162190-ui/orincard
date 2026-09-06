import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import type { CarouselDocument } from "../../src/domain/document";
import {
  createPreflightPostHandler,
  evaluateProjectExportPreflight,
  ExportPreflightError,
  type ExportPreflightStore,
} from "../../src/app/api/v1/projects/[id]/preflight/route";
import {
  createExportHistoryGetHandler,
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

  it("derives the preflight owner from authentication and returns a private API envelope", async () => {
    const document = await fixture();
    const load = vi.fn().mockResolvedValue({
      projectVersionId: "22222222-2222-4222-8222-222222222222",
      revision: 3,
      document,
      issues: [],
    });
    const handler = createPreflightPostHandler({
      authenticate: vi.fn().mockResolvedValue("authenticated-owner"),
      assertOrigin: vi.fn(),
      store: { load },
    });
    const response = await handler(
      new Request("https://app.orincard.test/api/v1/projects/project-a/preflight", {
        method: "POST",
        headers: { "content-type": "application/json", origin: "https://app.orincard.test" },
        body: JSON.stringify({ ownerId: "attacker", expectedRevision: 3, format: "pdf", options: {} }),
      }),
      "project-a",
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(body).toEqual({ data: expect.objectContaining({ canExport: true }), requestId: expect.any(String) });
    expect(load).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "authenticated-owner" }));
  });

  it("rejects an untrusted preflight Origin and invalid JSON before reading a version", async () => {
    const load = vi.fn();
    const untrusted = createPreflightPostHandler({
      authenticate: vi.fn().mockResolvedValue("owner-a"),
      assertOrigin: () => {
        throw new ExportPreflightError("INVALID_REQUEST", "Untrusted Origin.", 400);
      },
      store: { load },
    });
    const originResponse = await untrusted(
      new Request("https://app.orincard.test/api/v1/projects/project-a/preflight", {
        method: "POST",
        body: "{}",
      }),
      "project-a",
    );
    expect(originResponse.status).toBe(400);
    expect(load).not.toHaveBeenCalled();

    const invalidJson = createPreflightPostHandler({
      authenticate: vi.fn().mockResolvedValue("owner-a"),
      assertOrigin: vi.fn(),
      store: { load },
    });
    const jsonResponse = await invalidJson(
      new Request("https://app.orincard.test/api/v1/projects/project-a/preflight", {
        method: "POST",
        body: "not-json",
      }),
      "project-a",
    );
    expect(jsonResponse.status).toBe(400);
    expect((await jsonResponse.json()).error.code).toBe("INVALID_REQUEST");
    expect(load).not.toHaveBeenCalled();
  });

  it("authenticates GET /exports and never accepts a caller-supplied owner", async () => {
    const list = vi.fn().mockResolvedValue([]);
    const handler = createExportHistoryGetHandler({
      authenticate: vi.fn().mockResolvedValue("authenticated-owner"),
      store: { list },
    });
    const response = await handler(
      new Request("https://app.orincard.test/api/v1/exports?ownerId=attacker&projectId=project-a"),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ ownerId: "authenticated-owner" }));
  });
});
