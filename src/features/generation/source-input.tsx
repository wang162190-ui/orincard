"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../../components/ui";
import { carouselDocumentSchema, type CarouselDocument } from "../../domain/document";
import { LocalDraftStore, type DraftOwner } from "../editor/local-drafts";
import type { GenerationOptions } from "../../server/generation";
import type { SourceAlternativeAction, SourceKind } from "../../server/sources";
import { GenerationProgress } from "./progress";

// T043. The six ways a deck can start. Topic and text are readable the moment they are
// submitted, a link is fetched and parsed inside the request that saves it, and the three
// file kinds are uploaded first and then read by a worker — so this form has to wait for
// two different things and explain both while it does.

const SESSION_OWNER_KEY = "orincard-anonymous-session";
const GUEST_NONCE_KEY = "orincard-guest-generation-nonce";

const FILE_KINDS = ["pdf", "slides", "video"] as const;
type FileSourceKind = (typeof FILE_KINDS)[number];

const TABS: readonly { readonly kind: SourceKind; readonly label: string }[] = [
  { kind: "topic", label: "Topic" },
  { kind: "text", label: "Text" },
  { kind: "url", label: "URL" },
  { kind: "pdf", label: "PDF" },
  { kind: "slides", label: "Slides" },
  { kind: "video", label: "Video" },
];

const FILE_ACCEPT: Readonly<Record<FileSourceKind, string>> = {
  pdf: "application/pdf",
  slides: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  video: "video/mp4,video/webm",
};

const FILE_MIME: Readonly<Record<FileSourceKind, readonly string[]>> = {
  pdf: ["application/pdf"],
  slides: ["application/vnd.openxmlformats-officedocument.presentationml.presentation"],
  video: ["video/mp4", "video/webm"],
};

const FILE_HINT: Readonly<Record<FileSourceKind, string>> = {
  pdf: "A PDF you have the rights to use. Scanned pages are read with OCR.",
  slides: "A .pptx deck. Speaker notes and slide text are both read.",
  video: "An .mp4 or .webm file, up to 30 minutes. Subtitles are used when the file has them.",
};

// The wording a failed source comes back with is written by the parser; this only turns
// the action into the sentence that tells the reader where to go next.
const ACTION_HINT: Readonly<Record<SourceAlternativeAction, string>> = {
  "paste-text": "Switch to the Text tab and paste it instead.",
  "upload-file": "Switch to a file tab and upload the file itself.",
  "use-public-url": "Use a link that is reachable without signing in.",
  "remove-pdf-protection": "Remove the password from the PDF and upload it again.",
  "convert-to-pptx": "Save the deck as .pptx and upload it again.",
  "use-smaller-file": "Upload a smaller file.",
  "split-input": "Split it into parts and import them one at a time.",
  "retry-later": "Try again in a moment.",
};

function browserValue(key: string, prefix: string): string {
  let value = localStorage.getItem(key);
  if (!value) {
    value = `${prefix}-${crypto.randomUUID()}`;
    localStorage.setItem(key, value);
  }
  return value;
}

// Carries the alternative action alongside the message so the form can show both without
// the caller having to re-read the response.
class SourceFailure extends Error {
  constructor(message: string, readonly action?: SourceAlternativeAction) {
    super(message);
    this.name = "SourceFailure";
  }
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as {
    readonly error?: {
      readonly message?: string;
      readonly action?: SourceAlternativeAction;
    };
  } | null;
  return new SourceFailure(
    body?.error?.message ?? "This source is temporarily unavailable.",
    body?.error?.action,
  );
}

function guestDocument(payload: string): CarouselDocument {
  const lines = payload.trim().split("\n");
  const result = JSON.parse(lines.at(-1) ?? "null") as {
    readonly data?: { readonly document?: unknown };
  };
  return carouselDocumentSchema.parse(result.data?.document);
}

function jobDocument(resultRef: Readonly<Record<string, unknown>> | null): CarouselDocument {
  const value = resultRef && "document" in resultRef ? resultRef.document : resultRef;
  return carouselDocumentSchema.parse(value);
}

async function waitForJob(jobId: string, onStage: (stage: string) => void) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, {
      cache: "no-store",
    });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as {
      readonly data: {
        readonly state: string;
        readonly stage: string;
        readonly resultRef: Readonly<Record<string, unknown>> | null;
        readonly errorCode: string | null;
      };
    };
    onStage(body.data.stage);
    if (body.data.state === "succeeded") return jobDocument(body.data.resultRef);
    if (["failed", "partial", "canceled"].includes(body.data.state)) {
      throw new Error(body.data.errorCode ?? "Generation did not complete.");
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  throw new Error("Generation is taking longer than expected. Return later to check its job.");
}

export interface UploadTarget {
  readonly bucket: string;
  readonly objectKey: string;
  readonly token: string;
  readonly url: string;
}

export interface AssetSnapshot {
  readonly state: string;
  readonly errorCode?: string | null;
}

export interface SourceSnapshot {
  readonly state: string;
  readonly metadata: Readonly<Record<string, unknown>> | null;
}

// The two waits and the upload itself are the only things this form cannot do with fetch
// against our own API, so they are named here and injected. The default implementation
// reads through the browser Supabase client, where row level security decides what the
// signed-in reader may see.
export interface SourceTransport {
  upload(target: UploadTarget, file: File): Promise<void>;
  readAsset(assetId: string): Promise<AssetSnapshot>;
  readSource(sourceId: string): Promise<SourceSnapshot>;
  digest(file: File): Promise<string>;
  wait(ms: number): Promise<void>;
  openDraft(document: CarouselDocument): Promise<void>;
}

async function browserClient() {
  const { createBrowserSupabaseClient } = await import("../auth/client");
  return createBrowserSupabaseClient();
}

export const defaultSourceTransport: SourceTransport = {
  async upload(target, file) {
    const client = await browserClient();
    const { error } = await client.storage
      .from(target.bucket)
      .uploadToSignedUrl(target.objectKey, target.token, file, {
        contentType: file.type,
      });
    if (error) throw new SourceFailure("The file could not be uploaded. Try again.");
  },
  async readAsset(assetId) {
    const client = await browserClient();
    const { data, error } = await client
      .from("assets")
      .select("state,error_code")
      .eq("id", assetId)
      .maybeSingle();
    if (error || !data) return { state: "pending_upload" };
    const row = data as { state: string; error_code: string | null };
    return { state: row.state, errorCode: row.error_code };
  },
  async readSource(sourceId) {
    const client = await browserClient();
    const { data, error } = await client
      .from("sources")
      .select("state,metadata")
      .eq("id", sourceId)
      .maybeSingle();
    if (error || !data) return { state: "parsing", metadata: null };
    const row = data as { state: string; metadata: Record<string, unknown> | null };
    return { state: row.state, metadata: row.metadata };
  },
  async digest(file) {
    const hashed = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(hashed))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  },
  wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  },
  async openDraft(document) {
    const draftId = `local-generated-${crypto.randomUUID()}`;
    const owner: DraftOwner = {
      kind: "anonymous",
      sessionId: browserValue(SESSION_OWNER_KEY, "session"),
    };
    const store = new LocalDraftStore();
    try {
      await store.initialize();
      await store.saveDraft(owner, draftId, document);
    } finally {
      await store.close();
    }
    location.assign(`/editor/${draftId}`);
  },
};

export function SourceInput(props: {
  readonly options: GenerationOptions;
  readonly optionsFields: ReactNode;
  readonly transport?: SourceTransport;
}) {
  const transport = props.transport ?? defaultSourceTransport;
  const [kind, setKind] = useState<SourceKind>("topic");
  const [text, setText] = useState("");
  const [file, setFile] = useState<File | null>(null);
  const [rightsConfirmed, setRightsConfirmed] = useState(false);
  const [language, setLanguage] = useState("");
  const [pending, setPending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [stage, setStage] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [action, setAction] = useState<SourceAlternativeAction | null>(null);

  const isFileKind = FILE_KINDS.includes(kind as FileSourceKind);
  const isTextKind = kind === "topic" || kind === "text";

  async function generateGuest() {
    const response = await fetch("/api/v1/guest/generate", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `guest-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        kind,
        text,
        ...props.options,
        sessionNonce: browserValue(GUEST_NONCE_KEY, "guest"),
      }),
    });
    const payload = await response.text();
    if (!response.ok) {
      const body = JSON.parse(payload) as { readonly error?: { readonly message?: string } };
      throw new Error(body.error?.message ?? "Guest generation failed.");
    }
    await transport.openDraft(guestDocument(payload));
  }

  async function generateRegistered(sourceId: string) {
    const response = await fetch("/api/v1/generation", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `generation-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({ sourceId, ...props.options }),
    });
    if (!response.ok) throw await responseError(response);
    const body = await response.json() as { readonly data: { readonly jobId: string } };
    setJobId(body.data.jobId);
    await transport.openDraft(await waitForJob(body.data.jobId, setStage));
  }

  async function createSource(body: Record<string, unknown>): Promise<Response> {
    return fetch("/api/v1/sources", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `source-${crypto.randomUUID()}`,
      },
      body: JSON.stringify(body),
    });
  }

  // Upload, then wait for the validator, then register the source, then wait for the
  // parser. Neither wait is skipped on a hopeful assumption: a source that is still
  // parsing has no text, and generating from it would be generating from nothing.
  async function uploadAndParse(selected: File): Promise<string> {
    const fileKind = kind as FileSourceKind;
    if (!FILE_MIME[fileKind].includes(selected.type)) {
      throw new SourceFailure(
        "This file type can't be read here. Choose a supported file.",
        "upload-file",
      );
    }
    setStatus("Checking the file…");
    const intent = await fetch("/api/v1/assets/upload-intent", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": `upload-${crypto.randomUUID()}`,
      },
      body: JSON.stringify({
        originalName: selected.name,
        declaredMime: selected.type,
        size: selected.size,
        sha256: await transport.digest(selected),
        purpose: "source",
        rightsConfirmation: true,
      }),
    });
    if (!intent.ok) throw await responseError(intent);
    const registered = await intent.json() as {
      readonly data: {
        readonly assetId: string;
        readonly bucket: string;
        readonly objectKey: string;
        readonly upload: { readonly url: string; readonly token: string };
      };
    };

    setStatus("Uploading…");
    await transport.upload(
      {
        bucket: registered.data.bucket,
        objectKey: registered.data.objectKey,
        token: registered.data.upload.token,
        url: registered.data.upload.url,
      },
      selected,
    );

    const completed = await fetch(
      `/api/v1/assets/${encodeURIComponent(registered.data.assetId)}/complete`,
      { method: "POST", headers: { "Content-Type": "application/json" } },
    );
    if (!completed.ok) throw await responseError(completed);

    setStatus("Checking the upload…");
    for (let attempt = 0; ; attempt += 1) {
      const asset = await transport.readAsset(registered.data.assetId);
      if (asset.state === "ready") break;
      if (asset.state === "failed") {
        throw new SourceFailure(
          "This file did not pass its checks. Upload the original file again.",
          "upload-file",
        );
      }
      if (attempt >= 120) {
        throw new SourceFailure("Checking this file is taking too long.", "retry-later");
      }
      await transport.wait(1_000);
    }

    const source = await createSource({
      kind: fileKind,
      assetId: registered.data.assetId,
      title: selected.name,
      ...(fileKind === "video" && language ? { language } : {}),
    });
    if (!source.ok) throw await responseError(source);
    const body = await source.json() as {
      readonly data: { readonly sourceId: string; readonly state: string };
    };

    setStatus("Reading the file…");
    for (let attempt = 0; ; attempt += 1) {
      const snapshot = await transport.readSource(body.data.sourceId);
      if (snapshot.state === "ready") return body.data.sourceId;
      if (snapshot.state === "failed") {
        const metadata = snapshot.metadata ?? {};
        throw new SourceFailure(
          typeof metadata.message === "string"
            ? metadata.message
            : "This file could not be read.",
          typeof metadata.action === "string"
            ? (metadata.action as SourceAlternativeAction)
            : "paste-text",
        );
      }
      if (attempt >= 300) {
        throw new SourceFailure("Reading this file is taking too long.", "retry-later");
      }
      await transport.wait(1_000);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setAction(null);
    setJobId(null);
    setStage("");
    setStatus("");
    try {
      if (isFileKind) {
        if (!file) throw new SourceFailure("Choose a file first.");
        await generateRegistered(await uploadAndParse(file));
        return;
      }
      setStatus(kind === "url" ? "Reading the page…" : "");
      const source = await createSource(
        kind === "url" ? { kind, url: text } : { kind, text },
      );
      if (source.status === 401) {
        // A guest can generate from a topic or pasted text, which never leaves the
        // request. Links and files need an account, so say so instead of failing quietly.
        if (!isTextKind) {
          throw new SourceFailure("Sign in to import a link or a file.", "paste-text");
        }
        await generateGuest();
        return;
      }
      if (!source.ok) throw await responseError(source);
      const body = await source.json() as { readonly data: { readonly sourceId: string } };
      await generateRegistered(body.data.sourceId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Generation failed.");
      setAction(failure instanceof SourceFailure ? failure.action ?? null : null);
      setStatus("");
    } finally {
      setPending(false);
    }
  }

  const limit = kind === "topic" ? 500 : kind === "url" ? 2_048 : 30_000;
  const ready = isFileKind ? Boolean(file) && rightsConfirmed : Boolean(text.trim());

  return (
    <form className="stack generation-form" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={pending} className="stack generation-form__fields">
        <div role="tablist" aria-label="Source type" className="row generation-form__tabs">
          {TABS.map((tab) => (
            <button
              key={tab.kind}
              type="button"
              role="tab"
              aria-selected={kind === tab.kind}
              onClick={() => {
                setKind(tab.kind);
                setError("");
                setAction(null);
                setStatus("");
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {isFileKind ? (
          <>
            <label className="field">
              {kind === "pdf" ? "PDF file" : kind === "slides" ? "Slide deck" : "Video file"}
              <input
                className="input"
                type="file"
                // No `required` here: the submit button already stays disabled until a
                // file and the rights confirmation are both in hand, and the browser's
                // own validation bubble would say less than the message below does.
                accept={FILE_ACCEPT[kind as FileSourceKind]}
                onChange={(event) => setFile(event.target.files?.[0] ?? null)}
              />
            </label>
            <p className="meta">{FILE_HINT[kind as FileSourceKind]}</p>
            {kind === "video" ? (
              <label className="field">
                Spoken language (optional)
                <input
                  className="input"
                  value={language}
                  maxLength={12}
                  placeholder="en"
                  onChange={(event) => setLanguage(event.target.value.trim())}
                />
              </label>
            ) : null}
            <label className="row generation-form__rights">
              <input
                type="checkbox"
                checked={rightsConfirmed}
                onChange={(event) => setRightsConfirmed(event.target.checked)}
              />
              I have the rights to use this file.
            </label>
          </>
        ) : (
          <>
            <label className="field">
              {kind === "topic" ? "Topic" : kind === "url" ? "Public link" : "Source text"}
              {kind === "text" ? (
                <textarea
                  className="textarea"
                  required
                  maxLength={limit}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              ) : (
                <input
                  className="input"
                  required
                  type={kind === "url" ? "url" : "text"}
                  inputMode={kind === "url" ? "url" : undefined}
                  placeholder={kind === "url" ? "https://" : undefined}
                  maxLength={limit}
                  value={text}
                  onChange={(event) => setText(event.target.value)}
                />
              )}
            </label>
            {kind === "url" ? (
              <p className="meta">
                A public page we can read without signing in. Paywalled and private pages
                can&apos;t be imported.
              </p>
            ) : (
              <p className="meta">
                {Array.from(text).length.toLocaleString()} / {limit.toLocaleString()}
              </p>
            )}
          </>
        )}

        {props.optionsFields}
      </fieldset>
      <Button type="submit" disabled={pending || !ready}>
        {pending ? "Generating…" : "Generate carousel"}
      </Button>
      {status ? <p className="meta" role="status">{status}</p> : null}
      {jobId ? <GenerationProgress jobId={jobId} /> : null}
      {stage ? <p className="meta">Current stage: {stage}</p> : null}
      {error ? (
        <p role="alert">
          {error}
          {action ? ` ${ACTION_HINT[action]}` : ""}
        </p>
      ) : null}
      <style>{`
        .generation-form__fields { border: 0; margin: 0; padding: 0; min-width: 0; }
        .generation-form .field { display: flex; flex-direction: column; gap: 6px; color: var(--muted); font-size: 13px; }
        .generation-form .input, .generation-form .textarea, .generation-form .select {
          width: 100%; padding: 10px 13px; border: 1px solid var(--border); border-radius: var(--radius);
          background: var(--surface); color: var(--fg); font: inherit;
        }
        .generation-form .textarea { min-height: 110px; resize: vertical; line-height: 1.5; }
        .generation-form__rights { align-items: center; gap: 8px; color: var(--muted); font-size: 13px; }
        .generation-form__tabs { flex-wrap: wrap; }
        .generation-form__tabs button {
          padding: 8px 16px; border: 1px solid var(--border); border-radius: var(--radius-pill);
          background: var(--surface); color: var(--muted);
        }
        .generation-form__tabs button[aria-selected="true"] {
          border-color: var(--fg); background: var(--fg); color: var(--on-ink);
        }
      `}</style>
    </form>
  );
}
