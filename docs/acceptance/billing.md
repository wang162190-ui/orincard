# B09 billing acceptance

Updated: 2026-09-10 (Asia/Shanghai)

## Current verdict

T073 is **blocked for real lifecycle acceptance**. T071 webhook reconciliation and T072 billing UI are implemented and locally verified, but the development environment does not currently provide an approved Stripe test Price mapping (`STRIPE_TEST_MONTHLY_PRICES_JSON`) and explicit Sandbox lifecycle opt-in. No mock or local database assertion is recorded as a real Stripe subscription result.

The opt-in test in `tests/cloud/billing-lifecycle.test.ts` refuses live keys, requires a server-owned test Price mapping, creates real hosted Checkout and Portal sessions, and deletes its test customer. Run it only with:

```bash
RUN_STRIPE_SANDBOX_LIFECYCLE=1 \
STRIPE_TEST_ACCEPTANCE_PLAN_KEY=pro \
pnpm exec vitest run tests/cloud/billing-lifecycle.test.ts
```

## Lifecycle matrix

| Path | Evidence available | Real Sandbox verdict |
| --- | --- | --- |
| Upgrade / hosted Checkout | T070 adapter tests enforce server customer, Price and promotion mappings | Blocked: no approved test Price ID |
| Renewal | Subscription mirror schema supports period snapshots | Blocked pending a real Sandbox subscription and T071 event processing |
| Payment failure | `past_due` and `unpaid` are modeled | Blocked pending a real signed Stripe event |
| Cancel at period end | Mirror preserves `cancel_at_period_end` without deleting projects | Blocked pending Portal + signed event lifecycle |
| Refund / entitlement reversal | Audit schema can record distinct invoice actions | Blocked pending T071 refund handling and real test event |
| Duplicate and out-of-order events | Development pgTAP suite checks event-ID idempotency, distinct invoices and provider timestamp convergence | Database-level only; not a Stripe webhook pass |
| Concurrent quota settlement | Existing job/usage transactions enforce reservation invariants | Blocked for the combined billing lifecycle until a real subscription grants the tested bucket |

## Database gate

The optional database run is isolated to a development Supabase project and refuses the configured production project reference:

```bash
RUN_BILLING_DB_ACCEPTANCE=1 APP_ENV=development \
pnpm exec vitest run tests/cloud/billing-lifecycle.test.ts
```

Passing this gate proves the database event ledger, ordering rule, append-only audit and owner isolation. It does not prove Stripe signature verification, renewal, payment failure, cancellation, refund, or concurrent entitlement settlement.

## Release blockers

- Configure approved Stripe **test** Price IDs and a test plan key; never use a live key or live Price in this test.
- Deploy T071 webhook verification/event reconciliation with the Stripe test secret before lifecycle acceptance.
- Run upgrade, renewal, failed payment, period-end cancellation and refund against Stripe Sandbox, then verify the subscription mirror and usage ledger after each signed event.
- Run concurrent quota requests after the Sandbox entitlement grant and verify that total reserved plus consumed units never exceeds granted units.
