// @vitest-environment jsdom

import { cleanup, fireEvent, render as renderBare, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import messages from "../../messages/en.json";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/base-document.json";
import { parseCarouselDocument, type CarouselDocument } from "../../src/domain/document";
import { assetCropPosition, normalizeAssetCrop } from "../../src/features/assets/crop";
import { MEDIA_SOURCES, MediaPanel, type MediaAsset } from "../../src/features/assets/media-panel";

// 组件的文案来自词条文件，脱离 Provider 渲染会直接抛错。
// 用 RTL 的 wrapper 而不是手动套一层：rerender 会自动沿用 wrapper，手套的那层不会。
function render(ui: ReactNode, options?: Parameters<typeof renderBare>[1]) {
  return renderBare(ui as Parameters<typeof renderBare>[0], {
    ...options,
    wrapper: ({ children }) => <NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>,
  });
}

function documentFixture(): CarouselDocument {
  return parseCarouselDocument(structuredClone(fixture));
}

const asset: MediaAsset = {
  id: "local-media-01",
  label: "Notebook photo",
  source: "stock",
  assetRef: {
    id: "local-media-01",
    kind: "library",
    mimeType: "image/jpeg",
    rightsStatus: "verified",
  },
};

afterEach(cleanup);

describe("crop helpers", () => {
  it("clamps a crop to the image boundary and reports its center", () => {
    expect(normalizeAssetCrop({ x: 0.9, y: -1, width: 0.4, height: 2 })).toEqual({
      x: 0.6, y: 0, width: 0.4, height: 1,
    });
    expect(assetCropPosition({ x: 0.25, y: 0.25, width: 0.5, height: 0.5 })).toBe("50% 50%");
  });
});

describe("MediaPanel", () => {
  it("offers all six sources without coupling their implementation to the editor", async () => {
    const user = userEvent.setup();
    const request = vi.fn();
    render(<MediaPanel assets={[]} document={documentFixture()} onDocumentChange={vi.fn()} onRequestSource={request} selectedSlideId="local-slide-02" />);

    expect(MEDIA_SOURCES.map((source) => screen.getByRole("button", { name: source.label }))).toHaveLength(6);
    await user.click(screen.getByRole("button", { name: "Emoji" }));
    expect(request).toHaveBeenCalledWith("emoji");
  });

  it("replaces, crops and fades only the selected slide while allowing cross-slide reuse", async () => {
    const user = userEvent.setup();
    const document = documentFixture();
    const onDocumentChange = vi.fn();
    const view = render(<MediaPanel assets={[asset]} document={document} onDocumentChange={onDocumentChange} selectedSlideId="local-slide-02" />);

    await user.click(screen.getByRole("button", { name: "Notebook photo · stock" }));
    const selected = onDocumentChange.mock.calls.at(-1)![0] as CarouselDocument;
    expect(selected.slides[1].assetSlots[0]).toMatchObject({ assetId: asset.id, opacity: 1 });
    expect(selected.slides[2].assetSlots).toEqual(document.slides[2].assetSlots);
    expect(selected.assetRefs).toContainEqual(asset.assetRef);

    view.rerender(<MediaPanel assets={[asset]} document={selected} onDocumentChange={onDocumentChange} selectedSlideId="local-slide-03" />);
    await user.click(screen.getByRole("button", { name: "Notebook photo · stock" }));
    const reused = onDocumentChange.mock.calls.at(-1)![0] as CarouselDocument;
    expect(reused.slides[1].assetSlots[0].assetId).toBe(asset.id);
    expect(reused.slides[2].assetSlots[0].assetId).toBe(asset.id);

    view.rerender(<MediaPanel assets={[asset]} document={reused} onDocumentChange={onDocumentChange} selectedSlideId="local-slide-02" />);
    fireEvent.change(screen.getByLabelText("Crop width"), { target: { value: "0.4" } });
    const cropped = onDocumentChange.mock.calls.at(-1)![0] as CarouselDocument;
    expect(cropped.slides[1].assetSlots[0].crop.width).toBe(0.4);
    fireEvent.change(screen.getByLabelText("Opacity"), { target: { value: "0.5" } });
    const faded = onDocumentChange.mock.calls.at(-1)![0] as CarouselDocument;
    expect(faded.slides[1].assetSlots[0].opacity).toBe(0.5);
    expect(faded.slides[2].assetSlots[0]).toEqual(reused.slides[2].assetSlots[0]);
  });
});
