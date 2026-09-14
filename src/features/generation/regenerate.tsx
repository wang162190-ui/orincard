"use client";

import { useTranslations } from "next-intl";
import { useRef, useState } from "react";
import type {
  GenerationOptions,
  RegenerationCandidate,
} from "../../server/generation";

type RegenerationMode = "replace" | "save_copy";

export function Regenerate(props: {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly options: GenerationOptions;
  readonly onConfirmed: (result: { readonly projectId: string; readonly revision: number }) => void;
}) {
  const t = useTranslations("Regenerate");
  const [open, setOpen] = useState(false);
  const [candidate, setCandidate] = useState<RegenerationCandidate | null>(null);
  const [generateConfirmed, setGenerateConfirmed] = useState(false);
  const [choiceConfirmed, setChoiceConfirmed] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const generationKey = useRef(crypto.randomUUID());
  const confirmationKeys = useRef<Record<RegenerationMode, string>>({
    replace: crypto.randomUUID(),
    save_copy: crypto.randomUUID(),
  });

  async function post(body: Record<string, unknown>, idempotencyKey: string) {
    const response = await fetch(`/api/v1/projects/${props.projectId}/regenerate`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json() as {
      readonly data?: unknown;
      readonly error?: { readonly message?: string };
    };
    if (!response.ok) throw new Error(payload.error?.message ?? t("failed"));
    return payload.data;
  }

  async function generate() {
    setPending(true);
    setError("");
    try {
      const data = await post({
        expectedRevision: props.expectedRevision,
        options: props.options,
        confirmed: generateConfirmed,
      }, generationKey.current) as { readonly candidate: RegenerationCandidate };
      setCandidate(data.candidate);
      setChoiceConfirmed(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("failed"));
    } finally {
      setPending(false);
    }
  }

  async function confirm(mode: RegenerationMode) {
    if (!candidate) return;
    setPending(true);
    setError("");
    try {
      const result = await post({
        action: "confirm",
        candidateJobId: candidate.candidateJobId,
        expectedRevision: props.expectedRevision,
        mode,
        confirmed: choiceConfirmed,
      }, confirmationKeys.current[mode]) as { readonly projectId: string; readonly revision: number };
      props.onConfirmed(result);
      setOpen(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : t("confirmFailed"));
    } finally {
      setPending(false);
    }
  }

  function openDialog() {
    generationKey.current = crypto.randomUUID();
    confirmationKeys.current = {
      replace: crypto.randomUUID(),
      save_copy: crypto.randomUUID(),
    };
    setCandidate(null);
    setGenerateConfirmed(false);
    setChoiceConfirmed(false);
    setError("");
    setOpen(true);
  }

  return (
    <>
      <button type="button" onClick={openDialog}>{t("open")}</button>
      {open ? (
        <section role="dialog" aria-modal="true" aria-labelledby="regenerate-title">
          <h2 id="regenerate-title">{t("heading")}</h2>
          {candidate ? (
            <>
              <p>{t("candidate", { title: candidate.document.title })}</p>
              <p>{t("unchanged")}</p>
              <label>
                <input
                  type="checkbox"
                  checked={choiceConfirmed}
                  onChange={(event) => setChoiceConfirmed(event.target.checked)}
                />
                {t("confirmChoice")}
              </label>
              <button type="button" disabled={pending || !choiceConfirmed} onClick={() => void confirm("save_copy")}>
                {t("saveCopy")}
              </button>
              <button type="button" disabled={pending || !choiceConfirmed} onClick={() => void confirm("replace")}>
                {t("replace")}
              </button>
            </>
          ) : (
            <>
              <p>{t("intro")}</p>
              <label>
                <input
                  type="checkbox"
                  checked={generateConfirmed}
                  onChange={(event) => setGenerateConfirmed(event.target.checked)}
                />
                {t("confirmGenerate")}
              </label>
              <button type="button" disabled={pending || !generateConfirmed} onClick={() => void generate()}>
                {t("generate")}
              </button>
            </>
          )}
          {error ? <p role="alert">{error}</p> : null}
          <button type="button" disabled={pending} onClick={() => setOpen(false)}>{t("cancel")}</button>
        </section>
      ) : null}
    </>
  );
}
