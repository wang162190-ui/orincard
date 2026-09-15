"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui";
import { GenerationProgress } from "@/features/generation/progress";

interface PlanStepView {
  readonly tool: string;
  readonly rationale: string;
}

interface PlanView {
  readonly summary: string;
  readonly steps: readonly PlanStepView[];
  readonly clarification?: string;
}

interface RunView {
  readonly jobId: string;
  readonly request: string;
  readonly plan: PlanView | null;
  readonly state: string;
  readonly errorCode: string | null;
  readonly jobState: string;
}

interface StepSubmissionView {
  readonly stepIndex: number;
  readonly tool: string;
  readonly jobId: string;
  readonly submitted: boolean;
}

interface ExecutionView {
  readonly runId: string;
  readonly state: string;
  readonly steps: readonly StepSubmissionView[];
  readonly blocked: { readonly stepIndex: number; readonly code: string } | null;
}

const TERMINAL_JOB_STATES = new Set(["succeeded", "partial", "failed", "canceled"]);

export function AgentPanel() {
  const t = useTranslations("AgentPanel");
  const [request, setRequest] = useState("");
  const [jobId, setJobId] = useState<string | null>(null);
  const [run, setRun] = useState<RunView | null>(null);
  const [execution, setExecution] = useState<ExecutionView | null>(null);
  const [notice, setNotice] = useState(t("idle"));
  const [busy, setBusy] = useState(false);

  const readRun = useCallback(async (id: string): Promise<RunView> => {
    const response = await fetch(`/api/v1/agent?jobId=${encodeURIComponent(id)}`, { cache: "no-store" });
    const body = (await response.json()) as { data?: RunView; error?: { message?: string } };
    if (!response.ok || !body.data) throw new Error(body.error?.message ?? t("readFailed"));
    return body.data;
  }, [t]);

  // 规划任务是异步的，所以这里轮询到终态为止；到终态就停，不留一个永远在跑的定时器。
  useEffect(() => {
    if (!jobId) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const next = await readRun(jobId);
        if (!active) return;
        setRun(next);
        if (TERMINAL_JOB_STATES.has(next.jobState)) {
          setNotice(next.jobState === "succeeded" ? t("planReady") : t("planFailed", { code: next.errorCode ?? next.jobState }));
          return;
        }
        timer = setTimeout(() => void refresh(), 1_500);
      } catch (error) {
        if (active) setNotice(error instanceof Error ? error.message : t("readFailed"));
      }
    };
    void refresh();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [jobId, readRun, t]);

  async function plan() {
    setBusy(true);
    setRun(null);
    setExecution(null);
    setJobId(null);
    setNotice(t("planning"));
    try {
      const response = await fetch("/api/v1/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({ request }),
      });
      const body = (await response.json()) as { data?: { jobId: string }; error?: { message?: string } };
      if (!response.ok || !body.data) {
        setNotice(body.error?.message ?? t("planStartFailed"));
        return;
      }
      setJobId(body.data.jobId);
    } finally {
      setBusy(false);
    }
  }

  // 执行是**用户的另一次显式动作**：计划就绪不会自动续跑，这个按钮就是那道确认。
  async function execute() {
    if (!jobId) return;
    setBusy(true);
    setNotice(t("executing"));
    try {
      const response = await fetch("/api/v1/agent/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jobId }),
      });
      const body = (await response.json()) as { data?: ExecutionView; error?: { message?: string } };
      if (!response.ok || !body.data) {
        setNotice(body.error?.message ?? t("executeFailed"));
        return;
      }
      setExecution(body.data);
      setNotice(body.data.blocked ? t("blocked", { step: body.data.blocked.stepIndex + 1, code: body.data.blocked.code }) : t("executionStarted", { count: body.data.steps.length }));
    } finally {
      setBusy(false);
    }
  }

  const plannedSteps = run?.plan?.steps ?? [];
  const canExecute = run?.state === "ready" && plannedSteps.length > 0;

  return (
    <div className="stack-lg">
      <section className="card stack">
        <h1>{t("heading")}</h1>
        <p>{t("lead")}</p>
        <label>
          {t("requestLabel")}
          <textarea value={request} onChange={(event) => setRequest(event.target.value)} placeholder={t("requestPlaceholder")} maxLength={2_000} />
        </label>
        <div>
          <Button disabled={busy || request.trim().length === 0} onClick={() => void plan()}>{t("plan")}</Button>
        </div>
      </section>

      {jobId && run && !TERMINAL_JOB_STATES.has(run.jobState) ? <GenerationProgress jobId={jobId} kind="agent" /> : null}

      {run?.plan ? (
        <section className="card stack">
          <h2>{t("planHeading")}</h2>
          <p>{run.plan.summary}</p>
          {/* 零步计划是合法结果：模型说不清就该说缺什么，而不是硬凑几步出来。 */}
          {run.plan.clarification ? <p role="note">{t("clarification", { text: run.plan.clarification })}</p> : null}
          {plannedSteps.length > 0 ? (
            <ol>
              {plannedSteps.map((step, index) => (
                <li key={`${step.tool}-${index}`}>
                  <strong>{step.tool}</strong>
                  <span> — {step.rationale}</span>
                </li>
              ))}
            </ol>
          ) : null}
          {canExecute ? (
            <div>
              <Button disabled={busy || execution !== null} onClick={() => void execute()}>{t("confirmAndRun", { count: plannedSteps.length })}</Button>
            </div>
          ) : null}
        </section>
      ) : null}

      {execution ? (
        <section className="card stack">
          <h2>{t("executionHeading")}</h2>
          {/* 某步被闸住时，已提交的步骤照样列出来——它们是真的在跑，不能因为后面卡住就不显示。 */}
          {execution.blocked ? <p role="alert">{t("blocked", { step: execution.blocked.stepIndex + 1, code: execution.blocked.code })}</p> : null}
          {execution.steps.map((step) => (
            <article key={step.jobId} className="stack">
              <h3>{t("stepHeading", { index: step.stepIndex + 1, tool: step.tool })}</h3>
              <GenerationProgress jobId={step.jobId} kind="tool" />
            </article>
          ))}
        </section>
      ) : null}

      <p role="status" className="meta">{notice}</p>
    </div>
  );
}
