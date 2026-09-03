# Orincard

AI carousel creation for individual creators: source → editable slides → brand → assets → export.

**Status:** approved product and cloud architecture; implementation plan awaiting review. This repository is a development handoff, not a completed application. No cloud infrastructure has been provisioned by this baseline.

- [Project guide](project.md)
- [Product spec](docs/sdd/orincard/spec.md)
- [Architecture and execution plan](docs/sdd/orincard/plan.md)
- [Data model](docs/sdd/orincard/data-model.md)
- [API contracts](docs/sdd/orincard/contracts/api.md)
- [Development tasks](docs/sdd/orincard/tasks.md)
- [Design reference](docs/design/reference/README.md)
- [Git and operations](docs/sdd/orincard/operations.md)
- [Handoff review and verification limits](docs/sdd/orincard/review.md)

## Validate the handoff

Requires Node.js 22 or later; no dependencies or cloud credentials:

```bash
node scripts/check-planning.mjs
node --test scripts/check-planning.test.mjs
node scripts/validate-plan.mjs docs/sdd/orincard
```

These commands check documentation and copied asset integrity only. Future application tests, their fixtures, and deployment checks are listed in the task plan and are not yet runnable.

## Stack

Next.js / React / TypeScript on Vercel; Supabase Postgres, Auth and private Storage; Trigger.dev managed tasks; cloud AI; Stripe Sandbox; Resend SMTP. No local model or always-on local database required.

## Rights

The user-provided design snapshot is retained for implementation reference. Third-party photographs have separate provenance records and must be rechecked before public distribution. Repository privacy does not confer a license. No competitor code, brand assets or templates are included.
