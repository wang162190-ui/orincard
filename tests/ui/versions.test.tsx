// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionHistory } from "../../src/features/editor/versions";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("VersionHistory", () => {
  it("shows immutable revisions and disables restore for the current revision", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: { items: [
      { id: "00000000-0000-4000-8000-000000000003", revision: 3, reason: "restore", createdAt: "2026-09-09T12:00:00.000Z", documentHash: "a".repeat(64) },
      { id: "00000000-0000-4000-8000-000000000004", revision: 2, reason: "manual", createdAt: "2026-09-09T11:00:00.000Z", documentHash: "b".repeat(64) },
    ] } }), { status: 200 })));
    render(<VersionHistory projectId="00000000-0000-4000-8000-000000000002" revision={3} />);
    expect(await screen.findByText("Revision 3 · restore")).toBeDefined();
    expect((screen.getByRole("button", { name: "Current" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Restore" }) as HTMLButtonElement).disabled).toBe(false);
  });
});
