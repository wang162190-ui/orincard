// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/base-document.json";
import { parseCarouselDocument, type CarouselDocument } from "../../src/domain/document";
import { EditorMedia } from "../../src/features/assets/editor-media";

const STOCK_ID = "11111111-1111-4111-8111-111111111111";
const CANDIDATE_ID = "22222222-2222-4222-8222-222222222222";

function documentFixture(): CarouselDocument {
  return parseCarouselDocument(structuredClone(fixture));
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("EditorMedia", () => {
  it("loads only ready, accepted media and attaches it to the selected slide", async () => {
    const fetchMock = vi.fn(async () => json(200, { data: { items: [
      { id: STOCK_ID, kind: "stock", mime: "image/jpeg", state: "ready", acceptedAt: null, previewUrl: "https://signed.example/stock" },
      { id: CANDIDATE_ID, kind: "ai_image", mime: "image/png", state: "ready", acceptedAt: null, previewUrl: "https://signed.example/candidate" },
    ] } }));
    vi.stubGlobal("fetch", fetchMock);
    const onDocumentChange = vi.fn();
    const onRenderAssetsChange = vi.fn();
    const user = userEvent.setup();
    render(<EditorMedia document={documentFixture()} onDocumentChange={onDocumentChange} onRenderAssetsChange={onRenderAssetsChange} selectedSlideId="local-slide-02" />);

    await waitFor(() => expect(screen.getByRole("button", { name: "Pexels image · stock" })).toBeTruthy());
    expect(screen.queryByRole("button", { name: "AI image · generated" })).toBeNull();
    expect(screen.getByRole("button", { name: "Accept candidate" })).toBeTruthy();
    expect(onRenderAssetsChange).toHaveBeenCalledWith({
      [STOCK_ID]: expect.objectContaining({ src: "https://signed.example/stock", state: "ready" }),
    });

    await user.click(screen.getByRole("button", { name: "Pexels image · stock" }));
    const next = onDocumentChange.mock.calls.at(-1)?.[0] as CarouselDocument;
    expect(next.slides[1].assetSlots[0]).toMatchObject({ assetId: STOCK_ID });
    expect(next.slides[2].assetSlots).toEqual(documentFixture().slides[2].assetSlots);

    await user.click(screen.getByRole("button", { name: "Accept candidate" }));
    expect(fetchMock).toHaveBeenCalledWith(
      `/api/v1/assets/${CANDIDATE_ID}/accept`,
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("submits screenshot and AI image requests through the owner-scoped APIs", async () => {
    const calls: Array<{ url: string; body?: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      calls.push({ url, body });
      if (url.startsWith("/api/v1/assets?")) return json(200, { data: { items: [] } });
      return json(202, { data: { assetId: STOCK_ID, state: "pending_upload" } });
    }));
    const user = userEvent.setup();
    render(<EditorMedia document={documentFixture()} onDocumentChange={vi.fn()} onRenderAssetsChange={vi.fn()} selectedSlideId="local-slide-02" />);

    await user.click(screen.getByRole("button", { name: "Screenshot" }));
    await user.type(screen.getByLabelText("Screenshot URL"), "https://example.com/article");
    await user.click(screen.getByRole("button", { name: "Capture screenshot" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/v1/assets/screenshot", body: { publicUrl: "https://example.com/article" } }));

    await user.click(screen.getByRole("button", { name: "AI image" }));
    await user.type(screen.getByLabelText("Image prompt"), "A bright editorial desk");
    await user.click(screen.getByRole("button", { name: "Generate image" }));
    await waitFor(() => expect(calls).toContainEqual({ url: "/api/v1/assets/generate", body: { kind: "ai_image", prompt: "A bright editorial desk" } }));
  });
});
