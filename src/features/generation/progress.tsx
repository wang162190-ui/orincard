"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import type { JobState, JobStatus } from "../../server/jobs";

export interface GenerationProgressSnapshot {
  readonly jobId: string;
  readonly state: JobState;
  readonly stage: string;
  readonly progress: number;
  readonly resultRef: Readonly<Record<string, unknown>> | null;
  readonly errorCode: string | null;
}

type FetchJob = (jobId: string) => Promise<{ readonly data: JobStatus }>;

async function fetchJob(jobId: string): Promise<{ readonly data: JobStatus }> {
  const response = await fetch(`/api/v1/jobs/${encodeURIComponent(jobId)}`, {
    cache: "no-store",
  });
  const body = (await response.json()) as {
    readonly data?: JobStatus;
    readonly error?: { readonly message?: string };
  };
  if (!response.ok || !body.data) {
    throw new Error(body.error?.message ?? "Generation progress is unavailable.");
  }
  return { data: body.data };
}

export async function loadGenerationProgress(
  jobId: string,
  loader: FetchJob = fetchJob,
): Promise<GenerationProgressSnapshot> {
  const response = await loader(jobId);
  if (response.data.id !== jobId || response.data.kind !== "generation") {
    throw new Error("Generation job not found.");
  }
  return {
    jobId,
    state: response.data.state,
    stage: response.data.stage,
    progress: response.data.progress,
    resultRef: response.data.resultRef,
    errorCode: response.data.errorCode,
  };
}

const terminalStates = new Set<JobState>([
  "succeeded",
  "partial",
  "failed",
  "canceled",
]);

export function GenerationProgress({ jobId }: { readonly jobId: string }) {
  const t = useTranslations("Progress");
  const [snapshot, setSnapshot] = useState<GenerationProgressSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await loadGenerationProgress(jobId);
        if (!active) return;
        setSnapshot(next);
        setError(null);
        if (!terminalStates.has(next.state)) {
          timer = setTimeout(refresh, 1_000);
        }
      } catch {
        if (active) setError(t("unavailable"));
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, t]);

  if (error) return <p role="alert">{error}</p>;
  if (!snapshot) return <p aria-live="polite">{t("starting")}</p>;
  return (
    <section aria-label={t("label")} aria-live="polite">
      <p>{snapshot.state === "succeeded" ? t("ready") : t("generating", { stage: snapshot.stage })}</p>
      <progress max={100} value={snapshot.progress}>
        {snapshot.progress}%
      </progress>
    </section>
  );
}
