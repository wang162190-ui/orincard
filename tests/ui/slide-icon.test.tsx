// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import baseDocument from "../fixtures/base-document.json";
import {
  parseCarouselDocument,
  type CarouselDocument,
} from "../../src/domain/document";
import { SlideRenderer, type SlideRenderInput } from "../../src/render/slide";
import { themes } from "../../src/render/templates";

afterEach(cleanup);

const documentFixture = parseCarouselDocument(baseDocument);

function renderSlide(
  theme: CarouselDocument["theme"],
  slide: CarouselDocument["slides"][number],
): HTMLElement {
  const input: SlideRenderInput = {
    slide,
    platform: "linkedin",
    theme,
    brandSnapshot: documentFixture.brandSnapshot,
    assets: {},
    slideNumber: 2,
    slideCount: documentFixture.slides.length,
  };
  const { container } = render(<SlideRenderer input={input} />);
  const article = container.querySelector(".orincard-slide");
  if (!(article instanceof HTMLElement)) {
    throw new Error("slide root not rendered");
  }
  return article;
}

function bulletSlide(): CarouselDocument["slides"][number] {
  return {
    ...structuredClone(documentFixture.slides[1]),
    bodyBlocks: [{ kind: "bullets", items: ["First", "Second", "Third"] }],
  };
}

function withIcon(icon: string | null): CarouselDocument["theme"] {
  return { ...documentFixture.theme, bulletIcon: icon };
}

/**
 * theme.bulletIcon 把项目符号从 ::marker 换成真实元素，用的是随构建内联的 Tabler 图标。
 *
 * 这组测试守两件事：**降级不抛错**（存下来的文档可能引用一个本版本没有的图标名，
 * 此时必须回落到默认符号而不是让整张卡渲染失败），以及图标必须能继承主题色——
 * 否则六套配色各要导一份 PNG，就白做了。
 */
describe("slide bullet icons", () => {
  it("draws one inline icon per bullet and drops the disc marker", () => {
    const article = renderSlide(withIcon("circle-check"), bulletSlide());
    const list = article.querySelector("ul");

    expect(list?.getAttribute("data-bullet")).toBe("icon");
    expect(article.querySelectorAll("svg.orincard-slide__bullet-icon")).toHaveLength(3);
    expect(article.querySelector("svg[data-icon]")?.getAttribute("data-icon")).toBe(
      "circle-check",
    );
  });

  it("falls back to the plain marker for an icon name this build does not have", () => {
    const article = renderSlide(withIcon("icon-from-a-later-release"), bulletSlide());

    expect(article.querySelector("ul")?.getAttribute("data-bullet")).toBe("disc");
    expect(article.querySelectorAll("svg.orincard-slide__bullet-icon")).toHaveLength(0);
  });

  it("leaves a theme with no icon exactly as it was", () => {
    const article = renderSlide(withIcon(null), bulletSlide());

    expect(article.querySelector("ul")?.getAttribute("data-bullet")).toBe("disc");
    expect(article.querySelector("svg")).toBeNull();
  });

  it("inherits the slide colour instead of baking one in", () => {
    const icon = renderSlide(withIcon("circle-check"), bulletSlide()).querySelector(
      "svg.orincard-slide__bullet-icon",
    );

    expect(icon?.getAttribute("stroke")).toBe("currentColor");
    expect(icon?.innerHTML).not.toMatch(/(fill|stroke)="(?!none)(?!currentColor)/);
  });

  it("marks the numbered-point eyebrow but not an ordinary one", () => {
    const theme = withIcon("circle-check");
    const numbered = renderSlide(theme, structuredClone(documentFixture.slides[2]));
    expect(numbered.querySelectorAll(".orincard-slide__eyebrow-icon")).toHaveLength(1);

    cleanup();

    const intro = renderSlide(theme, structuredClone(documentFixture.slides[0]));
    expect(intro.querySelectorAll(".orincard-slide__eyebrow-icon")).toHaveLength(0);
  });

  it("gives each shipped theme an icon this build actually defines", () => {
    for (const theme of Object.values(themes)) {
      const name = theme.settings.bulletIcon;
      expect(name, theme.id).toBeTruthy();

      const article = renderSlide({ ...theme.settings, bulletIcon: name }, bulletSlide());
      expect(
        article.querySelector("ul")?.getAttribute("data-bullet"),
        `${theme.id} points at a missing icon: ${name}`,
      ).toBe("icon");
      cleanup();
    }
  });
});
