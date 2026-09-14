// @vitest-environment jsdom

import { cleanup, fireEvent, render as renderBare, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { NextIntlClientProvider } from "next-intl";
import type { ReactNode } from "react";
import messages from "../../messages/en.json";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import fixture from "../fixtures/base-document.json";
import type { CarouselDocument } from "../../src/domain/document";
import { DEFAULT_GENERATION_OPTIONS } from "../../src/features/generation/options";
import {
  SourceInput,
  type SourceTransport,
} from "../../src/features/generation/source-input";

// T043. Six inputs, three shapes of work behind them. These tests hold the form to the
// contract the routes actually publish: a link is parsed inside the request, a file is
// uploaded and then waited for twice, and a source that fails must name an alternative.

// 组件的文案来自词条文件，脱离 Provider 渲染会直接抛错。
// 用 RTL 的 wrapper 而不是手动套一层：rerender 会自动沿用 wrapper，手套的那层不会。
function render(ui: ReactNode, options?: Parameters<typeof renderBare>[1]) {
  return renderBare(ui as Parameters<typeof renderBare>[0], {
    ...options,
    wrapper: ({ children }) => <NextIntlClientProvider locale="en" messages={messages}>{children}</NextIntlClientProvider>,
  });
}

interface Recorded {
  readonly url: string;
  readonly body: Record<string, unknown> | null;
}

function jobBody(state: string) {
  return {
    data: {
      id: "job-1",
      kind: "generation",
      state,
      stage: state === "succeeded" ? "done" : "drafting",
      progress: state === "succeeded" ? 100 : 40,
      resultRef: state === "succeeded" ? { document: fixture } : null,
      errorCode: null,
    },
  };
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Routes by path so a test only has to describe the endpoints it cares about; anything
 * unexpected fails loudly rather than resolving into a shape the form silently accepts.
 */
function stubFetch(
  routes: Record<string, (body: Record<string, unknown> | null) => Response | Promise<Response>>,
) {
  const calls: Recorded[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string"
      ? JSON.parse(init.body) as Record<string, unknown>
      : null;
    calls.push({ url, body });
    const route = Object.keys(routes).find((pattern) => url.startsWith(pattern));
    if (!route) throw new Error(`unexpected request to ${url}`);
    return routes[route](body);
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

function transport(overrides: Partial<SourceTransport> = {}) {
  const opened: CarouselDocument[] = [];
  const uploaded: { bucket: string; objectKey: string; name: string }[] = [];
  const base: SourceTransport = {
    async upload(target, file) {
      uploaded.push({
        bucket: target.bucket,
        objectKey: target.objectKey,
        name: file.name,
      });
    },
    async readAsset() {
      return { state: "ready" };
    },
    async readSource() {
      return { state: "ready", metadata: null };
    },
    async digest() {
      return "a".repeat(64);
    },
    // Polling is what makes these flows slow in a browser and pointless in a test; the
    // number of rounds still matters, so the waits are counted, not removed.
    async wait() {},
    async openDraft(document) {
      opened.push(document);
    },
  };
  return { transport: { ...base, ...overrides }, opened, uploaded };
}

function renderInput(injected: SourceTransport) {
  return render(
    <SourceInput
      options={DEFAULT_GENERATION_OPTIONS}
      optionsFields={null}
      transport={injected}
    />,
  );
}

const pdfFile = () =>
  new File(["%PDF-1.7 fake"], "report.pdf", { type: "application/pdf" });

beforeEach(() => {
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("SourceInput", () => {
  it("offers all six sources and swaps the field for the selected one", async () => {
    const user = userEvent.setup();
    const { transport: injected } = transport();
    renderInput(injected);

    for (const label of ["Topic", "Text", "URL", "PDF", "Slides", "Video"]) {
      expect(screen.getByRole("tab", { name: label })).toBeTruthy();
    }

    await user.click(screen.getByRole("tab", { name: "URL" }));
    expect(screen.getByLabelText("Public link").getAttribute("type")).toBe("url");

    await user.click(screen.getByRole("tab", { name: "Video" }));
    expect(screen.getByLabelText("Video file").getAttribute("accept")).toBe(
      "video/mp4,video/webm",
    );
    // The video tab is the only one that offers a language, and it stays optional.
    expect(screen.getByLabelText("Spoken language (optional)")).toBeTruthy();

    await user.click(screen.getByRole("tab", { name: "Slides" }));
    expect(screen.queryByLabelText("Spoken language (optional)")).toBeNull();
  });

  it("sends a link as a url source and opens the generated draft", async () => {
    const user = userEvent.setup();
    const { transport: injected, opened } = transport();
    const calls = stubFetch({
      "/api/v1/sources": () => json(201, {
        data: { sourceId: "src-1", kind: "url", state: "ready", expiresAt: null },
      }),
      "/api/v1/generation": () => json(202, { data: { jobId: "job-1" } }),
      "/api/v1/jobs/": () => json(200, jobBody("succeeded")),
    });
    renderInput(injected);

    await user.click(screen.getByRole("tab", { name: "URL" }));
    await user.type(screen.getByLabelText("Public link"), "https://example.com/post");
    await user.click(screen.getByRole("button", { name: "Generate carousel" }));

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(calls[0].body).toEqual({ kind: "url", url: "https://example.com/post" });
    expect(calls[1].body).toMatchObject({ sourceId: "src-1" });
    expect(opened[0].title).toBe(fixture.title);
  });

  it("shows the alternative action a rejected source names", async () => {
    const user = userEvent.setup();
    const { transport: injected, opened } = transport();
    stubFetch({
      "/api/v1/sources": () => json(422, {
        error: {
          code: "SOURCE_BLOCKED",
          message: "This page cannot be read without signing in.",
          action: "paste-text",
        },
      }),
    });
    renderInput(injected);

    await user.click(screen.getByRole("tab", { name: "URL" }));
    await user.type(screen.getByLabelText("Public link"), "https://example.com/paywalled");
    await user.click(screen.getByRole("button", { name: "Generate carousel" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("This page cannot be read without signing in.");
    expect(alert.textContent).toContain("Switch to the Text tab and paste it instead.");
    expect(opened).toHaveLength(0);
  });

  it("falls back to guest generation when pasted text is not signed in", async () => {
    const user = userEvent.setup();
    const { transport: injected, opened } = transport();
    const calls = stubFetch({
      "/api/v1/sources": () => json(401, {
        error: { code: "AUTH_REQUIRED", message: "Sign in before saving a source." },
      }),
      "/api/v1/guest/generate": () => new Response(
        `${JSON.stringify({ stage: "drafting" })}\n${JSON.stringify({ data: { document: fixture } })}`,
        { status: 200 },
      ),
    });
    renderInput(injected);

    await user.click(screen.getByRole("tab", { name: "Text" }));
    await user.type(screen.getByLabelText("Source text"), "A paragraph worth a carousel.");
    await user.click(screen.getByRole("button", { name: "Generate carousel" }));

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(calls.map((call) => call.url)).toEqual([
      "/api/v1/sources",
      "/api/v1/guest/generate",
    ]);
  });

  it("does not send a second source while the first submission is still running", async () => {
    const user = userEvent.setup();
    const { transport: injected, opened } = transport();
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const calls = stubFetch({
      // Held open so the test sees the form mid-flight, which is exactly when an
      // impatient second click happens.
      "/api/v1/sources": async () => {
        await held;
        return json(201, {
          data: { sourceId: "src-5", kind: "topic", state: "ready", expiresAt: null },
        });
      },
      "/api/v1/generation": () => json(202, { data: { jobId: "job-1" } }),
      "/api/v1/jobs/": () => json(200, jobBody("succeeded")),
    });
    renderInput(injected);

    await user.type(screen.getByLabelText("Topic"), "Writing shorter emails");
    const submit = screen.getByRole("button", { name: "Generate carousel" });
    await user.click(submit);
    // A second click on an in-flight submission would otherwise buy a second source, a
    // second job and a second charge for one intent.
    expect(submit.hasAttribute("disabled")).toBe(true);
    await user.click(submit);
    release();

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(calls.filter((call) => call.url === "/api/v1/sources")).toHaveLength(1);
  });

  it("asks a signed-out reader to sign in rather than guessing at a link", async () => {
    const user = userEvent.setup();
    const { transport: injected } = transport();
    const calls = stubFetch({
      "/api/v1/sources": () => json(401, {
        error: { code: "AUTH_REQUIRED", message: "Sign in before saving a source." },
      }),
    });
    renderInput(injected);

    await user.click(screen.getByRole("tab", { name: "URL" }));
    await user.type(screen.getByLabelText("Public link"), "https://example.com/post");
    await user.click(screen.getByRole("button", { name: "Generate carousel" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Sign in");
    // A link is fetched by the server on the reader's behalf, so there is no guest path
    // to fall back to; the form must not invent one.
    expect(calls).toHaveLength(1);
  });

  it("keeps a file source behind the rights confirmation", async () => {
    const user = userEvent.setup();
    const { transport: injected } = transport();
    renderInput(injected);

    await user.click(screen.getByRole("tab", { name: "PDF" }));
    await user.upload(screen.getByLabelText("PDF file"), pdfFile());
    expect(screen.getByRole("button", { name: "Generate carousel" }).hasAttribute("disabled"))
      .toBe(true);

    await user.click(screen.getByRole("checkbox"));
    expect(screen.getByRole("button", { name: "Generate carousel" }).hasAttribute("disabled"))
      .toBe(false);
  });

  it("uploads a PDF, waits for both checks, then generates", async () => {
    const user = userEvent.setup();
    const assetStates = ["pending_upload", "scanning", "ready"];
    const sourceStates = ["parsing", "ready"];
    const { transport: injected, opened, uploaded } = transport({
      async readAsset() {
        return { state: assetStates.shift() ?? "ready" };
      },
      async readSource() {
        return { state: sourceStates.shift() ?? "ready", metadata: null };
      },
    });
    const calls = stubFetch({
      "/api/v1/assets/upload-intent": () => json(201, {
        data: {
          assetId: "asset-1",
          bucket: "sources",
          objectKey: "owner/asset-1.pdf",
          state: "pending_upload",
          upload: { url: "https://storage.test/signed", token: "signed-token" },
        },
      }),
      "/api/v1/assets/asset-1/complete": () => json(200, {
        data: { assetId: "asset-1", state: "scanning" },
      }),
      "/api/v1/sources": () => json(202, {
        data: { sourceId: "src-2", kind: "pdf", state: "parsing", expiresAt: null },
      }),
      "/api/v1/generation": () => json(202, { data: { jobId: "job-1" } }),
      "/api/v1/jobs/": () => json(200, jobBody("succeeded")),
    });
    renderInput(injected);

    await user.click(screen.getByRole("tab", { name: "PDF" }));
    await user.upload(screen.getByLabelText("PDF file"), pdfFile());
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Generate carousel" }));

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(uploaded).toEqual([
      { bucket: "sources", objectKey: "owner/asset-1.pdf", name: "report.pdf" },
    ]);
    expect(calls[0].body).toMatchObject({
      originalName: "report.pdf",
      declaredMime: "application/pdf",
      purpose: "source",
      rightsConfirmation: true,
      sha256: "a".repeat(64),
    });
    expect(calls.map((call) => call.url)).toEqual([
      "/api/v1/assets/upload-intent",
      "/api/v1/assets/asset-1/complete",
      "/api/v1/sources",
      "/api/v1/generation",
      "/api/v1/jobs/job-1",
      "/api/v1/jobs/job-1",
    ]);
    // Both waits ran to completion; neither state was assumed ready on the first read.
    expect(assetStates).toHaveLength(0);
    expect(sourceStates).toHaveLength(0);
    expect(calls[2].body).toEqual({
      kind: "pdf",
      assetId: "asset-1",
      title: "report.pdf",
    });
  });

  it("reports why a parsed file failed and never starts a generation", async () => {
    const user = userEvent.setup();
    const { transport: injected, opened } = transport({
      async readSource() {
        return {
          state: "failed",
          metadata: {
            message: "No readable text was found in this file.",
            action: "paste-text",
          },
        };
      },
    });
    const calls = stubFetch({
      "/api/v1/assets/upload-intent": () => json(201, {
        data: {
          assetId: "asset-2",
          bucket: "sources",
          objectKey: "owner/asset-2.pdf",
          state: "pending_upload",
          upload: { url: "https://storage.test/signed", token: "signed-token" },
        },
      }),
      "/api/v1/assets/asset-2/complete": () => json(200, {
        data: { assetId: "asset-2", state: "scanning" },
      }),
      "/api/v1/sources": () => json(202, {
        data: { sourceId: "src-3", kind: "pdf", state: "parsing", expiresAt: null },
      }),
    });
    renderInput(injected);

    await user.click(screen.getByRole("tab", { name: "PDF" }));
    await user.upload(screen.getByLabelText("PDF file"), pdfFile());
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Generate carousel" }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("No readable text was found in this file.");
    expect(alert.textContent).toContain("Switch to the Text tab and paste it instead.");
    expect(opened).toHaveLength(0);
    expect(calls.some((call) => call.url === "/api/v1/generation")).toBe(false);
  });

  it("passes a chosen language along with a video source", async () => {
    const user = userEvent.setup();
    const { transport: injected, opened } = transport();
    const calls = stubFetch({
      "/api/v1/assets/upload-intent": () => json(201, {
        data: {
          assetId: "asset-3",
          bucket: "sources",
          objectKey: "owner/asset-3.mp4",
          state: "pending_upload",
          upload: { url: "https://storage.test/signed", token: "signed-token" },
        },
      }),
      "/api/v1/assets/asset-3/complete": () => json(200, {
        data: { assetId: "asset-3", state: "scanning" },
      }),
      "/api/v1/sources": () => json(202, {
        data: { sourceId: "src-4", kind: "video", state: "parsing", expiresAt: null },
      }),
      "/api/v1/generation": () => json(202, { data: { jobId: "job-1" } }),
      "/api/v1/jobs/": () => json(200, jobBody("succeeded")),
    });
    renderInput(injected);

    await user.click(screen.getByRole("tab", { name: "Video" }));
    await user.upload(
      screen.getByLabelText("Video file"),
      new File(["fake"], "talk.mp4", { type: "video/mp4" }),
    );
    await user.type(screen.getByLabelText("Spoken language (optional)"), "en");
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Generate carousel" }));

    await waitFor(() => expect(opened).toHaveLength(1));
    expect(calls[2].body).toEqual({
      kind: "video",
      assetId: "asset-3",
      title: "talk.mp4",
      language: "en",
    });
  });

  it("refuses a file whose type the reader cannot parse before uploading anything", async () => {
    const user = userEvent.setup();
    const { transport: injected, uploaded } = transport();
    const calls = stubFetch({});
    renderInput(injected);

    await user.click(screen.getByRole("tab", { name: "Slides" }));
    // The accept attribute is a hint, not a guarantee: a drag-and-drop or a renamed file
    // still arrives here, so the kind is checked before any upload intent is requested.
    const input = screen.getByLabelText("Slide deck") as HTMLInputElement;
    const dropped = new File(["fake"], "deck.key", {
      type: "application/x-iwork-keynote-sffkey",
    });
    Object.defineProperty(input, "files", { value: [dropped], configurable: true });
    fireEvent.change(input);
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: "Generate carousel" }));

    expect((await screen.findByRole("alert")).textContent).toContain("can't be read here");
    expect(calls).toHaveLength(0);
    expect(uploaded).toHaveLength(0);
  });
});
