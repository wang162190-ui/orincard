// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import { ExportDialog } from "../../src/features/exports/export-dialog";
import {
  createProjectExports,
  type ProjectExportStore,
} from "../../src/app/api/v1/projects/[id]/exports/route";
import {
  createAuthorizedDownloadHandler,
  ExportDownloadError,
  type ExportDownloadStore,
} from "../../src/app/api/v1/exports/[id]/download/route";

describe("T036 export center and authenticated download (AC-006, AC-007)", () => {
  it("freezes one authorized revision and creates independent format records", async () => {
    const create = vi.fn().mockResolvedValue([
      { exportId: "export-png", jobId: "job-png", format: "png_zip" },
      { exportId: "export-pdf", jobId: "job-pdf", format: "pdf" },
    ]);
    const store: ProjectExportStore = { create };
    const result = await createProjectExports(store, {
      ownerId: "owner-a",
      projectId: "11111111-1111-4111-8111-111111111111",
      expectedRevision: 4,
      formats: ["png_zip", "pdf"],
      options: {},
      confirmedWarnings: [],
      idempotencyKey: "export-operation-1",
    });

    expect(create).toHaveBeenCalledWith(expect.objectContaining({
      ownerId: "owner-a",
      expectedRevision: 4,
      formats: ["png_zip", "pdf"],
      idempotencyKey: "export-operation-1",
    }));
    expect(result.exports).toEqual([
      { exportId: "export-png", jobId: "job-png", format: "png_zip" },
      { exportId: "export-pdf", jobId: "job-pdf", format: "pdf" },
    ]);
  });

  it("streams a ready artifact with private headers only after owner authorization", async () => {
    const open = vi.fn().mockResolvedValue({
      bytes: Buffer.from("real private artifact"),
      mime: "application/pdf",
      filename: "orincard.pdf",
    });
    const handler = createAuthorizedDownloadHandler({
      authenticate: vi.fn().mockResolvedValue("owner-a"),
      store: { open },
      now: () => new Date("2026-09-06T12:00:00.000Z"),
    });
    const response = await handler("export-a");

    expect(open).toHaveBeenCalledWith("owner-a", "export-a", new Date("2026-09-06T12:00:00.000Z"));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-disposition")).toContain("orincard.pdf");
    expect(Buffer.from(await response.arrayBuffer()).toString()).toBe("real private artifact");
  });

  it("returns 410 for expiry and the same 404 for another owner or a deleted project", async () => {
    const expired: ExportDownloadStore = {
      open: vi.fn().mockRejectedValue(new ExportDownloadError("EXPORT_EXPIRED", "Export expired.", 410)),
    };
    const expiredResponse = await createAuthorizedDownloadHandler({
      authenticate: vi.fn().mockResolvedValue("owner-a"),
      store: expired,
      now: () => new Date(),
    })("export-old");
    expect(expiredResponse.status).toBe(410);
    expect((await expiredResponse.json()).error).toEqual(expect.objectContaining({
      code: "EXPORT_EXPIRED",
      canRegenerate: true,
    }));

    for (const missing of ["another-owner", "deleted-project"]) {
      const response = await createAuthorizedDownloadHandler({
        authenticate: vi.fn().mockResolvedValue("owner-a"),
        store: { open: vi.fn().mockRejectedValue(new ExportDownloadError("NOT_FOUND", "Export not found.", 404)) },
        now: () => new Date(),
      })(missing);
      expect(response.status).toBe(404);
      expect((await response.json()).error.code).toBe("NOT_FOUND");
    }
  });

  it("blocks creation when preflight reports overflow and submits the same revision when clear", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        data: {
          canExport: false,
          issues: [{ code: "TEXT_OVERFLOW", slideId: "slide-3", repairAction: "Shorten the slide." }],
        },
      }), { status: 200, headers: { "content-type": "application/json" } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { canExport: true, issues: [] } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { exports: [{ exportId: "export-a" }] } }), {
        status: 202,
        headers: { "content-type": "application/json" },
      }));
    render(createElement(ExportDialog, { projectId: "project-a", revision: 4, fetcher }));

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await screen.findByText("Shorten the slide.");
    expect(fetcher).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole("button", { name: "Export" }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(3));
    expect(fetcher.mock.calls[2]?.[1]).toEqual(expect.objectContaining({
      body: expect.stringContaining('"expectedRevision":4'),
    }));
    expect(await screen.findByText("Export started")).toBeDefined();
  });
});
