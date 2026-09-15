// @vitest-environment jsdom

import { cleanup, render as renderBare, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import { createElement, type ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import messages from "../../messages/en.json";
import { templateCards } from "../../src/features/templates/catalog";
import {
  TemplatePicker,
  type TemplateSeed,
} from "../../src/features/templates/template-picker";

function render(ui: ReactNode) {
  return renderBare(ui as Parameters<typeof renderBare>[0], {
    wrapper: ({ children }) =>
      createElement(NextIntlClientProvider, { children, locale: "en", messages }),
  });
}

afterEach(cleanup);

const first = templateCards[0];

describe("template picker", () => {
  it("seeds the generation options with the picked template's palette and canvas", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn<(seed: TemplateSeed) => void>();
    render(
      createElement(TemplatePicker, {
        cards: templateCards,
        value: { templateId: "paper", platform: "linkedin" },
        onSelect,
      }),
    );

    await user.click(screen.getByRole("button", { name: new RegExp(first.name) }));

    expect(onSelect).toHaveBeenCalledWith({
      templateId: first.templateId,
      platform: first.platform,
    });
  });

  /**
   * 高亮是算出来的，不是记下来的。用户选了一套模板、又回头把画幅改掉，选中态必须自己
   * 消失——继续显示一个已经不成立的选择，比不显示更糟。
   */
  it("drops the highlight when the options no longer match the picked template", async () => {
    const user = userEvent.setup();
    const view = render(
      createElement(TemplatePicker, {
        cards: templateCards,
        value: { templateId: "paper", platform: "linkedin" },
        onSelect: () => undefined,
      }),
    );

    // first 这套本身就是 paper / linkedin，与初始选项一致，所以点完就该亮。
    expect(first.templateId).toBe("paper");
    expect(first.platform).toBe("linkedin");
    await user.click(screen.getByRole("button", { name: new RegExp(first.name) }));
    expect(
      screen.getByRole("button", { name: new RegExp(first.name) }).getAttribute("aria-pressed"),
    ).toBe("true");

    // 用户回头把画幅改成 tiktok——rerender 传的是没包 Provider 的元素，RTL 会自动套回
    // render 时给的 wrapper；再包一层会让组件树形状变化、TemplatePicker 连着状态一起重挂。
    view.rerender(
      createElement(TemplatePicker, {
        cards: templateCards,
        value: { templateId: first.templateId, platform: "tiktok" },
        onSelect: () => undefined,
      }) as Parameters<typeof view.rerender>[0],
    );
    expect(
      screen.getByRole("button", { name: new RegExp(first.name) }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("narrows the list to one category and back", async () => {
    const user = userEvent.setup();
    render(
      createElement(TemplatePicker, {
        cards: templateCards,
        value: { templateId: "paper", platform: "linkedin" },
        onSelect: () => undefined,
      }),
    );

    const options = () => screen.getAllByRole("button").filter((node) => node.dataset.templateSlug);
    expect(options()).toHaveLength(templateCards.length);

    await user.click(screen.getByRole("button", { name: "Education" }));
    const education = templateCards.filter((card) => card.category === "Education");
    expect(options()).toHaveLength(education.length);

    await user.click(screen.getByRole("button", { name: "All" }));
    expect(options()).toHaveLength(templateCards.length);
  });
});
