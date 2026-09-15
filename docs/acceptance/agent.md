# AI 编排器验收记录（T100 / T101 / T102）

状态：**`PASS` — 「描述需求 → 看计划 → 确认 → 执行」全链路在真实环境跑通，规划与每个子任务的成本各自结算并对上账。`tests/e2e/agent.spec.ts` 全自动通过（1 passed, 52.7s）**

记录日期：2026-09-15。全部在**开发** Supabase 项目（`ettuzeunkadkfnawawdy`）与真实供应商（DeepSeek）上执行，未触碰生产项目。

---

## 0. 先说结论：这是编排器，不是自主循环

一次请求 = **恰好一次**结构化模型调用 → 一份可审的计划 → 用户确认 → 我们的代码按现有 job 链路逐步执行。
因此 `private.cost_attempts` 里规划的 `sequence` 恒为 1，Trigger 重试复用同一行、不会撞 23505。

计划**只展示，不自动执行**。执行是 `POST /api/v1/agent/execute` 这一次独立的、用户发起的请求。

---

## 1. 真实证据

| 检查 | 预期证据 | 结果 |
|---|---|---|
| 提交需求 | `POST /api/v1/agent` 202，job 落 `pending_dispatch`，正文只在 `agent_runs.request` | **通过** |
| 规划任务执行 | job `queued → running/outline → succeeded`，`agent_runs.state='ready'` 且计划两步齐全 | **通过**（job `c0a29e0d-…`） |
| 计划不夹带正文 | `jobs.result_ref` 只有摘要（`caption` + `post-ideas`，stepCount 2） | **通过** |
| 规划成本对账 | `job:c0a29e0d-…:agent:1` `state='settled'` | **通过**，`actual_micro_usd = 1058` |
| 按步提交为子任务 | 两个子 job `kind='tool'`、`parent_job_id` 指向规划 job、`agent_run_steps` 两行 | **通过** |
| 按步幂等 | 重复调用返回同样的 jobId 且 `submitted:false`，不产生第二批子任务 | **通过** |
| 子任务真实消费与记账 | 两个子任务 `succeeded`，各自 `job:<toolJobId>:tool:1` settled | **通过**，1,107 / 1,239 µUSD |
| 全自动 E2E | `pnpm exec playwright test tests/e2e/agent.spec.ts` 绿 | **通过**，`1 passed (52.7s)` |
| 面板端到端（浏览器里点完） | `/agent` 手工走完整条链路 | **未执行**——E2E 走的是同样的 HTTP 接口，面板本身只有 SSR 单测覆盖 |

### 成本实测 vs 估算

| 项 | 预留 | 估算 | 实测 |
|---|---|---|---|
| 规划（`agent:1`） | 10,000 µUSD | ≈7,000 µUSD | **1,016 µUSD**（首次单独验证为 1,058） |
| 子任务 caption（`tool:1`） | 10,000 µUSD | — | **1,107 µUSD** |
| 子任务 post-ideas（`tool:1`） | 10,000 µUSD | — | **1,239 µUSD** |
| **一次两步 run 合计** | 30,000 µUSD | — | **3,362 µUSD ≈ $0.0034** |

缓存命中让规划的实际值只有估算的约 1/7，`PLAN_RESERVED_MICRO_USD` 宽裕得很。按实测，`MAX_PLAN_STEPS = 6` 的一次满配 run 大约 $0.008，而不是设计时按预留算的最坏 $0.16。

本轮真实供应商花费合计约 **12,600 µUSD ≈ $0.0126**，`AI_MONTHLY_BUDGET_USD=10` 的月度硬顶远未触顶。

---

## 2. 怎么复跑

```sh
pnpm typecheck                 # exit 0
pnpm test                      # 50 files / 371 passed | 7 skipped
node scripts/check-planning.mjs  # 102 tasks / 50 API paths / 15 unchanged design files
pnpm exec playwright test tests/e2e/agent.spec.ts   # 1 passed (52.7s)
```

E2E 需要一个在跑的 `trigger dev` worker，且**被测 app 的 `TRIGGER_SECRET_KEY` 必须与 worker 在同一个 Trigger 环境**（见 §3.1）。

---

## 3. 环境前提与仍然跑不通的部分（不粉饰）

### 3.1 已解决：app 的 Trigger 密钥必须与 worker 同环境

曾经的阻塞：`.env.local` 的 `TRIGGER_SECRET_KEY` 属于 Trigger 的 **prod** 环境，而 `trigger dev` 只服务 **dev** 环境。两个症状——

1. **规划任务没人消费**：`:3000` 派发出去的 run 落进没有本地 worker 的环境，job 停在 `queued` 不动。
2. **子任务被 prod 的旧部署消费，绕过成本记账**：两个 tool 子任务 `succeeded` 且内容真实，但 `private.cost_attempts` 里没有 `job:<id>:tool:1`。查证：它们的 `provider_run_id` 来自路由派发、`finished_at` 早于本地触发；而 `src/trigger/tool.ts` 的成本结算是 **2026-09-14（b88e022）** 才加的，prod 那个部署跑的是更早的构建。同表里 09-10 那批 tool 任务也全无成本行，时间线吻合。

**2026-09-15 已按用户指示换成 dev 环境密钥**（旧值备份在 `.env.local.pre-dev-key.bak`，两者都被 `.gitignore` 的 `.env.*` 覆盖；Next dev server 自行 `Reload env`，无需重启）。换完后重跑，规划与两个子任务全部由本地 worker 消费，`tool:1` 成本行正常落库（1,107 / 1,239 µUSD）。

**留给部署的前提**：这条链路要求 app 与 worker 在同一个 Trigger 环境。prod 环境目前那个部署是 09-14 之前的构建，**tool 任务在它那里不记账**——上线前必须重新 `deploy`，否则生产的文本工具花费会全部漏账。

### 3.2 `/api/v1/tools/[tool]` 绕开 `server_submit_job`（✅ 2026-09-15 已修）

该路由曾用 `admin.from("jobs").upsert()` 直接建 job，从不写 `cost_reservations`，因此工具从这个入口跑必然 `22023 open cost reservation not found`。现已改走 `server_submit_job`，预留金额由 `toolReservedMicroUsd()`（`src/server/tools/application.ts`）统一，编排器与这个入口共用一份口径。

修的过程中暴露出下半环：两个工具 worker 都用裸 `update jobs set state='succeeded'` 收尾，从不结算，`usage_accounts.reserved` 只增不减（旧代码没预留所以看不出来，修好提交侧才变成真漏）。新增 `public.server_finalize_tool_job`（`20260915002000_tool_job_finalize.sql`，复用 generation 同款 `private.b04_finish_job_with_unknown_cost`），`src/trigger/tool.ts`、`src/trigger/visual-tool.ts` 的 succeed / fail / claim 期 `CONTEXT_UNAVAILABLE` 三条路径全部改走它。

**真实验证**：开发项目 + 真实 DeepSeek 调用 + `trigger dev`，job `cdb9d002-1df4-4822-b28e-0e2dd46c5549` 成功，额度 `reserved 1→2→1`、`consumed 0→1`。回归：`tests/unit/tool-route.test.ts`（16 条）、`tests/cloud/tool-route-live.test.ts`（需 `ORINCARD_RUN_TOOL_CLOUD=1`，一次约 1,100 µUSD）。

**补正（同日）**：上面那版 `server_finalize_tool_job` 无条件走 `b04_finish_job_with_unknown_cost`，于是每跑一次工具就多一条 `unknown` 成本预留永久占着当月额度——正是 S6（`20260912030000_reservation_settlement_close.sql`）为访客路径量过并堵上的那个坑（18 条 / $1.223 / 告警永远红）。工具 worker 其实**有**实测数字：`settleKeyedJobUsage` 在 `generate` 的 `finally` 里跑，**先于** succeed/fail，收尾那一刻尝试行已是 `settled`。

`20260915003000_tool_job_precise_settlement.sql` 新增 `private.finalize_job_reservation(p_job_id)`（`finalize_guest_reservation` 的 job 孪生体，审计条件逐条一致），`server_finalize_tool_job` 改为**先精确结算、再调 b04**——b04 的成本段只动 `state='open'` 的预留，结算完它在成本侧自动成为 no-op，用量与 jobs 终态仍由它一手完成，不复制逻辑。审计不过时不结算，兜底分支原样保留。

**真实验证**：job `869e4484-0248-4802-a079-0ecd40d34cd5` 成功，`reserved 1→2→1`、`consumed 3→4`，且 `server_count_unsettled_reservations` **11 → 11**（修之前必然 11 → 12）。这条断言已加进 `tests/cloud/tool-route-live.test.ts`。

两个如实说明的边界：
- **视觉工具仍走兜底**。`src/trigger/visual-tool.ts` 从不登记 `cost_attempts`，一条尝试都没有时分不清「没花钱」和「花了没登记」，`finalize_job_reservation` 按访客版同样的理由返回 null。它的行为与本次改动前一致，没有变坏，但也没变好。
- **只改了工具这一条链路**。`server_finalize_generation_job`、`server_complete_rewrite_proposal`、`server_complete_regeneration_candidate` 有同样的无条件兜底缺口，是先于本轮的系统性问题；一起改会把爆炸半径扩到本轮没验证过的三条链路上，留给它们各自的验收。存量的 11 条陈旧预留也没有动——核销要走 `server_write_off_stale_reservation`，那是一次显式的花钱决定。

### 3.3 `resource = 'image'` 从不发放

`grantsForPlan` 只发 `generation` 桶。`Entitlements` 类型里没有图片额度字段，凭空发明一个等于替 B-1 做了没人做过的商业决策。
后果：计划里一旦出现 `portrait` / `ai_image` 这类步骤，提交时会 `quota_exceeded` 被闸住。这在 UI 上会如实显示为 `blocked`，不是静默失败——但那一步确实做不了。

### 3.4 `BILLING_POLICY_JSON` 带 `testOnly: true`

`.env.local` 里新写的策略带 `testOnly: true`，在 production 下 `loadEntitlementPolicy` 会抛 `BILLING_NOT_CONFIGURED`。**这是刻意的**：免费额度的具体数字仍是 B-1 的未决事项，不该由这一轮默默定下来。

### 3.5 计划的步骤入参会被静默截断（✅ 2026-09-15 已修）

计划里 `post-ideas` 步骤要 `count: 3`，worker 返回了 5 条：`toTextWorkerRequest` 把一步的 `input` 压成单个字符串（`input.text ?? input.topic`），`count` / `instructions` 被静默丢弃。这两个字段 `inputSchemas` 是收的，`buildToolCatalog` 还把它们广告给了规划模型——契约损耗出在载荷这一层。

选的是**扩 worker 载荷**（另一条路是规划侧别产出，但那等于把模型已经会用的表达力砍掉）：`TextToolRequest` 增加 `count` / `instructions` 两个可选字段，`count` 同时收进喂给模型的 JSON Schema（`minItems = maxItems = count`）和事后 Zod 校验——只约束前者等于信供应商守约。两个字段都是 optional 而非 default，这次改动之前入库的 `input_ref` 照旧可解析，不带 `count` 时沿用 3–10 老区间。

`instructions` 只进不可信的 `input` 数据键（`userInstructions`），**不并进** `generateStructured` 的 `instructions` 系统字段：用户写的加工要求是素材，不是能改写角色设定的指令。有一条测试专门守这个边界。

同一处修好，`/tools/[tool]` 页面与编排器两个入口同时生效。

**真实验证**：开发项目跑 `post-ideas` + `count: 3`，job `dd8437e8-b70c-4a3b-9ba0-dbc65ca00e10` 成功，供应商回了正好 3 条。回归：`tests/unit/tool-application.test.ts` 2 条、`tests/cloud/text-tools.test.ts` 3 条，以及 `tests/cloud/tool-route-live.test.ts` 里那条默认跳过的真跑（单测只能证明约束进了 JSON Schema，证明不了供应商照它出数）。

### 3.6 步骤之间不传产物

计划每一步的 `input` 是自包含的。「把第 1 步的产出喂给第 2 步」这个通道**不存在**，也没有假装存在。多步计划实际上是多个并列的独立调用。

---

## 4. 一个刻意的设计取舍：被闸住时不回滚

某步过不了额度或环境成本预算闸时，`executeAgentPlan` **保留已提交的步骤**，`break` 出循环，并在响应的 `blocked` 里如实回报停在第几步、什么码。不整体回滚。

理由：已提交的步骤可能已经在烧 token 了，回滚既撤不回花费，又会把用户已经拿到的产出抹掉。让用户看见「前两步成了，第三步额度不够」，比看见「什么都没有」更接近事实。
UI 上这条路径以 `role="alert"` 呈现，已提交的步骤照常列出各自的进度。
