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

/**
 * `kind` 是**断言**，不是过滤器：调用方说自己在看哪一类任务，拿回别的类就报错。
 * 编排器复用这个组件时传 `agent`（规划任务）或 `tool`（子任务），默认仍是 `generation`，
 * 所以既有调用点一个字都不用改。放宽成「不检查 kind」会让串了 id 的 bug 悄悄渲染成正常进度。
 */
export async function loadGenerationProgress(
  jobId: string,
  loader: FetchJob = fetchJob,
  kind = "generation",
): Promise<GenerationProgressSnapshot> {
  const response = await loader(jobId);
  if (response.data.id !== jobId || response.data.kind !== kind) {
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

export function GenerationProgress({
  jobId,
  kind = "generation",
}: {
  readonly jobId: string;
  readonly kind?: string;
}) {
  const t = useTranslations("Progress");
  const [snapshot, setSnapshot] = useState<GenerationProgressSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await loadGenerationProgress(jobId, fetchJob, kind);
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
  }, [jobId, kind, t]);

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
