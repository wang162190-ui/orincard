# Orincard B04 → Claude Code 交接文档

更新时间：2026-09-07（Asia/Shanghai）

## 1. 目标与不可变边界

工作目录：`/Users/www.macpe.cn/Documents/ChatGPT/Orincard-walking-skeleton`

协调分支：`codex/walking-skeleton`

Git 起点：`4099764`。不要从 `main` 开始，不要合并 `main`，完成后仍停在 `codex/walking-skeleton`。

近期唯一目标是完成 B04 的 T027–T037，交付真实闭环：

`Topic/Text → DeepSeek AI 生成 → 编辑 → 注册保存 → 刷新恢复 → 真实 PNG/PDF`

用户已经明确批准将 B04 AI 供应商从 OpenAI `gpt-5.6-luna` 改为 DeepSeek `deepseek-v4-pro`。产品范围、视觉方向、数据模型、HTTP 契约以及 B05 之后的任务仍不可改变。

必须保留的 AI 约束：Responses API、JSON Schema Structured Outputs、`store:false`、一次有界 schema 修复。不得用 mock 伪造 AI、Storage、PNG、PDF 或 Trigger.dev 云端成功。

## 2. 开始前必须按顺序完整阅读

1. `project.md`
2. `.codexignore`
3. `docs/sdd/orincard/spec.md`
4. `docs/sdd/orincard/plan.md`
5. `docs/sdd/orincard/tasks.md`
6. `docs/acceptance/foundation.md`
7. `CHANGELOG.md`

遵守 `.codexignore`，不要读取被忽略的密钥文件。所有正式检查显式使用：

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

## 3. 当前 Git 真实状态

当前 HEAD：`0ffc5bb test(T028): require DeepSeek Responses contract (AC-002 AC-003)`

本地分支比 `origin/codex/walking-skeleton` 领先 20 个提交；远端仍停在 `9c26bd0`。此前两次 `git push origin codex/walking-skeleton` 均超过 60 秒没有输出，已安全中止；不要假设已经推送。

工作区当前不是干净的。以下 6 个文件包含尚未提交的 DeepSeek 实现：

- `src/server/ai.ts`
- `src/trigger/generate.ts`
- `src/app/api/v1/guest/generate/route.ts`
- `src/app/api/v1/projects/[id]/regenerate/route.ts`
- `src/app/api/v1/projects/[id]/rewrite/route.ts`
- `tests/e2e/walking-skeleton.spec.ts`

不要 reset、checkout 或覆盖这些修改。它们已经通过以下定向检查：

```text
generation/generation-job/guest/rewrite/regenerate：42 passed，2 cloud skipped
pnpm typecheck：通过
```

DeepSeek 失败测试已先提交为 `0ffc5bb`，符合测试先行。接下来应审查上述未提交 diff，补齐文档后作为 T028 实现提交。

## 4. 已完成并已提交的 B04 工作

重要提交（由新到旧）：

```text
0ffc5bb test(T028): require DeepSeek Responses contract (AC-002 AC-003)
57cf565 fix(T034): install licensed fonts in Trigger image (AC-004 AC-006)
5c5fc45 test(T034): require export fonts in Trigger image (AC-004 AC-006)
ecc052b test(T029): exercise deployed generation by durable job ID (AC-002 AC-003)
0c8146d test(T037): verify the real walking-skeleton artifacts (AC-001 AC-002 AC-003 AC-006 AC-007)
87ae73c fix(T030): preserve guest guards in local browser runs (AC-001 AC-002)
74cd8f2 test(T030): require safe local browser subject fallback (AC-001 AC-002)
233915e fix(T031): restore saved projects in the editor (AC-001 AC-003 AC-007)
0b897a4 fix(T037): seed bounded development AI budget (AC-002 AC-003)
e95a0d8 fix(T030): enforce shared hourly guest rate limits (AC-001 AC-002)
d0330b6 test(T030): require a stable guest rate window (AC-001 AC-002)
4655413 fix(T037): exercise generation lease and cost state (AC-002 AC-003)
0679f01 fix(T036): dispatch each durable export job (AC-006 AC-007)
a25faff test(T036): require durable export task dispatch (AC-006 AC-007)
41c88d9 test(B02): stabilize late IndexedDB close assertion (AC-007)
45ceba5 feat(T037): add atomic B04 persistence and export security (AC-002 AC-003 AC-006 AC-007)
2ca23cd fix(T027): make source writes atomic and idempotent (AC-002)
70264fa merge: integrate T031 Topic and Text creation flow (AC-001 AC-002)
```

T027–T037 仍未在 `tasks.md` 勾选，这是有意的：真实云验收尚未完成。

## 5. 数据库状态

Supabase 开发项目：`orincard-dev`

Project ref：`ettuzeunkadkfnawawdy`

B04 SQL 文件：

- `supabase/definitions/b04.sql`
- `supabase/migrations/20260907002243_b04.sql`
- `supabase/tests/b04.sql`

definition 与 migration 当前应逐字相同。B04 包含项目导出表、私有 Storage bucket/RLS、14 个 service-role-only RPC、来源/任务幂等、生成 lease、用户额度和成本预留、候选改写/重生成、导出最终绑定以及开发月预算种子。

最近一次本地验证：

```text
supabase db reset：通过
全量 pgTAP：191/191 通过
```

云端迁移尚未应用。`supabase link --project-ref ettuzeunkadkfnawawdy` 曾因当前 CLI 账号无项目权限失败。需要用户在自己的终端安全配置 `SUPABASE_ACCESS_TOKEN` 和 `SUPABASE_DB_PASSWORD`，不得让用户把值发到聊天。

Supabase Auth 泄露密码保护仍未开启，项目存在 1 项 WARN；验收文档必须如实保留，不能写成 0 项。

## 6. Trigger.dev 状态

项目：`orincard-dev`

Project ID：`proj_bhwgeecxnhxxjrkmdqvh`

最新已成功部署版本：`20260907.2`。该版本包含生成和基础导出任务，也通过 `additionalPackages` 安装了三组许可字体；但它是在 DeepSeek 未提交修改之前部署的，因此仍是旧 OpenAI 适配代码，不能用于最终验收。

DeepSeek 实现提交后必须重新部署：

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
pnpm trigger:deploy:prod
```

Trigger.dev Production Secrets 至少需要：

```text
DEEPSEEK_API_KEY
APP_ENV=development
NEXT_PUBLIC_APP_URL
NEXT_PUBLIC_SUPABASE_URL
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY
SUPABASE_SECRET_KEY
SUPABASE_PROJECT_REF
```

只检查变量是否存在，不读取或打印其值。DeepSeek 官方基址为 `https://api.deepseek.com`；当前未提交适配器使用 OpenAI Node SDK连接该基址，并调用 Responses API。

## 7. 已实现的 T037 真实验收

`tests/e2e/walking-skeleton.spec.ts` 已创建，固定：

- 单 worker；
- `trace: "off"`；
- `screenshot: "off"`；
- 10 分钟总超时；
- 登录等待 30 秒；
- 登录提交后立即清空密码输入框；
- 临时下载仅在 Playwright 生命周期中使用，不提交产物。

测试真实执行：匿名 Topic 生成 4 页 → 编辑标题 → 从 IndexedDB 读取实际编辑稿 → 邮箱登录 → 显式迁移到云项目 → 删除本地 IndexedDB → 云项目页面刷新恢复 → 对 PNG ZIP/PDF 分别预检 → 创建并等待真实 Trigger 导出任务 → 以认证用户从私有 Storage 下载 → 验证 PDF `%PDF-` 和 ZIP 内 4 个真实 PNG 签名 → 验证未认证 Storage 下载失败 → 清理测试项目和对象。

目前只验证了测试可编译且无云开关时按设计跳过；尚未真实通过。

## 8. 下一步严格执行顺序

1. 审查当前 6 个未提交 DeepSeek 文件，不要丢失修改。
2. 更新 `docs/sdd/orincard/plan.md`：在选型矩阵/ADR 中记录 DeepSeek Responses API、`deepseek-v4-pro`、`store:false`、JSON Schema 和一次修复；记录这是用户于 2026-09-07 批准的供应商替换。
3. 更新 `docs/sdd/orincard/tasks.md` 的 T028 文案，使其明确为 DeepSeek；不要提前勾选。
4. 搜索并清除 B04 代码/测试中的旧名称：

   ```bash
   rg -n "createOpenAI|OPENAI_API_KEY|gpt-5\\.6-luna|Luna|OpenAI Responses" src tests docs/sdd/orincard
   ```

5. 跑 DeepSeek 定向测试与类型检查。显式 `git add`，检查 staged diff、`git diff --cached --check` 和密钥模式，再提交实现，例如：

   ```text
   feat(T028): use DeepSeek Responses structured generation (AC-002 AC-003)
   ```

6. 用户在 Trigger.dev Secret 与本机终端完成 `DEEPSEEK_API_KEY` 等凭据配置后，重新部署 Trigger.dev。不要要求用户在聊天中粘贴任何值。
7. 使用有权限的 Supabase CLI 身份 link 开发项目，先确认 migration list，再应用 B04 migration；不得操作生产项目。
8. 串行执行真实云测试：

   ```bash
   ORINCARD_RUN_TEXT_SOURCE_CLOUD=1 pnpm exec vitest run tests/cloud/text-source.test.ts
   ORINCARD_RUN_GENERATION_CLOUD=1 pnpm exec vitest run tests/cloud/generation.test.ts
   ORINCARD_RUN_GENERATION_JOB_CLOUD=1 pnpm exec vitest run tests/cloud/generation-job.test.ts
   ORINCARD_RUN_TEXT_GENERATION_E2E=1 pnpm exec playwright test tests/e2e/text-generation.spec.ts --workers=1
   ORINCARD_RUN_WALKING_SKELETON_E2E=1 pnpm exec playwright test tests/e2e/walking-skeleton.spec.ts --workers=1
   ```

9. 若云测试暴露真实问题，继续每个修复先失败测试、后实现，并保持每项可审查提交。
10. 只有全部真实验收通过后，才勾选 T027–T037，新增/更新 `docs/acceptance/walking-skeleton.md`，并更新 `CHANGELOG.md`。
11. 最终完整门禁：

   ```bash
   pnpm typecheck
   pnpm test
   pnpm test:planning
   pnpm build
   pnpm exec supabase test db
   ```

   最近一次 DeepSeek 迁移前的结果为：非云 114 passed / 5 skipped；规划 19/19；B04 定向 68 passed / 3 skipped；生产构建通过；pgTAP 191/191。

12. 删除当次临时截图、下载和 Playwright 产物。最终显式 staged 检查、密钥扫描、commit、push。若 Git push 再次无输出，不要无限等待或伪称成功。

## 9. 重要安全与实现注意事项

- 密钥、密码、原始正文不得进入 Git、日志、trace、截图、Trigger 任务载荷或聊天。
- Worker 任务载荷只允许 `{ jobId, schemaVersion, requestId }`。
- 匿名来源正文只在短请求中处理；数据库仅保存 HMAC 元数据。
- 不要改变 `tests/e2e/projects-save.spec.ts` 的 30 秒云登录等待、安全清空密码字段、关闭 trace/失败截图处理。
- Playwright 固定单 worker。
- 所有云部署和真实云测试在协调线串行执行。
- 不要开发 T038/B05 或之后任务。
- 不要因供应商改为 DeepSeek而修改 Supabase 数据模型或公开 HTTP API。
- DeepSeek JSON Schema 返回仍必须经过本地 Zod/domain schema 校验；失败时最多进行一次既有 schema 修复，不能返回空成功。
- `store:false` 必须保留。官方参考：<https://api-docs.deepseek.com/api/create-response/>。

## 10. 可直接交给 Claude Code 的启动指令

```text
请在 /Users/www.macpe.cn/Documents/ChatGPT/Orincard-walking-skeleton 的 codex/walking-skeleton 分支继续 B04。先依次完整阅读 project.md、.codexignore、spec.md、plan.md、tasks.md、foundation.md、CHANGELOG.md，再完整阅读 docs/handoff/b04-claude-code.md。不要 reset 当前 6 个未提交 DeepSeek 文件。用户已批准改用 DeepSeek deepseek-v4-pro。先完成并提交 DeepSeek 适配与文档更新，再等待我只在终端/Trigger Secret 中配置凭据，随后完成 Supabase 开发库迁移、Trigger 重新部署、真实云测试、T037 Playwright、验收文档与最终推送。不要合并 main，不要开发 B05，不要伪造任何云结果。
```
