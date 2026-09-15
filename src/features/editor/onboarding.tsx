"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import { Button, Panel, PanelBody, PanelHeader } from "@/components/ui";

/**
 * 第一次进编辑器的三步引导。
 *
 * 状态只进 localStorage，**不进服务端**：它不值得一张表，也不值得一次往返；用户换台机器
 * 再看一次引导的代价，远小于为此加一列、加一条迁移、加一次 CAS 往返。
 *
 * 初始 `open` 恒为 false，读 localStorage 放在 effect 里——服务端渲染不出这个面板，
 * 客户端首帧也不出，然后才决定要不要展开。这样既没有 hydration 不一致，也不会出现
 * 「闪一下又消失」。
 */
const STORAGE_KEY = "orincard-editor-onboarding";
const STEP_COUNT = 3;

export function EditorOnboarding() {
  const t = useTranslations("Onboarding");
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState(1);

  useEffect(() => {
    try {
      if (globalThis.localStorage?.getItem(STORAGE_KEY) !== "done") {
        setOpen(true);
      }
    } catch {
      // 隐私模式下 localStorage 可能直接抛错。引导看不看得到都不该挡住编辑器，
      // 所以这里吞掉异常、当作"已经看过"处理。
    }
  }, []);

  function dismiss() {
    setOpen(false);
    try {
      globalThis.localStorage?.setItem(STORAGE_KEY, "done");
    } catch {
      // 同上：存不下就只在本次会话里生效。
    }
  }

  if (!open) {
    return null;
  }

  return (
    <Panel
      aria-label={t("title")}
      data-testid="editor-onboarding"
      style={{ borderColor: "var(--fg)" }}
    >
      <PanelHeader className="row-between">
        <h2 className="h3">{t("title")}</h2>
        <span className="meta">{t("progress", { current: step, total: STEP_COUNT })}</span>
      </PanelHeader>
      <PanelBody className="stack">
        <p>
          <strong>{t(`step${step}Title`)}</strong>
        </p>
        <p>{t(`step${step}Body`)}</p>

        {step === STEP_COUNT ? (
          <p>
            <Link href="/exports">{t("exportsLink")}</Link>
          </p>
        ) : null}

        <div className="row wrap">
          <Button
            variant="ghost"
            size="small"
            disabled={step === 1}
            onClick={() => setStep((current) => Math.max(1, current - 1))}
          >
            {t("back")}
          </Button>
          {step < STEP_COUNT ? (
            <Button
              variant="primary"
              size="small"
              onClick={() => setStep((current) => Math.min(STEP_COUNT, current + 1))}
            >
              {t("next")}
            </Button>
          ) : (
            <Button variant="primary" size="small" onClick={dismiss}>
              {t("done")}
            </Button>
          )}
          <Button variant="ghost" size="small" onClick={dismiss}>
            {t("skip")}
          </Button>
        </div>
      </PanelBody>
    </Panel>
  );
}
