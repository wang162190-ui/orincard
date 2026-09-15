// @vitest-environment jsdom

import { cleanup, render as renderBare, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import messages from "../../messages/en.json";
import { EditorOnboarding } from "../../src/features/editor/onboarding";

function render(ui: ReactNode) {
  return renderBare(ui as Parameters<typeof renderBare>[0], {
    wrapper: ({ children }) =>
      createElement(NextIntlClientProvider, { children, locale: "en", messages }),
  });
}

beforeEach(() => localStorage.clear());
afterEach(cleanup);

/**
 * 引导只在第一次进编辑器时出现，状态只进 localStorage。这组测试守两头：
 * 第一次要出现，看完之后**不能**再出现——一个每次打开都弹的引导比没有引导更烦人。
 */
describe("editor onboarding", () => {
  it("walks three steps and remembers that it was finished", async () => {
    const user = userEvent.setup();
    render(createElement(EditorOnboarding));

    const panel = screen.getByTestId("editor-onboarding");
    expect(panel.textContent).toContain("Step 1 of 3");
    expect(panel.textContent).toContain("Left: the words");
    expect((screen.getByRole("button", { name: "Back" }) as HTMLButtonElement).disabled).toBe(
      true,
    );

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(panel.textContent).toContain("Right: the look");

    await user.click(screen.getByRole("button", { name: "Next" }));
    expect(panel.textContent).toContain("Then: export");
    // 最后一步才给导出页的入口——前两步给它只会把人从编辑器里引走。
    expect(
      screen.getByRole("link", { name: "Open the exports page" }).getAttribute("href"),
    ).toBe("/exports");
    expect(screen.queryByRole("button", { name: "Next" })).toBeNull();

    await user.click(screen.getByRole("button", { name: "Got it" }));
    expect(screen.queryByTestId("editor-onboarding")).toBeNull();
    expect(localStorage.getItem("orincard-editor-onboarding")).toBe("done");
  });

  it("can be skipped from the first step and stays skipped", async () => {
    const user = userEvent.setup();
    render(createElement(EditorOnboarding));

    await user.click(screen.getByRole("button", { name: "Skip" }));
    expect(screen.queryByTestId("editor-onboarding")).toBeNull();
    expect(localStorage.getItem("orincard-editor-onboarding")).toBe("done");

    cleanup();
    render(createElement(EditorOnboarding));
    expect(screen.queryByTestId("editor-onboarding")).toBeNull();
  });

  it("stays out of the way when localStorage is unavailable", () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new Error("localStorage is disabled");
      },
    });

    try {
      // 隐私模式下读 localStorage 会抛。引导看不到是可以接受的，把编辑器整页打崩不行。
      expect(() => render(createElement(EditorOnboarding))).not.toThrow();
      expect(screen.queryByTestId("editor-onboarding")).toBeNull();
    } finally {
      if (descriptor) {
        Object.defineProperty(globalThis, "localStorage", descriptor);
      }
    }
  });
});
