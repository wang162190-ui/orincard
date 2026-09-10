# T094 真实成本与内存边界

## 已实现行为

`tests/cloud/performance.test.ts` 在 `ORINCARD_RUN_PERFORMANCE_CLOUD=1` 时执行，读数只来自两个真实来源，没有任何 mock 顶替，也不把固定常量或 mock 时延当实测：

1. **Trigger.dev 上真跑一次** `orincard-foundation-render-probe`（`src/trigger/probe.ts`）。它在云端 Chromium 里真实渲染，回报 `metrics.elapsedMs`、`metrics.rssBytes`、`metrics.pngBytes` / `pdfBytes` / `pptxBytes` 与三个 sha256；Trigger 自己另外回报该次运行的 `durationMs`、`costInCents`、`baseCostInCents`。
2. **开发 Supabase 上真实的用量登记路径**：`public.jobs`、`public.usage_ledger`，以及 `private.cost_reservations`、`private.cost_attempts`、`private.cost_budgets`（service_role 经 `client.schema("private")` 读取，与 `src/trigger/retention.ts` 的既有做法一致）。

| 用例 | 断言的已实现行为 |
|---|---|
| 渲染秒数、内存峰值、成品字节 | 先用 sha256 与 PNG/PDF 文件头证明这三个成品是真产物、`metrics.*Bytes` 与实际字节数逐一相等，再谈由它们得到的数字；渲染耗时为正且小于探针自己声明的 `maxDuration: 120`；进程峰值 RSS 为正且小于部署侧真实机器内存 |
| Trigger 自己的计时与计费 | 运行 ID 非空、`durationMs` 为正、`costInCents` 与 `baseCostInCents` 是非负有限数；进程内计时不超过 Trigger 计的整段机器时间（留 5 秒计时边界容差） |
| 每类任务的样本分钟数 | 从 `public.jobs` 取最近 200 条终态任务，逐条按 `finished_at - created_at` 算真实墙钟耗时并按 `kind` 分组；状态必须落在 `succeeded` / `partial` / `failed` / `canceled` 四个终态里 |
| 计费单位 | 单位只从只追加的 `public.usage_ledger` 取（最近 500 行）：每行 `units` 为正、`kind` 落在枚举内；采样窗口里必须既有 `reserve`，也有 `settle` 或 `release`，即预留最终真的被结算或释放 |
| 环境预算持有的成本估值 | `private.cost_reservations` 逐行满足 `released ≤ reserved`、状态落在枚举内，且至少有一条非零预留；当月 `development` 的 `private.cost_budgets` 行必须存在（不存在则本月任何任务提交都会被 `private.submit_job` 直接拒绝），`limit > 0` 且 `reserved + spent ≤ limit` |
| 样本 token 数 | 从 `private.cost_attempts` 取最近 500 次供应商调用，要求至少一次 `state = 'settled'`，且其 `usage` 里带真实数字的 token / 分钟 / 秒数，`actual_micro_usd` 非空非负 |
| 导出流量 | 从 `public.assets` 取 `exports` 桶里 `ready` 的对象，逐条 `bytes > 0`、`mime` 非空，累加得到真实出站流量与单次导出均值；探针的三个成品字节数作为同一渲染器的下界样本 |

### 内存上限不猜

`trigger.config.ts` 没有 pin `machine`，机器规格由部署侧决定。所以内存边界不在代码里写一个"大概 1 GB"的常量，而是要求把该任务真实的机器内存字节数经 `ORINCARD_TRIGGER_MACHINE_MEMORY_BYTES` 传进来（从 Trigger 控制台读该已部署任务的 machine preset）。缺这个变量时用例点名抛错，不会拿猜测值当边界。

### 修正预算估计需要的一条真实链路目前是断的

`private.cost_attempts.usage` 是模型里存 token / 分钟 / 秒数的位置，`private.settle_cost_attempt` 是写它的函数（并允许实际成本高于预估）。但仓库里没有任何生产路径调用它：

- `public.server_finalize_generation_job` 走 `private.b04_finish_job_with_unknown_cost`，把预留置为 `unknown`、把尝试置为 `unknown`，保守保留占用而不写真实成本；
- `src/server/ai.ts` 的 DeepSeek 适配器只取 `output_text`，连 `usage` 字段都没有出现在它的客户端类型里，供应商返回的 token 数直接丢弃。

因此「样本 token 数」这条用例在当前代码上会失败。**这条失败就是 T094 要报的真实结论**：现在唯一有数字的成本口径是预留估值（`reserved_micro_usd`），不是实测用量；在 `settle_cost_attempt` 被真实接进生成与解析路径之前，预算估计只能被预留值修正，不能被实测 token 修正。不允许为了让它变绿而塞入估算数字。

### 前置条件与失败方式

打开开关但缺变量时，`readCredentials()` 抛错并点名全部缺失变量，不 skip 后当作通过。需要的变量：`NEXT_PUBLIC_SUPABASE_URL`、`SUPABASE_SECRET_KEY`、`TRIGGER_SECRET_KEY`、`TRIGGER_PROJECT_ID`、`ORINCARD_TRIGGER_MACHINE_MEMORY_BYTES`，以及渲染探针要求的 `RUN_CLOUD_PROBES=1`。测试进程不读取任何 `.env` 文件，变量需在自己的终端里配置。

开发项目没有终态任务、没有额度流水、没有成本预留、没有 ready 导出对象时，对应用例显式抛错说明缺哪一类真实样本，并指出先跑哪一项验收去产生它；探针运行失败时同样抛错，T094 宁可报不出数字，也不报估算数字。用例全程只读数据库，唯一的写入是那一次真实的渲染探针运行。

## 验收命令

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
# 门禁（不触云端；pnpm test 按配置排除 tests/cloud/**）
pnpm typecheck
pnpm test

# 关着开关收集，确认 7 条用例挂上且不触云端
pnpm exec vitest run tests/cloud/performance.test.ts

# 真实云端测量（开发项目，串行执行；会在 Trigger 上真跑一次渲染探针）
ORINCARD_RUN_PERFORMANCE_CLOUD=1 RUN_CLOUD_PROBES=1 \
  ORINCARD_TRIGGER_MACHINE_MEMORY_BYTES=<该任务 machine preset 的真实内存字节数> \
  pnpm exec vitest run tests/cloud/performance.test.ts
```

## 验收结论（协调线，2026-09-11）— Blocked

```
ORINCARD_RUN_PERFORMANCE_CLOUD=1 RUN_CLOUD_PROBES=1 \
  ORINCARD_TRIGGER_MACHINE_MEMORY_BYTES=536870912 \
  pnpm exec vitest run tests/cloud/performance.test.ts
Tests  2 failed | 5 passed (7)   17.68s
```

### 机器规格是实测反推的，不是猜的

`trigger.config.ts` 与 `src/trigger/probe.ts` 都没有 pin `machine`，所以部署跑的是 Trigger 的默认 preset。Trigger 的 REST API 不回报 machine 字段，于是改用它自己的计费数据反推：

| 运行 | `costInCents` | `durationMs` | 折算 |
|---|---|---|---|
| `orincard-foundation-render-probe` | 0.0074925 | 2220 | $0.00003375/s |
| `orincard-reconcile-jobs` | 0.003256875 | 965 | $0.00003375/s |

两次独立运行折算出同一个费率，且与官方 small-1x 的 $0.0000338/s 一致 → 部署机器为 **small-1x（0.5 vCPU / 0.5 GB）**，内存上限 536,870,912 字节。`costInCents` 不含 `baseCostInCents`（每次调用 0.0025 cents），两次数据均印证。

### 真实测得的数字

探针运行 `run_06g8ovk2tsi5lkijqm1jnigo01`，部署版本 `20260910.3`：

| 指标 | 实测值 |
|---|---|
| 渲染耗时（进程内计时） | 2,094 ms |
| Trigger 计的整段机器时间 | 2,220 ms |
| 进程峰值 RSS | 140,996,608 B ≈ 134.5 MiB |
| 相对 0.5 GB 机器上限 | **26.3%**，余量充裕 |
| PNG / PDF / PPTX 字节 | 14,981 / 18,168 / 45,836 B（合计 78,985 B） |
| 单次运行成本 | 0.0074925 + 0.0025 = **0.0099925 cents ≈ $0.0001** |

三个成品的 sha256 与 PNG/PDF 文件头均已校验，`metrics.*Bytes` 与实际字节数逐一相等——这些是真产物的字节，不是估算。

另有 3 条用例真实读通并通过：`public.jobs` 的终态任务墙钟耗时按 `kind` 分组、`public.usage_ledger` 的计费单位（采样窗口内 `reserve` 与 `settle`/`release` 账目对得上）、`exports` 桶里 `ready` 对象的真实出站字节。

### 阻断 1 — 缺陷：`private` schema 走 Data API 永远失败（生产缺陷）

`supabase/config.toml` 的 Data API 只暴露 `["public", "graphql_public"]`，且每张 `private.*` 表都 `revoke all ... from public, anon, authenticated, service_role`。仓库里所有生产路径都遵循同一范式：经 `public.server_*` 的 `security definer` 函数访问，仅 `grant execute ... to service_role`。

但 [`src/trigger/retention.ts:58`](../../src/trigger/retention.ts) 例外——它直接用 PostgREST 读私有表：

```ts
client.schema("private").from("cost_reservations").select("id", { count: "exact", head: true })
```

这条调用**永远**返回 `PGRST106 Invalid schema: private`，因而 `reconciliationHealth()` 必抛错，`runRetentionMaintenance` 必失败。Trigger 上的证据：`orincard-retention-maintenance` 是每小时定时任务，最近 2 次运行（2026-09-10 16:17 与 17:17）**2/2 全部 FAILED**。也就是说**过期清理与对账巡检目前从未成功执行过一次**。

`performance.test.ts` 的两条成本用例照抄了这个写法（本文件上一节也据此写着"与 `src/trigger/retention.ts` 的既有做法一致"——那句话的前提是错的），因此同样栽在 `PGRST106`，读不到 `private.cost_reservations` / `cost_budgets` / `cost_attempts`。

**本轮不修，如实记为 Blocked。** 修复方向：新增 `public.server_*` 只读 `security definer` 函数（仅 grant `service_role`），`retention.ts` 改调 `rpc`。**不得改为暴露 `private` schema**——那会削弱既有的安全边界。

### 阻断 2 — 真实结论：实测用量链路是断的（设计内失败）

上一节已预先写明，实测确认：`private.cost_attempts` 里没有任何 `state = 'settled'` 的样本，因为没有任何生产路径调用 `private.settle_cost_attempt`。`public.server_finalize_generation_job` 走的是 `private.b04_finish_job_with_unknown_cost`（把尝试标成 `unknown`），而 `src/server/ai.ts` 的 DeepSeek 适配器只取 `output_text`，供应商返回的 `usage` 直接丢弃。

**因此当前唯一有数字的成本口径是预留估值，不是实测 token。** 预算估计只能被预留值修正，不能被实测用量修正。**不允许塞入估算数字让这条变绿。**

### 预算消耗

本次验收在 Trigger 上真跑一次渲染探针，成本约 $0.0001；未调用任何 AI、转写或图像供应商，`AI_MONTHLY_BUDGET_USD=10` 未受实质影响。

### 结论

内存与渲染边界已用真实云端数字取证并且余量充裕；**成本口径的两条链路都断着**（私有 schema 读不到、实测用量从不落库）。**T094 记为 Blocked，保持未勾选。**
