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

### 3.2 `/api/v1/tools/[tool]` 绕开 `server_submit_job`（Step 0 结论，本轮未修）

该路由用 `admin.from("jobs").upsert()` 直接建 job，从不写 `cost_reservations`，因此文本工具从这个入口跑会 `22023 open cost reservation not found`。
**编排器不走这个入口**——`executeAgentPlan` 自己调 `server_submit_job`，所以编排出来的 tool 子任务有正常的额度与成本预留。但用户从 `/tools/[tool]` 页面手动跑同一个工具仍然是坏的。超出本轮范围。

### 3.3 `resource = 'image'` 从不发放

`grantsForPlan` 只发 `generation` 桶。`Entitlements` 类型里没有图片额度字段，凭空发明一个等于替 B-1 做了没人做过的商业决策。
后果：计划里一旦出现 `portrait` / `ai_image` 这类步骤，提交时会 `quota_exceeded` 被闸住。这在 UI 上会如实显示为 `blocked`，不是静默失败——但那一步确实做不了。

### 3.4 `BILLING_POLICY_JSON` 带 `testOnly: true`

`.env.local` 里新写的策略带 `testOnly: true`，在 production 下 `loadEntitlementPolicy` 会抛 `BILLING_NOT_CONFIGURED`。**这是刻意的**：免费额度的具体数字仍是 B-1 的未决事项，不该由这一轮默默定下来。

### 3.5 计划的步骤入参会被静默截断

计划里 `post-ideas` 步骤要 `count: 3`，worker 返回了 5 条。`toTextWorkerRequest` 把一步的 `input` 压成单个字符串（`input.text ?? input.topic`），`count` / `instructions` 被**静默丢弃**。
这是规划与执行之间的契约损耗：计划上写着的东西，执行时不一定算数。要么扩 worker 载荷，要么在规划侧就别产出无效字段。**当前两者都没做。**

### 3.6 步骤之间不传产物

计划每一步的 `input` 是自包含的。「把第 1 步的产出喂给第 2 步」这个通道**不存在**，也没有假装存在。多步计划实际上是多个并列的独立调用。

---

## 4. 一个刻意的设计取舍：被闸住时不回滚

某步过不了额度或环境成本预算闸时，`executeAgentPlan` **保留已提交的步骤**，`break` 出循环，并在响应的 `blocked` 里如实回报停在第几步、什么码。不整体回滚。

理由：已提交的步骤可能已经在烧 token 了，回滚既撤不回花费，又会把用户已经拿到的产出抹掉。让用户看见「前两步成了，第三步额度不够」，比看见「什么都没有」更接近事实。
UI 上这条路径以 `role="alert"` 呈现，已提交的步骤照常列出各自的进度。
