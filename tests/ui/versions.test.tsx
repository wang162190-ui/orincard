// @vitest-environment jsdom

import { cleanup, render as renderBare, screen } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import messages from "../../messages/en.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VersionHistory } from "../../src/features/editor/versions";

// 组件的文案来自词条文件，脱离 Provider 渲染会直接抛错。
// 用 RTL 的 wrapper 而不是手动套一层：rerender 会自动沿用 wrapper，手套的那层不会。
function render(ui: ReactNode, options?: Parameters<typeof renderBare>[1]) {
  return renderBare(ui as Parameters<typeof renderBare>[0], {
    ...options,
    wrapper: ({ children }) => <NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>,
  });
}

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
