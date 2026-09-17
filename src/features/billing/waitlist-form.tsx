"use client";

import { useLocale, useTranslations } from "next-intl";
import { useId, useState } from "react";
import { Button } from "@/components/ui";

type State = "idle" | "sending" | "joined" | "failed";

/**
 * 等候名单登记表单。定价页和账单页的升级对话框共用一份。
 *
 * 这里真的会把邮箱 POST 到 `/api/v1/waitlist` 并落库。之前的版本只在前端弹一句
 * 「你的邮箱没有被提交也没有被存储」——那句话当时是真的，但它把一个入口做成了摆设：
 * 人填完了，我们什么也没拿到。既然这一轮不接支付，等候名单就是唯一的付费路线，
 * 它必须真的记下来。
 */
export function WaitlistForm({ source, planKey }: {
  readonly source: "pricing" | "billing" | "home";
  readonly planKey?: "pro" | "creator";
}) {
  const t = useTranslations("Waitlist");
  const locale = useLocale();
  const formId = useId();
  const [email, setEmail] = useState("");
  const [state, setState] = useState<State>("idle");

  async function join(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!event.currentTarget.reportValidity()) return;
    setState("sending");
    try {
      const response = await fetch("/api/v1/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim().toLowerCase(), source, locale, ...(planKey ? { planKey } : {}) }),
      });
      setState(response.ok ? "joined" : "failed");
    } catch {
      setState("failed");
    }
  }

  return <div className="stack">
    {state === "joined" ? null : <form id={formId} onSubmit={join}>
      <label>{t("email")}<input aria-label={t("email")} autoComplete="email" disabled={state === "sending"} name="email" onChange={(event) => { setEmail(event.target.value); if (state === "failed") setState("idle"); }} placeholder="you@example.com" required type="email" value={email} /></label>
    </form>}
    <p className={state === "idle" ? "meta" : undefined} role="status">{t(state)}</p>
    {/* 登记成功后按钮和输入框一起收起来：再点一次只会命中去重，按钮还亮着会让人以为没成。 */}
    {state === "joined" ? null : <div><Button disabled={state === "sending"} form={formId} type="submit">{t("submit")}</Button></div>}
  </div>;
}
