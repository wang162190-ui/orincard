"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { Button } from "../../components/ui";
import { carouselDocumentSchema, type CarouselDocument } from "../../domain/document";
import { LocalDraftStore, type DraftOwner } from "../editor/local-drafts";
import type { GenerationOptions } from "../../server/generation";
import { GenerationProgress } from "./progress";

type SourceKind = "topic" | "text";

const SESSION_OWNER_KEY = "orincard-anonymous-session";
const GUEST_NONCE_KEY = "orincard-guest-generation-nonce";

function browserValue(key: string, prefix: string): string {
  let value = localStorage.getItem(key);
  if (!value) {
    value = `${prefix}-${crypto.randomUUID()}`;
    localStorage.setItem(key, value);
  }
  return value;
}

async function responseError(response: Response): Promise<Error> {
  const body = await response.json().catch(() => null) as {
    readonly error?: { readonly message?: string };
  } | null;
  return new Error(body?.error?.message ?? "Generation is temporarily unavailable.");
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

export function SourceInput(props: {
  readonly options: GenerationOptions;
  readonly optionsFields: ReactNode;
}) {
  const [kind, setKind] = useState<SourceKind>("topic");
  const [text, setText] = useState("");
  const [pending, setPending] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const [stage, setStage] = useState("");
  const [error, setError] = useState("");

  async function saveAndOpen(document: CarouselDocument) {
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
  }

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
    await saveAndOpen(guestDocument(payload));
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
    await saveAndOpen(await waitForJob(body.data.jobId, setStage));
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setPending(true);
    setError("");
    setJobId(null);
    setStage("");
    try {
      const source = await fetch("/api/v1/sources", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": `source-${crypto.randomUUID()}`,
        },
        body: JSON.stringify({ kind, text }),
      });
      if (source.status === 401) {
        await generateGuest();
        return;
      }
      if (!source.ok) throw await responseError(source);
      const body = await source.json() as { readonly data: { readonly sourceId: string } };
      await generateRegistered(body.data.sourceId);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Generation failed.");
    } finally {
      setPending(false);
    }
  }

  const limit = kind === "topic" ? 500 : 30_000;
  return (
    <form className="stack generation-form" onSubmit={(event) => void submit(event)}>
      <fieldset disabled={pending} className="stack generation-form__fields">
        <div role="tablist" aria-label="Source type" className="row generation-form__tabs">
          {(["topic", "text"] as const).map((sourceKind) => (
            <button
              key={sourceKind}
              type="button"
              role="tab"
              aria-selected={kind === sourceKind}
              onClick={() => setKind(sourceKind)}
            >
              {sourceKind === "topic" ? "Topic" : "Text"}
            </button>
          ))}
        </div>
        <label className="field">
          {kind === "topic" ? "Topic" : "Source text"}
          {kind === "topic" ? (
            <input
              className="input"
              required
              maxLength={limit}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          ) : (
            <textarea
              className="textarea"
              required
              maxLength={limit}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          )}
        </label>
        <p className="meta">{Array.from(text).length.toLocaleString()} / {limit.toLocaleString()}</p>
        {props.optionsFields}
      </fieldset>
      <Button type="submit" disabled={pending || !text.trim()}>
        {pending ? "Generating…" : "Generate carousel"}
      </Button>
      {jobId ? <GenerationProgress jobId={jobId} /> : null}
      {stage ? <p className="meta">Current stage: {stage}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      <style>{`
        .generation-form__fields { border: 0; margin: 0; padding: 0; min-width: 0; }
        .generation-form .field { display: flex; flex-direction: column; gap: 6px; color: var(--muted); font-size: 13px; }
        .generation-form .input, .generation-form .textarea, .generation-form .select {
          width: 100%; padding: 10px 13px; border: 1px solid var(--border); border-radius: var(--radius);
          background: var(--surface); color: var(--fg); font: inherit;
        }
        .generation-form .textarea { min-height: 110px; resize: vertical; line-height: 1.5; }
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
