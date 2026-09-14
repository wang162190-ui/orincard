"use client";

import { useTranslations } from "next-intl";
import type { RewriteProposal } from "../../server/rewrite";

export function AIProposal(props: {
  readonly proposal: RewriteProposal;
  readonly pending?: boolean;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}) {
  const t = useTranslations("Proposal");
  return (
    <section aria-label={t("label")}>
      <p><strong>{t("before")}</strong> {props.proposal.before}</p>
      <p><strong>{t("after")}</strong> {props.proposal.after}</p>
      <button type="button" disabled={props.pending} onClick={props.onReject}>{t("reject")}</button>
      <button type="button" disabled={props.pending} onClick={props.onAccept}>{t("accept")}</button>
    </section>
  );
}
