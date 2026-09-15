# 交接：AI 编排器 Step 4（Trigger 任务）

> 上一轮会话做完 Step 0–3，此文档用于新开对话直接接 Step 4。
> 原始需求文档 `docs/handoff/agent-feature-claude.md` 仍然有效，但**其中第 2 节（工作区脏）已过期、第 5.4 节（预算闸门）讲反了**，以本文件为准。

## 0. 硬约束（整场有效，逐条都是用户原话的要求）

- 不操作生产项目，只用开发项目。
- 不要用 Supabase MCP 操作本项目——它指向的不是这个项目的数据库；要查库用 Supabase CLI。
- `.env.local` 可以读，但只在子 shell 里加载（`( set -a; . ./.env.local; set +a; … )`），**绝不打印值**；值不得进入聊天、日志、trace、截图或 Git。
- 花钱默认已批准，但 `AI_MONTHLY_BUDGET_USD=10` 的月度硬顶仍在，**实际花费必须如实上报，超支必须主动说**。
- **不要用 mock 假装某个功能能用。跑不通就说跑不通。**
- 所有命令先 `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`。
- 本机没有 `timeout` 命令，长命令用后台 + 看门狗。
- **把服务器留给用户，不要关**：`:3100`（生产构建）、`:3000`（next dev）、`:8080`（http.server）、9 个 `supabase_*_orincard` 容器。
- 不要跑 `pnpm build`（会覆盖 `:3100` 正在读的 `.next`）；`pnpm lint` 不存在。
- 不要改 `docs/design/reference/`（SHA-256 锁定，`check-planning.mjs` 必须一直报 15 unchanged design files）。
- 不改 `generateStructured` 签名，不去掉 `store:false`；不要把对话历史塞进 Trigger 载荷。
- 不动 `main`；当前分支 `codex/walking-skeleton`，HEAD `5b5c0f8`，上述改动**尚未提交**。
- 路线图只在真的跑通并验证过之后才打 ✅，跑不通打 ❌ 并写一行原因。

## 1. 产品形态（已拍板，不要偏离）

**编排器，不是自主循环。** 用户自然语言描述需求 → 模型**一次**结构化调用产出执行计划 → 前端展示 → 用户确认 → 我们的代码按现有 job 链路逐步执行。

因此：不需要 provider 的 function calling，`generateStructured` 原样可用；一次 run 恒等于一次模型调用，`cost_attempts` 的 sequence 恒为 1，Trigger 重试复用同一行、不撞 23505。

成本：`PLAN_RESERVED_MICRO_USD = 10_000`（$0.01，估算上界 ≈7,000 µUSD），`MAX_PLAN_STEPS = 6`，一次完整 run 最坏 ≈ $0.16。

## 2. 已完成（Step 0–3），全部守卫绿

| Step | 产物 |
|---|---|
| 0 | 确认 `/api/v1/tools/[tool]` 用 `admin.from("jobs").upsert()` 绕开 `server_submit_job`，因此从不写 `cost_reservations`，文本工具跑起来会 `22023 open cost reservation not found`。**本轮不修，超出范围**，需写进验收文档。 |
| 1 | `supabase/migrations/20260915000000_agent_orchestrator.sql`（`agent` 枚举值 + `agent_runs` / `agent_run_steps` + RLS） |
| 1.5 | `supabase/migrations/20260915001000_usage_entitlement_grant.sql` + `src/server/billing/entitlement-grant.ts`：补上**此前全仓库缺失的额度发放**（`usage_accounts` 从来没有任何生产代码路径写过），并接进 generation 路由。已在 dev 库应用并用回滚事务做过对照实验。 |
| 2 | `src/server/agent/planner.ts` / `prompts.ts` / `plan-run.ts` |
| 3 | `src/app/api/v1/agent/route.ts`（GET/POST）+ `src/trigger/dispatch.ts` 注册 `AGENT_TASK_ID = "orincard-agent-plan"` 进 `BY_JOB_KIND` |

**基线守卫（接手前请复跑，应与此一致）**

```
pnpm typecheck        → exit 0
pnpm test             → 47 files / 345 passed / 7 skipped / 0 failed
node scripts/check-planning.mjs
                      → 101 tasks / 14 batches / 49 API paths / 15 unchanged design files
```

## 3. 三条必须继承的设计约定

1. **提交顺序 `ensureEntitlements → submit → createRun → dispatch` 是刻意的**，有测试逐字守着（`tests/unit/agent-route.test.ts:81`）。`agent_runs.job_id` 有外键所以 job 必须先建；需求正文必须在派发前落盘。**正文落盘失败时绝不派发。**
2. **需求正文只进 `agent_runs.request`，不进 `jobs.input_ref`**，沿用 `b04_begin_ai_candidate_job` 的「不携带正文输入」口径。
3. 由 1 推出一个**给 Step 4 的强制要求**：对账兜底重新派发时 run 行仍可能缺失，所以 **Trigger 任务必须把「找不到 run 行」当作一个明确的失败来报，绝不能当成空需求继续跑**。

## 4. 你的任务：Step 4

新建 `src/trigger/agent.ts`，**结构照抄 `src/trigger/tool.ts`**：

- 载荷严格 `{ jobId, schemaVersion, requestId }`（不可变边界）
- `claim` → `registerJobCostAttempt({ operation: "agent", sequence: 1 })` → 读 `agent_runs` 拿需求 → 调规划器 → `finally { settleKeyedJobUsage(…sequence: 1) }`
- **结算放 `finally`：失败也要结算，token 照烧**（`tool.ts:85` 的注释说的就是这个）
- 计划落 `agent_runs`，job `result_ref` 放计划摘要
- 任务 id 用 `dispatch.ts` 已导出的 `AGENT_TASK_ID`，不要另写字面量

单测至少覆盖：claim 失败返回 ignored；模型调用抛错时仍走到 settle；run 行缺失时报明确错误码。

## 5. Step 4 之后

- **Step 5** `src/server/agent/executor.ts`：每步提交为子 job（复用 `jobs.parent_job_id`），记进 `agent_run_steps`；某步被预算闸住时**保留已完成步骤并如实告知**，不整体回滚；用户确认后才执行。
- **Step 6** `src/features/agent/agent-panel.tsx`，进度**复用** `src/features/generation/progress.tsx`；导航加进 `src/components/workspace-shell.tsx` 的数据驱动导航。
- **Step 7** `messages/en.json` + `messages/zh-Hans.json` **两份都加**，漏一边 `tests/ui/shell.test.tsx` 会红。
- **Step 8 / T101** `docs/acceptance/agent.md`：Step 0 结论写最前面，诚实 pass/fail，写清实际花费、`image` 资源未发放的后果、tools 路由仍然坏着。

## 6. 三个已知未修，必须在验收文档里保留

1. `/api/v1/tools/[tool]` 绕开 `server_submit_job`，无成本预留 → 文本工具链路会失败。
2. `resource = 'image'` 从不发放（`Entitlements` 类型里没有对应字段，凭空发明一个等于替 B-1 做了没人做过的商业决策）→ portrait / ai_image 仍会 quota_exceeded。
3. `.env.local` 里新写的 `BILLING_POLICY_JSON` 带 `testOnly: true`，在 production 下 `loadEntitlementPolicy` 会抛 `BILLING_NOT_CONFIGURED`——**这是刻意的**，免费额度数字仍是 B-1 的未决事项。`:3000` 的 dev server 是否已热加载该变量**尚未验证**（没有会话 cookie，探不了鉴权端点）。

## 7. 端到端验证（Step 4 完成后才谈得上）

1. `:3000` 提交一次编排请求，观察 job 走到 `succeeded` 并返回计划
2. 查 `private.cost_attempts` 确认出现 `job:<id>:agent:1` 且 `state='settled'`，实际 µUSD 与 7,000 估算对照
3. 收尾必跑：三端口 200、`docker ps | grep -c orincard` 必须是 9

---

## 8. Step 4 完成记录（2026-09-15）

**产物**

- `src/trigger/agent.ts`：`claim` → `loadRun` → `registerJobCostAttempt(agent, 1)` → `runPlan` → `finally settleKeyedJobUsage(agent, 1)`；计划落 `agent_runs`（`state='ready'`），job `result_ref` 只放摘要（summary / stepCount / tools），任务 id 取自 `dispatch.ts` 的 `AGENT_TASK_ID`。
- `tests/unit/agent-task.test.ts`（11 例）、`tests/cloud/agent-live.test.ts`（真实供应商，默认跳过）。

**三个落地时被现实修正的点**

1. `jobs.stage` 是受检查约束的固定集合（`walking_skeleton.sql:745`），里面**没有 `plan`**。改用既有的 `outline`，不为此另开迁移。
2. **「找不到 run 行」不能走 `claim` 返回 null**——那会被记成 `ignored`，等于静默吞掉。实现成先 claim、再 `loadRun`，缺行时抛 `AgentRunMissingError`，job 与 run 双双落 `AGENT_RUN_MISSING`。读需求刻意排在登记成本尝试**之前**：没有需求就不该占一笔账。
3. 写回顺序是**先 `agent_runs.plan`、后 job `succeeded`**：job 标成功却没有计划可读，比反过来更难收拾。

**守卫（与基线对照）**

```
pnpm typecheck        → exit 0
pnpm test             → 48 files / 356 passed / 7 skipped / 0 failed（+1 文件、+11 例，全是新增）
node scripts/check-planning.mjs
                      → 101 tasks / 14 batches / 49 API paths / 15 unchanged design files（未变）
```

**真实调用验证（花了钱，如实记账）**

三次真实 DeepSeek 结构化调用，合计约 **7,200 µUSD ≈ $0.0072**（单次实测 2,386 µUSD，远低于 7,000 的估算和 10,000 的预留 → `PLAN_RESERVED_MICRO_USD` 留得住）。产出：`caption` + `post-ideas` 两步，schema 一次过。

中间一次返回**零步 + clarification**：需求写成「给**这篇**关于小步发布的内容写文案」而素材不在载荷里，模型正确地要素材。这是合法产出（`parseAgentPlan` 允许零步 + clarification），是测试断言写死了，已改成两个分支都认。**这条要写进 `docs/acceptance/agent.md`：编排器面对引用了不存在素材的需求会要澄清，不会硬编。**

**仍未验证 ❌（不是「跑通了」）**

- **§7 的端到端一次都没跑**。两个卡点，都不是代码问题：本机**没有 `trigger dev` worker 在跑**（派发出去没人消费）；`:3000` 无会话 cookie，鉴权端点探不了。
- 因此 `private.cost_attempts` 里**没有** `job:<id>:agent:1` 这一行——上面那笔花费是直接调 `runPlan` 产生的，没有走 job 链路，也就没经过登记/结算的 SQL 入口。register/settle 路径目前**只有单测覆盖**（stub 掉 rpc）。
- `agent_runs` / `agent_run_steps` 表和 `job_kind` 的 `agent` 枚举值已确认存在于 dev 库。

**收尾状态**：`:3100` / `:3000` / `:8080` 均 200，`docker ps | grep -c orincard` = 9，全部留给用户；改动仍未提交，分支 `codex/walking-skeleton`。

---

## 9. 端到端尝试记录（2026-09-15，仍 ❌）

**做成了的部分**

- 两条 agent 迁移已经用户批准后 `supabase db push --linked` 推到 **dev 项目**（`ettuzeunkadkfnawawdy` == `SUPABASE_PROJECT_REF`，非生产）。
- 本机 `trigger dev` worker 能构建并就绪（`Local worker ready on branch: default [node-22]`）。为此修了一处**与 agent 无关的既有构建断裂**：`playwright-core@1.57` 顶层 `require("chromium-bidi/…")` 而该包不在依赖树里，esbuild 静态解析失败导致**所有**任务都构建不出来。用 `trigger.config.ts` 里的 `stubChromiumBidi` 扩展把它换成空模块（理由写在该常量的注释里）。
- 新增 `tests/e2e/agent.spec.ts`（T101）：UI 登录 → `POST /api/v1/agent` → 轮询 → 查 `server_sample_cost_attempts` 对账。
- 真实提交跑通了**路由这一段**：job `c0a29e0d-…` 由真实请求创建，`pending_dispatch` → `queued`，`agent_runs` 落 `state='planning'` 且需求正文在库里。

**卡在哪（根因，不是超时）**

`.env.local` 的 `TRIGGER_SECRET_KEY` 属于 Trigger 的 **prod 环境**，而 `trigger dev` 只服务 **dev 环境**。于是 `:3000` 派发出去的 run 落进一个没有任何 worker 的环境，job 停在 `queued` 不动；`private.cost_attempts` 里依旧**没有** `job:<id>:agent:1`。

顺带修掉一个用例自身的缺陷：轮询写了 180 秒，而 Playwright 默认用例超时 30 秒，先到的永远是用例超时，会把「任务没被消费」这个真结论盖成「超时」。已加 `test.setTimeout(300_000)`。

**要跑通，必须二选一（需要用户决定，两条都涉及凭据或部署）**

1. 给本地 app 一个 **dev 环境**的 `TRIGGER_SECRET_KEY`（Trigger 控制台 → 该项目 dev 环境），写进 `.env.local` 并重启 `:3000`。最贴合 §7，改动最小。
2. 把 worker `deploy` 到 prod 环境，让现有 prod 密钥的派发有消费者。更重，且动的是公开站那侧。

> 试过第三条路——用 CLI 已登录的 PAT 换 dev 环境密钥、只在排障进程内存里用——被权限分类器按「凭据探取」拦下，没有绕行。

**结果：§7 的 1、2 已真实跑通 ✅**（用户授权后走的第 3 条路：用 CLI 登录态换 dev 环境密钥，只在排障进程内存里用，把路由已创建的那个 job 从 dev 环境触发给本地 worker）。

job `c0a29e0d-…`：`queued` → `running/outline` → **`succeeded`**，`result_ref` 只带摘要（`caption` + `post-ideas`，stepCount 2），`agent_runs.state='ready'` 且 `plan` 两步齐全、输入是模型自己从需求里摘出来的正文。

`private.cost_attempts` 出现 **`job:c0a29e0d-…:agent:1`，`state='settled'`，`actual_micro_usd = 1058`**（usage：input 1,599 / cached 1,536 / output 496）。对照：估算 7,000、预留 10,000 —— 缓存命中让实际值只有估算的 1/7，`PLAN_RESERVED_MICRO_USD` 宽裕得很。register/settle 的 SQL 入口至此**不再只有单测覆盖**。

**唯一仍走了旁路的一跳**：派发。路由（`:3000`，prod 密钥）派进的环境没有 worker，是我从 dev 环境补触发的。因此 `tests/e2e/agent.spec.ts` 作为**全自动**用例仍跑不通——要它绿，app 必须拿 dev 环境的 `TRIGGER_SECRET_KEY`（已写进该文件顶部注释）。任务本身、成本入口、DB 写回全部已被真实链路验证过。

**花费**：这次真实 job 调用 1,058 µUSD；本轮累计约 **8,300 µUSD ≈ $0.0083**，`AI_MONTHLY_BUDGET_USD=10` 远未触顶。

## 10. Step 5 完成记录（2026-09-15）

**做了什么**

- `src/server/agent/executor.ts`：`executeAgentPlan` 把计划的每一步作为**子任务**提交（`jobs.parent_job_id` 指向规划 job），逐步写 `agent_run_steps`，逐步派发。三条取舍写在文件注释里：
  1. **不整体回滚**。某步被额度/预算闸住时，已提交的步骤保留，`break` 出循环并在 `blocked` 里如实回报停在哪一步、什么码。
  2. **步骤之间不传产物**。计划里每步的 `input` 是自包含的，当前没有这个通道，不假装有。
  3. `parent_job_id` 在 submit 之后单独写——`private.submit_job` 根本没有 `p_parent_job_id` 参数；权威映射以 `agent_run_steps` 为准。
- `stepBlockCode` 把 SQL 错误码翻成接口码：`22003` 按 message 区分 `BUDGET_EXCEEDED` / `QUOTA_EXCEEDED`，`42501` → `NOT_FOUND`，`23505` → `IDEMPOTENCY_CONFLICT`，其余 `STEP_SUBMIT_FAILED`。
- `src/app/api/v1/agent/execute/route.ts`：202 返回 `runId/state/steps/blocked`；执行必须是用户确认后的**另一次显式请求**，规划成功不会自动续跑。
- 幂等键 `agent:<runId>:<stepIndex>`，所以重复点执行按步续跑，不会产生第二批子任务。
- `tests/unit/agent-executor.test.ts` 12 条；`docs/sdd/orincard/contracts/api.md` 补了 `POST /agent/execute` 一行；`tasks.md` 新增 **T102**（T100 已有 4 条路径，再加会撞 check-planning 的 1–5 上限）；`tests/contracts/api-coverage.test.ts` 路由数 49 → 50。

**真实链路验证（不是单测）**

对真实数据库跑了一次「确认 → 执行」：202，两个子任务都提交成功——
`85398712-…`（caption）、`32801615-…`（post-ideas），`kind='tool'`、`parent_job_id` 指向 `c0a29e0d-…`、`agent_run_steps` 两行齐全。
**再点一次**返回同样的 jobId 且 `submitted:false`——按步幂等在真实链路上成立。

**一个查清楚的账目异常（不是本分支的缺陷）**

两个子任务都 `succeeded` 且内容真实，但 `private.cost_attempts` 里**没有** `job:<id>:tool:1`。查下来：

- 它们的 `provider_run_id` 来自路由派发（prod 环境），`finished_at` 12:48:18Z / 12:48:29Z，**早于**我从 dev 环境补触发的时间——即已被 prod 环境里的一个 worker 消费完成。
- `src/trigger/tool.ts` 的成本结算是 **2026-09-14（b88e022）** 才加进去的。prod 那个部署跑的是更早的构建，自然不记账。同一张表里 09-10 那批 tool 任务也全无成本行，时间线对得上。
- 同一份代码直接交给**本地 dev worker** 跑一个 tool 任务：`job:422bb3bb-…:tool:1` `state='settled'`、`actual_micro_usd = 879`（input 228 / cached 128 / output 409）。**代码这条路是通的**，缺的是环境。

结论：这是 §9 那同一个根因（app 的 `TRIGGER_SECRET_KEY` 指向 prod）的第二个症状——不但规划任务没人消费，子任务还会被 prod 的旧部署消费掉、绕过成本记账。修法仍是 §9 的二选一。**在修好之前，经 `:3000` 派发的 tool 子任务的花费是不入账的**，验收文档里要留这一条。

**一个保真度缺陷（新发现，归入「已知未修」）**

计划里 `post-ideas` 步骤要 `count: 3`，worker 返回了 5 条。`toTextWorkerRequest` 把一步的 `input` 压成单个字符串（`input.text ?? input.topic`），`count` / `instructions` 被**静默丢弃**。属于规划与执行之间的契约损耗，要么扩 worker 载荷，要么在规划侧就别产出无效字段。

**花费**：本节新增一次 tool 调用 879 µUSD；本轮累计约 **9,200 µUSD ≈ $0.0092**，`AI_MONTHLY_BUDGET_USD=10` 远未触顶。

## 11. Step 6 / Step 7 完成记录（2026-09-15）

- `src/features/agent/agent-panel.tsx`：一句需求 → 轮询规划任务 → **展示计划**（摘要 / 逐步 tool + rationale / 零步时展示 clarification）→ 「确认并执行 N 步」按钮 → 列出各子任务进度。执行始终是**用户的另一次显式动作**，计划就绪不会自动续跑；某步被闸住时 `blocked` 以 `role="alert"` 如实显示第几步、什么码，**已提交的步骤照常列出**。
- 进度确实是**复用** `src/features/generation/progress.tsx`：给 `loadGenerationProgress` / `GenerationProgress` 加了可选的 `kind`（默认 `"generation"`，既有调用点不用改）。它是**断言不是过滤器**——传 `agent` / `tool` 拿回别的类会报错，放宽成不检查会让串了 id 的 bug 悄悄渲染成正常进度。
- `src/app/[locale]/agent/page.tsx` 挂进 `WorkspaceShell`；导航加了 `agent` 段，放在 `tools` 旁边（它做的事就是替你挑工具、排顺序）。`tests/ui/shell.test.tsx` 的「只能链到真实存在的路由」白名单同步加了 `/agent`。
- 词条 `messages/en.json` + `messages/zh-Hans.json` **两份都加**了 `AgentPanel` 命名空间与 `Nav.agent`。`tests/ui/agent-panel.test.tsx` 用真实词条文件渲染，并断言两份的 key 集合相等——漏翻一边直接红。
- 守卫：typecheck 0；`pnpm test` **50 文件 / 371 passed | 7 skipped**；`check-planning.mjs` PASS（102 tasks / 50 API paths / 15 unchanged design files）。T100 的路径列表补了 `src/app/[locale]/agent/page.tsx`（正好第 5 条，触到 1–5 上限）。
- 真实 dev server 验证：`http://localhost:3000/agent` 与 `/zh-Hans/agent` 都 200，中文页渲染出「说清你想要什么 / 生成计划」。**面板到端到端的那一跳（在浏览器里点完整跑通）尚未做**——仍受 §9 的 Trigger 环境问题限制，见 Step 8 验收文档。

## 12. Step 8 与环境修复（2026-09-15，T101 ✅）

按用户指示把 `.env.local` 的 `TRIGGER_SECRET_KEY` 换成 **dev 环境**密钥（用 CLI 登录态取，值未打印、未进日志；旧值备份在 `.env.local.pre-dev-key.bak`，两者都被 `.gitignore` 的 `.env.*` 覆盖）。Next dev server 自行 `Reload env: .env.local`，**没有重启 `:3000`**。

`pnpm exec playwright test tests/e2e/agent.spec.ts` → **`1 passed (52.7s)`**。§9/§10 里那个「派发走旁路」的注脚就此作废——整条链路现在是真的端到端：

- 规划 job `640fe31c-…`：`job:640fe31c-…:agent:1` settled **1,016 µUSD**，计划两步（caption + post-ideas）。
- 确认后执行：两个子任务 `300d77e8-…` / `3c6c53b9-…` 都被本地 worker 消费并 `succeeded`，各自 `tool:1` settled **1,107 / 1,239 µUSD**。一次两步 run 实测合计 **3,362 µUSD ≈ $0.0034**。
- 重复调用执行接口仍返回同样 jobId 且 `submitted:false`。

`docs/acceptance/agent.md` 状态改为 **PASS**，T100 / T101 / T102 全部打 ✅。

**留给部署的前提（新增，写进了验收文档 §3.1）**：这条链路要求 app 与 worker 在同一个 Trigger 环境。prod 环境目前那个部署是 09-14 之前的构建，**tool 任务在它那里不记账**——上线前必须重新 `deploy`，否则生产的文本工具花费全部漏账。

**花费**：本轮累计约 **12,600 µUSD ≈ $0.0126**，月度硬顶 $10 远未触顶。
