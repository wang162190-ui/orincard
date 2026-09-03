# Repository instructions

Read `project.md` first. Respect `.codexignore`; do not inspect secrets, user uploads, generated output, or dependencies. Preserve the design reference and do not confuse its simulated behavior with approved product requirements.

Use `apply_patch` for manual edits. Keep changes task-scoped. Use `codex/` branches and explicit staging; inspect staged diffs before commits. Every schema table/column/function needs a SQL comment and permissions test. Never use client-supplied owner IDs for authorization or expose service credentials.

Current phase is technical handoff, HARD-GATE 2. Do not implement application features or provision paid services before the execution plan is reviewed. A successful planning validator is not successful product acceptance.

Do not start local Docker Supabase, local AI models, or long-running media workers. Cloud work must use isolated development resources; never run tests or destructive migrations against production. Missing credentials must result in an explicit unavailable state, not a fake successful result.
