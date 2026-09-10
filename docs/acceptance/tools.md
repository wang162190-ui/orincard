# B08 seven-tool acceptance

## Implemented behavior

The tool registry exposes Caption, LinkedIn Post, Post Ideas, Quote Card, Infographic, Portrait, and Carousel to Video as independent routes. Every request carries either direct input or an explicit project context selection with an expected revision. A result remains a candidate until the user applies it; applying a supported text result creates a new project revision and a failed or refused apply leaves the source revision unchanged.

Text candidates run through the DeepSeek worker contract deployed as Trigger version `20260910.1`. Visual candidates reuse the production PNG renderer, APIMart portrait provider contract, and MP4 renderer. Quote attribution is rendered only when the user confirms it. Binary outputs use private Storage keys and `tool_outputs` records scoped by owner and job; downloads reject foreign, expired, deleted, or text-only outputs.

## Verification

- `tests/cloud/tools-matrix.test.ts` checks all seven tools through independent and explicit-project inputs, generates each candidate, proves generation does not mutate a project, and checks explicit apply plus refusal/failure preservation.
- `tests/cloud/text-tools.test.ts` checks structured provider output and selected context.
- `tests/cloud/visual-tools.test.ts` renders a real 1080×1080 Chromium PNG and checks portrait/provider and MP4 candidate contracts with injected stores; it is a local contract check, not cloud evidence.
- `tests/cloud/visual-tools-live.test.ts` is the real one: gated by `ORINCARD_RUN_VISUAL_TOOLS_CLOUD=1`, it drives the deployed worker over the development project and fails loudly on a missing variable instead of skipping.
- `tests/cloud/tool-outputs.test.ts` and `supabase/tests/tool-outputs.sql` check owner/job download authorization, private object keys, expiry/deletion, RLS, service-only registration, and schema comments.
- `tests/e2e/tools.spec.ts` opens all seven routes in Chromium.

The development Supabase migration `20260910130000_b08_tool_outputs.sql` was applied on 2026-09-10. The direct endpoint is IPv6-only from this development machine, so the final database verification used the IPv4 Session pooler. After the reset password propagated, `supabase/tests/tool-outputs.sql` completed against the development database with 10/10 pgTAP assertions passing.

## Visual tool release blocker — closed 2026-09-10

The four visual routes previously returned the explicit retryable `503 TOOL_UNAVAILABLE` state because no worker existed for them. `src/trigger/visual-tool.ts` now runs them, `src/app/api/v1/tools/[tool]/route.ts` dispatches them on the same idempotency and jobs path as the text tools, and Trigger version `20260910.3` carries the `orincard-visual-tool` task. The `503 TOOL_UNAVAILABLE` branch no longer exists in the codebase.

`tests/cloud/visual-tools-live.test.ts` drove all four tools end to end against the development Supabase project and that deployed worker, with `ORINCARD_RUN_VISUAL_TOOLS_CLOUD=1`: 5 passed in 183.85s. Every artifact below was rendered by the real Chromium, the real APIMart GPT-Image-2 provider and the real ffmpeg inside the worker container, then downloaded back out of private Storage. The recorded byte length and SHA-256 were re-computed from the downloaded bytes and matched the values `server_register_tool_output` stored.

| Tool | Type | Bytes | SHA-256 | Dimensions / duration |
| --- | --- | --- | --- | --- |
| Quote Card | image/png | 29,887 | `25249fefb2f16d2af0ae675e504b7bc8aa1075ffb1b6354b9e315ecc6c9a40b5` | 1080×1080 |
| Infographic | image/png | 32,874 | `bdae4e72f8431f2091c62251bcb88477a9aaba481bc362071530f70f544ef423` | 1080×1350 |
| Portrait | image/png | 1,777,066 | `66e4f9e47e5631d742136f41f5a0d6221cfcdc644e30df2b456889f3fe073765` | 1024×1024 |
| Carousel to Video | video/mp4 | 4,600 | `ecd25fd3832614cf30a67a43044544b5da12e98cafecfbdc5d5e98d52fc6cf43` | 4,040 ms |

The MP4 was additionally verified with `ffprobe`: one H.264 video stream at 1080×1350. The portrait consumed one real APIMart image at the `1k` / `1:1` floor and its reservation settled to `ready`; the generated portrait asset carries no `accepted_at`, so it remains a candidate until the user accepts it.

Known limitation: the acceptance run leaves its reference and slide fixture assets in the development project. They are owned by the test account and marked as original Orincard renders; nothing removes them automatically.
