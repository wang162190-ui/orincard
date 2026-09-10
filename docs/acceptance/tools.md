# B08 seven-tool acceptance

## Implemented behavior

The tool registry exposes Caption, LinkedIn Post, Post Ideas, Quote Card, Infographic, Portrait, and Carousel to Video as independent routes. Every request carries either direct input or an explicit project context selection with an expected revision. A result remains a candidate until the user applies it; applying a supported text result creates a new project revision and a failed or refused apply leaves the source revision unchanged.

Text candidates run through the DeepSeek worker contract deployed as Trigger version `20260910.1`. Visual candidates reuse the production PNG renderer, APIMart portrait provider contract, and MP4 renderer. Quote attribution is rendered only when the user confirms it. Binary outputs use private Storage keys and `tool_outputs` records scoped by owner and job; downloads reject foreign, expired, deleted, or text-only outputs.

## Verification

- `tests/cloud/tools-matrix.test.ts` checks all seven tools through independent and explicit-project inputs, generates each candidate, proves generation does not mutate a project, and checks explicit apply plus refusal/failure preservation.
- `tests/cloud/text-tools.test.ts` checks structured provider output and selected context.
- `tests/cloud/visual-tools.test.ts` renders a real 1080×1080 Chromium PNG and checks portrait/provider and MP4 candidate contracts.
- `tests/cloud/tool-outputs.test.ts` and `supabase/tests/tool-outputs.sql` check owner/job download authorization, private object keys, expiry/deletion, RLS, service-only registration, and schema comments.
- `tests/e2e/tools.spec.ts` opens all seven routes in Chromium.

The development Supabase migration `20260910130000_b08_tool_outputs.sql` was applied on 2026-09-10. The direct endpoint is IPv6-only from this development machine, so the final database verification used the IPv4 Session pooler. After the reset password propagated, `supabase/tests/tool-outputs.sql` completed against the development database with 10/10 pgTAP assertions passing.

The public API currently dispatches the three text tools. The four visual routes return the explicit retryable `503 TOOL_UNAVAILABLE` state until their Trigger worker deployment is enabled; no mock response is reported as provider success. The candidate render/provider contracts are locally verified, but live visual-provider acceptance remains a release blocker.
