"use client";

import { useTranslations } from "next-intl";
import { useCallback, useEffect, useState } from "react";
import { Button, Panel, PanelBody, PanelHeader } from "@/components/ui";
import type { RewriteProposal } from "../../server/rewrite";
import { AIProposal } from "./ai-proposal";

/**
 * 编辑器助手（AC-012 / T098）。
 *
 * 一条硬规则：**这个面板不写项目。** 它发问题、收回答，回答附带的改动是一条 rewrite 候选；
 * 写入只发生在用户点「应用」之后，经由既有的 `/api/v1/projects/:id/apply-proposal`，
 * 带着 `expectedRevision` 与 `baseSlideRevision`。拒绝则只丢弃本地这条提议，项目逐列不变。
 *
 * 状态照 T096 原型的四态 + 冲突态：thinking / proposal / applied / dismissed /
 * apply 失败（源 revision 未变）/ `expectedRevision` 过期冲突 / 额度或预算用尽。
 */

interface ThreadTurn {
  readonly id: string;
  readonly role: "user" | "assistant";
  readonly content: string;
}

interface CopilotResponse {
  readonly jobId: string;
  readonly reply: string;
  readonly proposal: RewriteProposal | null;
}

type Phase =
  | "idle"
  | "thinking"
  | "proposal"
  | "applied"
  | "dismissed"
  | "applyFailed"
  | "conflict"
  | "blocked";

export function AssistantPanel(props: {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly selectedSlideId?: string | null;
}) {
  const t = useTranslations("Assistant");
  const [question, setQuestion] = useState("");
  const [thread, setThread] = useState<readonly ThreadTurn[]>([]);
  const [proposal, setProposal] = useState<RewriteProposal | null>(null);
  const [revision, setRevision] = useState(props.projectRevision);
  const [phase, setPhase] = useState<Phase>("idle");
  const [notice, setNotice] = useState(t("idle"));
  const [busy, setBusy] = useState(false);

  // 项目在别处（自动保存、版本回滚）前进时，助手必须跟着走到新的 head，
  // 否则下一次 apply 会带着一个过期的 expectedRevision 去撞 409。
  useEffect(() => setRevision(props.projectRevision), [props.projectRevision]);

  const history = useCallback(async () => {
    const response = await fetch(
      `/api/v1/copilot?projectId=${encodeURIComponent(props.projectId)}`,
      { cache: "no-store" },
    );
    if (!response.ok) return;
    const body = (await response.json()) as {
      data?: { turns?: readonly { id: string; role: "user" | "assistant"; content: string }[] };
    };
    const turns = body.data?.turns ?? [];
    if (turns.length > 0) {
      setThread(turns.map((turn) => ({ id: turn.id, role: turn.role, content: turn.content })));
    }
  }, [props.projectId]);

  useEffect(() => {
    void history();
  }, [history]);

  async function ask() {
    const message = question.trim();
    if (!message || busy) return;
    setBusy(true);
    setPhase("thinking");
    setProposal(null);
    setNotice(t("thinking"));
    const asked: ThreadTurn = { id: `local-${Date.now()}`, role: "user", content: message };
    setThread((current) => [...current, asked]);
    try {
      const response = await fetch("/api/v1/copilot", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          projectId: props.projectId,
          message,
          slideId: props.selectedSlideId ?? null,
        }),
      });
      const body = (await response.json()) as {
        data?: CopilotResponse;
        error?: { code?: string; message?: string };
      };
      if (!response.ok || !body.data) {
        // 额度或预算用尽时预留就被拒了，**模型根本没被调用**——如实这么说，不说「稍后重试」。
        const blocked = body.error?.code === "QUOTA_EXCEEDED" || body.error?.code === "BUDGET_EXCEEDED";
        setPhase(blocked ? "blocked" : "idle");
        setNotice(blocked ? t("blocked") : (body.error?.message ?? t("askFailed")));
        setThread((current) => current.filter((turn) => turn.id !== asked.id));
        return;
      }
      setQuestion("");
      setThread((current) => [
        ...current,
        { id: body.data!.jobId, role: "assistant", content: body.data!.reply },
      ]);
      setProposal(body.data.proposal);
      setPhase(body.data.proposal ? "proposal" : "idle");
      setNotice(body.data.proposal ? t("proposalReady") : t("answered"));
    } catch {
      setPhase("idle");
      setNotice(t("askFailed"));
      setThread((current) => current.filter((turn) => turn.id !== asked.id));
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!proposal || busy) return;
    setBusy(true);
    setNotice(t("applying"));
    try {
      const response = await fetch(
        `/api/v1/projects/${encodeURIComponent(props.projectId)}/apply-proposal`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json", "Idempotency-Key": crypto.randomUUID() },
          body: JSON.stringify({
            proposalJobId: proposal.proposalJobId,
            expectedRevision: revision,
            baseSlideRevision: proposal.baseSlideRevision,
          }),
        },
      );
      const body = (await response.json()) as {
        data?: { revision: number };
        error?: { code?: string; message?: string };
      };
      if (response.ok && body.data) {
        setRevision(body.data.revision);
        setProposal(null);
        setPhase("applied");
        setNotice(t("applied", { revision: body.data.revision }));
        return;
      }
      // 冲突是**整条写入被拒**，不是部分写入：源项目逐列未变，所以这里也不动本地状态。
      if (body.error?.code === "VERSION_CONFLICT") {
        setPhase("conflict");
        setNotice(t("conflict"));
        return;
      }
      setPhase("applyFailed");
      setNotice(body.error?.message ?? t("applyFailed"));
    } catch {
      setPhase("applyFailed");
      setNotice(t("applyFailed"));
    } finally {
      setBusy(false);
    }
  }

  // 拒绝只是本地丢弃：不发请求，不产生 revision，也不撤销任何已经发生的事。
  function dismiss() {
    setProposal(null);
    setPhase("dismissed");
    setNotice(t("dismissed"));
  }

  return (
    <Panel aria-label={t("label")} data-testid="assistant-panel">
      <PanelHeader className="row-between">
        <h2 className="h3">{t("heading")}</h2>
        <span className="meta">{t("revision", { revision })}</span>
      </PanelHeader>
      <PanelBody>
        <p className="meta">{t("lead")}</p>

        {thread.length > 0 ? (
          <ol aria-label={t("threadLabel")} className="stack" data-testid="assistant-thread">
            {thread.map((turn) => (
              <li key={turn.id}>
                <strong>{turn.role === "user" ? t("you") : t("assistant")}</strong> {turn.content}
              </li>
            ))}
          </ol>
        ) : null}

        <p aria-live="polite" className="meta" data-phase={phase} data-testid="assistant-notice">
          {notice}
        </p>

        {proposal ? (
          <AIProposal onAccept={() => void apply()} onReject={dismiss} pending={busy} proposal={proposal} />
        ) : null}

        {phase === "conflict" ? (
          <p className="meta" data-testid="assistant-conflict">{t("conflictDetail")}</p>
        ) : null}

        <label className="field">
          <span>{t("questionLabel")}</span>
          <textarea
            className="textarea"
            disabled={busy}
            onChange={(event) => setQuestion(event.target.value)}
            placeholder={t("questionPlaceholder")}
            value={question}
          />
        </label>
        <Button disabled={busy || question.trim().length === 0} onClick={() => void ask()} size="small">
          {t("send")}
        </Button>
      </PanelBody>
    </Panel>
  );
}
