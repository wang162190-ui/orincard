// @vitest-environment jsdom

import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import baseDocument from "../fixtures/base-document.json";
import {
  getPlatformDimensions,
  parseCarouselDocument,
  platformKeys,
  type Platform,
} from "../../src/domain/document";
import { SlideRenderer, type SlideRenderInput } from "../../src/render/slide";

afterEach(cleanup);

const documentFixture = parseCarouselDocument(baseDocument);

function renderAt(platform: Platform): CSSStyleDeclaration {
  const input: SlideRenderInput = {
    slide: structuredClone(documentFixture.slides[1]),
    platform,
    theme: documentFixture.theme,
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
  return article.style;
}

/**
 * slide.css 的所有尺寸都按容器**宽度**（`cqw`）定标，这在竖版没问题，到横屏就会把
 * 竖向放大约 2.2 倍并裁掉文字。`--slide-density` 是那个「按短边定标」的修正系数。
 *
 * 这组测试守的是它的**安全边界**：对所有宽 ≤ 高的画幅必须精确等于 1，也就是这条改动
 * 对 linkedin / instagram / tiktok / square 的计算值一个像素都不改。以后再加画幅时，
 * 第一条会自动把新画幅纳入检查。
 */
describe("slide density", () => {
  it("leaves every portrait and square geometry at exactly 1", () => {
    for (const platform of platformKeys) {
      const { width, height } = getPlatformDimensions(platform);
      if (width > height) {
        continue;
      }
      expect(renderAt(platform).getPropertyValue("--slide-density"), platform).toBe("1");
      cleanup();
    }
  });

  it("scales landscape down by the short side", () => {
    const density = Number(renderAt("presentation").getPropertyValue("--slide-density"));

    // 1080/1920 ÷ 1350/1080 = 0.45
    expect(density).toBeCloseTo(0.45, 4);
    expect(density).toBeLessThan(1);
  });

  it("keeps the aspect ratio driven by the platform preset, not by density", () => {
    expect(renderAt("presentation").getPropertyValue("--slide-aspect")).toBe("1920 / 1080");
    expect(renderAt("square").getPropertyValue("--slide-aspect")).toBe("1080 / 1080");
  });
});
