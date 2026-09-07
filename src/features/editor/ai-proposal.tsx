"use client";

import type { RewriteProposal } from "../../server/rewrite";

export function AIProposal(props: {
  readonly proposal: RewriteProposal;
  readonly pending?: boolean;
  readonly onAccept: () => void;
  readonly onReject: () => void;
}) {
  return (
    <section aria-label="AI rewrite proposal">
      <p><strong>Before:</strong> {props.proposal.before}</p>
      <p><strong>After:</strong> {props.proposal.after}</p>
      <button type="button" disabled={props.pending} onClick={props.onReject}>Reject</button>
      <button type="button" disabled={props.pending} onClick={props.onAccept}>Accept</button>
    </section>
  );
}
