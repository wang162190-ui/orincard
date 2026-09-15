# 交接：AI 编排器已完工（B14 / T100 T101 T102 全绿）

接上一份 `docs/handoff/agent-step4-claude.md`（那份是**过程记录**，从 Step 4 一路写到 Step 8，含所有试错与根因分析；本份是**当前状态**）。

记录日期：2026-09-15。分支 `codex/walking-skeleton`，未动 `main`。

---

## 0. 硬约束（整场有效，逐条都是用户的要求，请继续遵守）

- 不操作生产项目，只用开发项目。
- **不要用 Supabase MCP 操作本项目**——它指向的不是这个项目的数据库；要查库用 Supabase CLI 或 service key 脚本。
- `.env.local` 可以读，但只在子 shell 里加载（`( set -a; . ./.env.local; set +a; … )`），**绝不打印值**；值不得进入聊天、日志、trace、截图或 Git。
- 花钱默认已批准，但 `AI_MONTHLY_BUDGET_USD=10` 的月度硬顶仍在，**实际花费必须如实上报，超支必须主动说**。
- **不要用 mock 假装某个功能能用。跑不通就说跑不通。**
- 所有命令先 `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`。
- 本机**没有 `timeout` 命令**，长命令用后台 + 看门狗。
- **把服务器留给用户，不要关**：`:3100`（生产构建）、`:3000`（next dev）、`:8080`（http.server）、9 个 `supabase_*_orincard` 容器、以及 `trigger dev` worker。
- 不要跑 `pnpm build`（会覆盖 `:3100` 正在读的 `.next`）；`pnpm lint` 不存在。
- 不要改 `docs/design/reference/`（SHA-256 锁定，`check-planning.mjs` 必须一直报 15 unchanged design files）。
- 不改 `generateStructured` 签名，不去掉 `store:false`；不要把对话历史塞进 Trigger 载荷。
- 路线图只在**真的跑通并验证过之后**才打 ✅，跑不通打 ❌ 并写一行原因。

---

## 1. 当前基线（接手前请复跑，应与此一致）

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
pnpm typecheck                     # exit 0
pnpm test                          # 50 files / 371 passed | 7 skipped
node scripts/check-planning.mjs    # 102 tasks / 14 batches / 50 API paths / 15 unchanged design files
```

三个端口都应 200，`docker ps | grep -c orincard` 应为 9。

---

## 2. 编排器是什么（已拍板的产品形态，不要偏离）

**编排器，不是自主循环。** 用户自然语言描述需求 → 模型**一次**结构化调用产出执行计划 → 前端展示 → **用户确认** → 我们的代码按现有 job 链路逐步执行。

因此：不需要 provider 的 function calling；一次 run 恒等于一次模型调用，`cost_attempts` 的 sequence 恒为 1，Trigger 重试复用同一行、不撞 23505。

### 代码地图

| 文件 | 作用 |
|---|---|
| `supabase/migrations/20260915000000_agent_orchestrator.sql` | `agent` 枚举值 + `agent_runs` / `agent_run_steps` + RLS |
| `supabase/migrations/20260915001000_usage_entitlement_grant.sql` + `src/server/billing/entitlement-grant.ts` | 补上此前**全仓库缺失的额度发放**（`usage_accounts` 从来没有任何生产代码路径写过） |
| `src/server/agent/planner.ts` / `prompts.ts` / `plan-run.ts` | 计划 schema、提示词、一次结构化调用 |
| `src/app/api/v1/agent/route.ts` | `POST` 提交需求（202）/ `GET ?jobId=` 读 run |
| `src/trigger/agent.ts` | 规划任务；`AGENT_TASK_ID = "orincard-agent-plan"` 注册在 `src/trigger/dispatch.ts` 的 `BY_JOB_KIND` |
| `src/server/agent/executor.ts` | 用户确认后按步提交子任务 |
| `src/app/api/v1/agent/execute/route.ts` | `POST` 执行（202），返回 `runId/state/steps/blocked` |
| `src/features/agent/agent-panel.tsx` + `src/app/[locale]/agent/page.tsx` | 面板；导航段 `agent` 在 `src/components/workspace-shell.tsx` |

### 四条必须继承的设计约定

1. **提交顺序 `ensureEntitlements → submit → createRun → dispatch` 是刻意的**，有测试逐字守着（`tests/unit/agent-route.test.ts:81`）。`agent_runs.job_id` 有外键所以 job 必须先建；需求正文必须在派发前落盘；**正文落盘失败时绝不派发**。
2. **需求正文只进 `agent_runs.request`，不进 `jobs.input_ref`**，沿用 `b04_begin_ai_candidate_job` 的「不携带正文输入」口径。
3. 由 1 推出：对账兜底重新派发时 run 行仍可能缺失，所以 **Trigger 任务把「找不到 run 行」当作明确失败来报**，绝不当成空需求继续跑。
4. **某步被闸住时不整体回滚**：保留已提交的步骤，`break`，在 `blocked` 里如实回报第几步、什么码。理由写在 `executor.ts` 的注释里——已提交的步骤可能已经在烧 token，回滚既撤不回花费又会抹掉用户已拿到的产出。

### 补充：`private.submit_job` 没有 `p_parent_job_id` 参数

所以 `parent_job_id` 是 submit 之后单独写的。**权威的步骤↔任务映射以 `agent_run_steps` 为准**，不要改成依赖 `parent_job_id`。

---

## 3. 实测成本（真实供应商，DeepSeek）

| 项 | 预留 | 估算 | 实测 |
|---|---|---|---|
| 规划（`agent:1`） | 10,000 µUSD | ≈7,000 | **1,016 µUSD** |
| 子任务 caption（`tool:1`） | 10,000 µUSD | — | **1,107 µUSD** |
| 子任务 post-ideas（`tool:1`） | 10,000 µUSD | — | **1,239 µUSD** |
| **一次两步 run** | 30,000 µUSD | — | **3,362 µUSD ≈ $0.0034** |

缓存命中让规划实际值只有估算的约 1/7。按实测，`MAX_PLAN_STEPS = 6` 的满配 run 约 $0.008，而不是按预留算的最坏 $0.16。**预留不需要调小**——它是上界不是预算目标。

整轮开发真实花费约 **12,600 µUSD ≈ $0.0126**。

---

## 4. 环境前提（踩过的坑，别再踩）

**app 的 `TRIGGER_SECRET_KEY` 必须与 worker 在同一个 Trigger 环境。** `trigger dev` 只服务 **dev** 环境；app 若拿 prod 密钥，run 会派进一个没有 worker 的环境，job 停在 `queued` 一动不动（会被误读成「超时」）。

2026-09-15 已按用户指示把 `.env.local` 换成 **dev 环境**密钥，旧值备份在 `.env.local.pre-dev-key.bak`（两者都被 `.gitignore` 的 `.env.*` 覆盖，未进 Git）。Next dev server 会自行 `Reload env`，不需要重启 `:3000`。

**⚠️ 上线前必做**：prod 环境目前那个部署是 **2026-09-14 之前**的构建，`src/trigger/tool.ts` 的成本结算是 09-14（`b88e022`）才加的——**tool 任务在那个部署里不记账**。不重新 `deploy` 就上线，生产的文本工具花费会全部漏账。这条已写进 `docs/acceptance/agent.md` §3.1。

另：`playwright-core@1.57` 顶层 `require("chromium-bidi/…")` 而该包不在依赖树里，esbuild 静态解析失败会让**所有** Trigger 任务构建不出来。`trigger.config.ts` 里的 `stubChromiumBidi` 扩展把它换成空模块，理由写在该常量注释里。**这是与 agent 无关的既有构建断裂的修复，别顺手删掉。**

---

## 5. 五条已知未修，都写在 `docs/acceptance/agent.md` 里

1. ✅ **已修（2026-09-15）**：`/api/v1/tools/[tool]` 曾用 `admin.from("jobs").upsert()` 绕开 `server_submit_job`，从不写 `cost_reservations` → 从这个入口跑工具必然 `22023 open cost reservation not found`。现在走 `server_submit_job`，预留口径由 `toolReservedMicroUsd()`（`src/server/tools/application.ts`）统一给编排器和这个入口共用。
   修的过程中暴露出下半环：两个工具 worker 都用裸 `update jobs set state='succeeded'` 收尾，从不结算，`usage_accounts.reserved` 只增不减。新增 `public.server_finalize_tool_job`（`20260915002000_tool_job_finalize.sql`，复用 generation 同款 `private.b04_finish_job_with_unknown_cost`），`src/trigger/tool.ts` 与 `src/trigger/visual-tool.ts` 的 succeed / fail / claim 期 `CONTEXT_UNAVAILABLE` 三条路径全部改走它。
   **真实验证**（开发项目 + 真实 DeepSeek 调用 + `trigger dev`）：job `cdb9d002-1df4-4822-b28e-0e2dd46c5549` 成功，额度 `reserved 1→2→1`、`consumed 0→1`。回归测试：`tests/unit/tool-route.test.ts`（16 条）、`tests/cloud/tool-route-live.test.ts`（默认跳过，需 `ORINCARD_RUN_TOOL_CLOUD=1`，一次约 1,100 µUSD）。
   遗留数据瑕疵：修好之前那次验证跑留下的一个单位预留还挂在测试账号 `c28c9a9a…` 上（`reserved=1`），没有手工改账去抹平。
2. **`resource = 'image'` 从不发放**（`grantsForPlan` 只发 `generation`）。`Entitlements` 类型里没有图片额度字段，凭空发明一个等于替 B-1 做没人做过的商业决策。后果：计划里出现 `portrait` / `ai_image` 步骤会 `quota_exceeded` 被闸住（UI 上如实显示为 `blocked`，不是静默失败）。
3. **`BILLING_POLICY_JSON` 带 `testOnly: true`**，production 下 `loadEntitlementPolicy` 会抛 `BILLING_NOT_CONFIGURED`。**这是刻意的**：免费额度的具体数字仍是 B-1 的未决事项。
4. ✅ **已修（2026-09-15）**：`toTextWorkerRequest` 曾把一步的 `input` 压成单个字符串，`count` / `instructions` 静默丢弃（计划写 `count: 3`、worker 回 5 条）。选的是扩 worker 载荷：`TextToolRequest` 增加两个可选字段，`count` 同时进喂给模型的 JSON Schema（`minItems = maxItems = count`）与事后 Zod 校验；`instructions` 只进不可信数据键 `userInstructions`，不并进系统指令字段。两字段皆 optional，旧 `input_ref` 照旧可解析。
   **真实验证**：job `dd8437e8-b70c-4a3b-9ba0-dbc65ca00e10`（`post-ideas` + `count: 3`）成功，供应商回了正好 3 条。细节见 `docs/acceptance/agent.md` §3.5。
5. **步骤之间不传产物**。计划每步的 `input` 自包含，「把第 1 步产出喂给第 2 步」这个通道不存在，也没假装存在。多步计划实际是多个并列的独立调用。

另有一项规划本身的成本口径需要 B-1 拍板：**规划消耗一个 `generation` 额度单位**（`private.submit_job` 要求 `p_units > 0`，没有零额度提交的口子）。免费方案 10 个单位下，一次三步 run 花掉 4 个（1 规划 + 3 执行）。要不要给规划单独开桶，理由写在 `src/app/api/v1/agent/route.ts` 的 `PLAN_USAGE_UNITS` 注释里。

---

## 6. 剩下没做的任务（`tasks.md` 里仍未打勾的 12 项）

- **B13 助手**：T096（原型页）、T097（`/api/v1/copilot`）、T098（编辑器内助手面板）、T099（助手 E2E 验收）
- **发布与运维**：T073（计费生命周期验收）、T084（增长 E2E）、T085（CI / Vercel）、T086（可观测性与保留期）、T087（备份与恢复演练）、T088（许可与安全验收）、T089（发布演练）、T095（全产品 E2E + 发布验收）

其中 **T095 会重算 `tests/contracts/api-coverage.test.ts` 的路由数**——本轮已把它从 49 改到 50（新增 `POST /agent/execute`），改路由数时记得同步 `docs/sdd/orincard/contracts/api.md` 与 `docs/sdd/orincard/tasks.md`，三处任一不同步该测试就红。

`check-planning.mjs` 强制**每个任务 1–5 个源文件路径**。本轮 T100 已经用满 5 条——再给编排器加文件必须开新任务（T102 就是这么来的）。

---

## 7. 本次提交包含什么

一次提交，含上述全部代码、迁移、测试、词条与文档。`.env.local` 及其备份未进 Git。所有排障临时脚本已删除。
