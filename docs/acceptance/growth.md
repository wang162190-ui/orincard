# B10 growth acceptance

Updated: 2026-09-10 (Asia/Shanghai)

## Current verdict

T084 passes the local public-entry, consent refusal, application, status, support, and legal-draft browser checks. Affiliate application and dashboard responses in the browser test are controlled route fixtures so the UI states are reproducible; they are not recorded as development Supabase or payment-provider evidence.

The paid conversion, commission, and refund lifecycle remains **blocked for real Sandbox acceptance**. No approved test Price mapping and complete signed payment lifecycle were available for this run. Mocked conversions or refunds are not counted as passing evidence.

## Acceptance matrix

| Path | Evidence | Verdict |
| --- | --- | --- |
| Public entry points | Playwright opens home, templates, and Affiliate entry pages | Passed locally |
| Affiliate consent refusal | Real application route returns `204` and does not set an attribution cookie when consent is false | Passed locally |
| Affiliate application | Playwright verifies submitted channel/audience and the pending-review message | Passed locally with a controlled API response |
| Affiliate status | Playwright verifies pending and approved UI, gated referral link, refund-adjusted net amount, and absence of purchaser identity | Passed locally with controlled API responses |
| Support | Playwright verifies only the diagnostic ID explicitly selected by the user is submitted | Passed locally with a controlled API response |
| Legal policies | Privacy, Terms, and Affiliate pages display a draft warning and `noindex`; unit policy gate requires matching human approval evidence for exact version and content hash | Passed locally as review-only drafts |
| Paid referral attribution | Requires a real approved referral, Stripe test Checkout, signed event, and persisted referral link | Blocked: real Sandbox lifecycle not configured |
| Commission refund/reversal | Requires a real Stripe test refund and signed reconciliation event | Blocked: real Sandbox lifecycle not configured |

## Release gates

- Keep all three legal documents in `draft` and non-indexed until a human reviewer approves the exact policy version and content hash. Draft browser coverage does not authorize publication.
- Configure approved Stripe **test** Price IDs and the development webhook before running paid attribution. Live keys and live Prices are forbidden in acceptance.
- Complete a real test Checkout through an approved referral, verify the signed conversion event, then issue a real test refund and verify the linked reversal.
- Confirm the Affiliate dashboard aggregates the real conversion and reversal without exposing purchaser identity.

## Local command

```bash
pnpm exec playwright test tests/e2e/growth.spec.ts --project=chromium
```
