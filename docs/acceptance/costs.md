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

---

## 2026-09-12 进展（路线图 S1）— T094 仍为 Blocked

本步只修**数据库侧的通路**与**代码侧的类型通路**，没有跑任何供应商调用，因此上面的验收结论不变，T094 保持未勾选。

### 阻断 1 已修一半：通路通了，调用方还没改

新增 `supabase/migrations/20260912000000_cost_settlement_rpc.sql`，按仓库既有范式补齐 6 个 `public.server_*` 函数（`revoke ... from public, anon, authenticated` + 仅 `grant ... to service_role`）：两个写入包装器 `server_register_cost_attempt` / `server_settle_cost_attempt`，四个 `security definer` 只读函数 `server_count_unsettled_reservations` / `server_sample_cost_reservations` / `server_read_cost_budget` / `server_sample_cost_attempts`。**没有暴露 `private` schema。**

已 apply 到 `orincard-dev`（`supabase migration list --linked` 确认此前 23 条全部同步，只推了这一条），并以 service_role 经 Data API 实测调通四个只读函数；同一次脚本里 `client.schema("private")` 仍然被拒，证明安全边界没有被顺手放宽。

**尚未修的部分**：`src/trigger/retention.ts:58` 与 `tests/cloud/performance.test.ts` 仍是 `client.schema("private")` 的老写法，所以 `orincard-retention-maintenance` **依然每小时失败**。改调用方属于路线图 S6，这里不提前动。

### 首次读到的真实预算数字

四个只读函数调通后，第一次拿到了此前 `PGRST106` 挡住的数据（`development`，2026-09 期）：

| 指标 | 实测值 |
|---|---|
| `limit_micro_usd` | 10,000,000（$10.00） |
| `spent_micro_usd` | 8,500（**$0.0085**） |
| `reserved_micro_usd` | 1,241,000（**$1.241**） |
| 未结算预留条数（`open` / `unknown`） | **18** |

这 18 条积压是对账巡检从未成功执行过的直接后果：预留占着额度但永远不会被释放。**当月可用余量实际是 $8.75 而不是 $10**，且在 S6 修好 `retention.ts` 之前只会继续缩小。后续每一步的花费预估都应按这个余量算。

### 用量透传（代码侧）

`src/server/ai.ts` 的 `ResponsesClient` 响应类型补上 `id` 与 `usage`（含 `input_tokens_details.cached_tokens`），新增 `ProviderUsage` / `ProviderMeasurement` 与可选回调 `StructuredOutputRequest.onMeasurement`。**没有改 `generateStructured` 的返回类型**，以免波及 4 个调用点与约 15 处测试桩；修复重试天然各回调一次。三个 token 数缺任何一个都视为"没有实测用量"而不回调——不估算、不补零。结算发生在校验 `output_text` **之前**：token 是照烧的，输出无效不等于这次调用没花钱。

### 费率表的取数与其局限（重要）

新增 `src/server/cost.ts`，token → micro-USD 换算。**$X per 1M tokens 恰好等于 X micro-USD per token。**

来源：DeepSeek 官方 API 文档定价页，**取数日期 2026-09-12**。峰谷制自 2026-08-16 16:00 UTC 起生效，峰时为 UTC 周一至周五 01:00–04:00 与 06:00–10:00（其余含整个周末为谷时），谷时费率恰为峰时一半。

| 模型 | 档位 | 缓存命中输入 | 缓存未命中输入 | 输出 |
|---|---|---|---|---|
| `deepseek-v4-pro` | 谷时 | 0.022 | 0.66 | 1.98 |
| `deepseek-v4-pro` | 峰时 | 0.044 | 1.32 | 3.96 |
| `deepseek-flash` | 谷时 | 0.003 | 0.15 | 0.60 |
| `deepseek-flash` | 峰时 | 0.006 | 0.30 | 1.20 |

**这里算出的美元数是按公开费率折算的上界，不是账单金额。** token 数本身是供应商实测回报的，没有估算成分；但折算有两处已知偏差，都往高估方向取：

1. 输入分缓存命中／未命中两档，**相差 30 倍**。供应商没有拆分回报 `cached_tokens` 时按**全部未命中**计价。此时 `usage` 里不会写 `cachedInputTokens` 键——**键缺失代表"未拆分回报"，与"拆分后命中 0 个"是两回事，不混为 0。**
2. 峰谷按调用时刻的 UTC 判定，跨边界的那一次可能与供应商侧判定不同档。

未登记费率的模型**直接抛 `UnpricedModelError`**，不静默套用默认费率——宁可结算不了，也不写一个猜的数字。整数微美元向上取整。

曾有公告称 2026-09-14 04:00 UTC 起 `deepseek-v4-pro` 改路由到 V4.1-Flash 并按 Flash 计价；该公告**已被官方推翻**，V4-Pro 继续服务、计费不变。此处按未变的费率登记。

### 阻断 2 未解

`private.cost_attempts` 里**依然没有任何 `state = 'settled'` 的样本**，实测取样确认最近的尝试仍是 `state = 'unknown'`、`actual_micro_usd = null`。接线属于 S2。

顺带核实了一件影响 S2 做法的事：`cost_attempts` 的行**是既有 SQL 函数自己插的**，不是应用层插的，且三种 operation 的 `attempt_key` 语义各不相同——

| operation | `sequence` 的含义 | 插入方 |
|---|---|---|
| `generation` | `public.jobs.attempt + 1` | `20260907002243_b04.sql:294` |
| `transcribe` | `trunc(offsetSeconds)`，**不是尝试次数** | `20260908110457_b05_parse_budget.sql:114` |
| `candidate` | 恒为 `1` | `20260907002243_b04.sql:395` |

因此 S2 对这些路径应当**只结算、不重复登记**，且 `generation` 的一个 key 覆盖整个 job attempt——该 attempt 内若发生 schema 修复重试，两次供应商调用共用一个 key，必须**累加后结算一次**（`src/server/cost.ts` 的 `mergeUsage`），结算两次不会累加。

### 结论

内存与渲染边界已用真实云端数字取证并且余量充裕；**成本口径的两条链路都断着**（私有 schema 读不到、实测用量从不落库）。**T094 记为 Blocked，保持未勾选。**

---

## 2026-09-12 进展（路线图 S2）— T094 仍为 Blocked

### 阻断 2 的代码侧已接完，但**还没有一条真实结算样本**

五个 DeepSeek 调用点全部接上了结算，`pnpm typecheck` 通过、单测 237 通过 / 7 跳过、`check-planning.mjs` 仍 `15 unchanged design files`。但**本步没有发起任何真实供应商调用**（本轮新增花费 $0.00），所以 `private.cost_attempts` 里**依然没有 `state = 'settled'` 的行**。链路是"接好了但没通电"，通电在 S4。

| 调用点 | 登记尝试行 | 结算入口 | attempt_key |
|---|---|---|---|
| `src/trigger/generate.ts` | SQL 已登记（`server_claim_generation_job`） | `server_settle_generation_usage` | 由 DB 按 `jobs.attempt` 自解析 |
| `src/app/api/v1/projects/[id]/rewrite/route.ts` | SQL 已登记（`b04_begin_ai_candidate_job`） | `server_settle_cost_attempt` | `job:<id>:candidate:1` |
| `.../regenerate/route.ts` | 同上 | `server_settle_cost_attempt` | `job:<id>:candidate:1` |
| `src/trigger/tool.ts` | **应用层 register** | `server_settle_cost_attempt` | `job:<id>:tool:1` |
| `src/app/api/v1/guest/generate/route.ts` | **应用层 register** | `server_settle_guest_cost_attempt` | `guest:<guardId>:generation:1` |

后两行是全仓仅有的两条 SQL 侧不登记的路径，必须自己 register；前三行只结算不重复登记，否则同一次调用会被计两遍。

### 三条设计决定，都会影响后面读账的人

**1. 失败路径也结算。** token 是照烧的，供应商失败不等于这次调用没花钱。五处的结算都放在 `finally` 或失败分支里，且**排在收尾动作之前**——`server_finalize_generation_job` 和 `server_finish_guest_generation` 都会把预留翻成 `unknown` 并使 lease 失效，收尾之后再结算就会被入口拒绝。

**2. 结算失败被吞掉，只 `console.error`。** 结算发生在钱已经花完之后，此时抛错只会把一次已付费的成功变成用户可见的失败。吞掉的方向是**保守**的：漏记会让预留继续占额度，预算显得更紧而不是更松，不会导致超支。代价是那笔预留要等对账巡检回收——而巡检当前是坏的（阻断 1，修复在 S6）。

**3. 登记失败**（只发生在 tool / guest 两条路径）**向上冒泡。** 登记在调用之前，登记不上说明预留不在，此时继续调供应商等于绕过预算。这与结算失败的处理**故意相反**。

### 访客路径为什么要一套独立函数

`cost_reservations_subject_check` 强制 `job_id` 与 `guest_guard_id` 二选一，访客侧 `job_id` 恒为 null，所以 `private.settle_cost_attempt` 的 `where reservation.job_id = p_job_id` **永远匹配不到访客预留**。迁移 `20260912010000` 因此加了一个孪生函数 `private.settle_guest_cost_attempt`，只把关联列换成 `guest_guard_id`，其余校验、幂等与 23505 冲突分支逐条相同。

孪生体是会漂移的。`tests/db/jobs-usage.test.ts` 里新增了一条断言：把两个函数体归一化空白、把访客的关联谓词替换回 job 版本后，要求两段**完全相等**（当前比对 1199 个字符）。任一边改了校验或错误码而另一边没跟上，这条断言立刻红。

### 新入口的实测验证

迁移 `20260912010000_settlement_entrypoints.sql` 已 apply 到 **`orincard-dev`**（已核对 API 返回的项目名，未触生产），并经 Data API 逐个实测：

| 调用 | 结果 |
|---|---|
| `service_role` → `server_settle_generation_usage`（伪造 job） | `22023: generation lease is not valid for settlement` |
| `service_role` → `server_register_guest_cost_attempt`（伪造 guard） | `22023: open guest cost reservation not found` |
| `service_role` → `server_settle_guest_cost_attempt`（伪造 guard） | `22023: cost attempt not found` |
| `anon` → 上述任意入口 | `42501: permission denied` |
| `service_role` → `schema("private").from("cost_attempts")` | `PGRST106: Invalid schema: private` |

即：三个新入口对 `service_role` 可达且守卫生效，对 `anon` 关闭，**且安全边界没有被这次迁移放宽**——私有 schema 依然读不到。

### 仍未解决

- **阻断 1 仍只修了一半**：通路在，`src/server/retention.ts:58` 仍在直连 `private` schema，对账巡检继续每小时失败，18 条卡死预留继续占着 $1.241。修复在 S6。
- **没有任何真实用量样本**。费率表准不准、`priceTextUsage` 的 cache-miss 保守假设离真实账单差多少，都要等 S4 跑一次真实生成才能对账。
- 图像（APIMart）与转写（豆包）两类任务**还没有任何结算口径**，属 S3。

**T094 继续记为 Blocked，保持未勾选。**

---

## 2026-09-12 进展（路线图 S3）— 逐类任务的成本口径

这一节回答一个问题：**这个产品每一类会花钱的操作，账是怎么记的，哪些数字是真的。**

### 全部四类花钱操作

| 类别 | 供应商 | 记账通路 | 数量口径 | 单价口径 | 结论 |
|---|---|---|---|---|---|
| 文本生成 / 改写 / 工具 | DeepSeek | `private.cost_attempts` | ✅ 供应商回报 token 数 | ⚠️ 官网公开价目表，非账单核对 | **有口径，未通电**（S2 接完，等 S4 跑真实调用） |
| 图片 / 人像 | APIMart | `private.ai_asset_reservations` | ✅ 一次调用一张图 | ✅ **供应商直接回报美元成本** | **有口径，已在真实运行**（见下） |
| 视频转写 | 火山引擎（豆包） | `private.cost_attempts` | ✅ 音频秒数，ffmpeg 实测，已落库 | ❌ **没有任何可信单价** | **无口径，不结算**（见下） |
| 图库检索 / 导入 | Pexels | 不记账 | — | — | 免费额度，不产生供应商成本 |

导出渲染（PNG / JPG / PDF / PPTX / MP4）全部在本地 ffmpeg 与浏览器里跑，不调付费供应商，因此不在成本账本内。

### 图片：唯一一条真实跑通的成本链路，但它在编数字

图片是全仓**唯一**已经把真实供应商成本写进库的路径。实测取到的历史行：

| `actual_micro_usd` | `reserved_micro_usd` | 含义 |
|---|---|---|
| 8500 | 25000 | 一次成功的图片生成，真实花了 **$0.0085**，预留是 $0.025 |

这个 8500 就是「开发项目 2026-09 已花 $0.0085」的全部来源——**这个产品迄今为止在 AI 上花掉的每一分钱，都是这一张图。**

但改之前的代码是这样写的（`src/trigger/generate-image.ts:53`、`src/trigger/visual-tool.ts:185`）：

```ts
Math.max(0, Math.round((image.providerCostUsd ?? 0.025) * 1_000_000))
```

APIMart 没回报成本时，`$0.025` 这个凭空来的常数会被写进 `actual_micro_usd`，落库之后**和上面那个真实的 8500 长得一模一样**，没有任何字段能分辨。而账本正是拿来判断"预算还够不够"的东西。更糟的是量级也不对：真实成本 $0.0085，编的数是 $0.025，**差约 3 倍**。

已改（迁移 `20260912020000_asset_cost_source.sql`，已 apply 到 `orincard-dev`）：

1. `private.ai_asset_reservations` 加 `cost_source` 列，取值 `measured` / `unmeasured_reserved` / `null`
2. `p_actual_micro_usd` 允许传 `null`，含义是"供应商没报"。此时**按预留全额入账**并记为 `unmeasured_reserved`

为什么按预留而不是按 0，也不是按常数：预留是这次调用之前就已经从预算里扣掉的额度，用它入账不凭空造数，且方向保守——宁可让预算显得更紧，不会显得更宽松。记 0 等于宣称这次调用免费，正好是最危险的方向。

`cost_source = null` 的行是**迁移之前的历史行，来历不可考**，没有回填——按已知信息倒推来历，本身就是另一种编数字。

新增只读入口 `public.server_sample_asset_cost_sources`，让"有多少笔成本不是实测的"这个问题可以直接查，不用翻代码。

### 转写：**明确没有单价口径，因此不结算**

数量侧其实是干净的。`public.server_start_source_transcription` 在调供应商**之前**就把音段写进了 `cost_attempts.usage`，实测样本：

```
attempt_key: job:13c5e722-…:transcribe:0
usage:       { "offsetSeconds": 0, "durationSeconds": 4.031 }
state:       unknown          actual_micro_usd: null
```

`durationSeconds` 是 ffmpeg 按精确边界切出来的实测值，不是估算。**缺的是单价**：仓库里没有任何经过核对的火山引擎每秒费率。`docs/acceptance/sources.md` 那个 ~$1.00/次 标着 `[UNVERIFIED-NUMBER]`，不能拿来算钱。

所以这一类**不结算，不估算，不补零**。要解开只缺一样东西：**火山引擎控制台账单页上该 `resourceId`（`volc.seedasr.auc`）的实际计费单价**。拿到之后按 `durationSeconds × 单价` 就能算，代码侧不需要再改结构。

### 这笔账现在漏在哪：$1.241 的精确构成

实测（`server_read_cost_budget` + `server_sample_cost_reservations`，2026-09-12）：

```
limit 10,000,000 μ$   spent 8,500 μ$   reserved 1,241,000 μ$
```

18 条预留，逐条对上：

| 类别 | 条数 | 单条预留 | 小计 |
|---|---|---|---|
| 视频解析 / 转写 | 1（`unknown`） | $1.000 | **$1.000** |
| 图片 / 人像 | 8（`unknown`）+ 1（`open`） | $0.025 | $0.225 |
| 访客生成 | 8（`unknown`） | $0.002 | $0.016 |
| **合计** | **18** | | **$1.241** |

分文不差。可以直接读出两件事：

1. **$1.00，占整个泄漏的 81%，是一次视频转写。** 转写没有结算口径不是一个理论缺口——它是这个泄漏的绝大部分。每解析一个视频就永久钉住 $1.00，因为 `server_finalize_source_parse_job` 见到未结算的尝试就把预留翻成 `unknown` 保守占着（这是对的），而**从来没有任何代码把它结算掉**。
2. 剩下的 `unknown` 是历史上失败或中断的调用留下的，本该由对账巡检回收，而巡检从第一天起就没成功跑过（阻断 1，`src/server/retention.ts:58`，修复在 S6）。

按当前口径，**开发项目 2026-09 的真实可用余量是 $8.75**（$10 − 已花 $0.0085 − 卡死 $1.241）。

### 本步的验证

| 项 | 结果 |
|---|---|
| 迁移 apply 目标 | `orincard-dev`（调 API 核对项目名后才执行，未触生产） |
| `service_role` → `server_sample_asset_cost_sources` | ok，返回按 `cost_source` × `state` 的汇总 |
| `anon` → 同一入口 | `42501: permission denied` |
| `service_role` → `server_finalize_ai_asset_candidate`（`p_actual_micro_usd: null`，伪造素材） | `42501: AI candidate reservation unavailable`（守卫先生效，符合预期） |
| `pnpm typecheck` | 通过 |
| `pnpm test` | 240 通过 / 7 跳过 |
| `check-planning.mjs` | PASS，`15 unchanged design files` |

**本步新增 AI 花费 $0.00** —— 没有发起任何真实供应商调用。

### 途中撞上并修正的一个错误判断

`server_finalize_ai_asset_candidate` 在 `supabase/definitions/ai-asset-budget.sql` 里也有一份，我一开始把它当成「迁移的镜像」同步改了。**这是错的**，改完 `pnpm test` 就红了一条 `migration-smoke`。

真实关系是：`definitions/*.sql` 是基线迁移 `20260906000100_walking_skeleton.sql` 的**生成源**（`scripts/prepare-migrations.mjs` 把 8 个定义文件拼成那个迁移），`migration-smoke` 逐字节校验二者一致。所以改 definitions 等于**篡改一个已经 apply 过的迁移**。已回退，S3 的改动只留在新迁移 `20260912020000` 里。

还有第二个事实让这样做是安全的：`ai-asset-budget.sql` 不在任何 `supabase db query --file` 重放列表里（被重放的只有 identity / projects / assets / jobs-usage / billing / growth 六个）。**但这是一根没上锁的引线**——哪天有人给它补一个 `RUN_DB_TESTS` 重放块，重放就会把基线版本的函数写回开发库，悄无声息地抹掉本次迁移。`tests/db/ai-asset-budget.test.ts` 里加的第三条断言把这两件事都写在注释里并钉住了「基线不得出现 `cost_source`」。

**T094 仍为 Blocked**（文本类仍无真实结算样本，转写无单价口径），保持未勾选。

---

## 2026-09-12 · T094 实测验收 — ✅ 通过（路线图 S4）

`pnpm exec vitest run tests/cloud/performance.test.ts`，`ORINCARD_RUN_PERFORMANCE_CLOUD=1` + `RUN_CLOUD_PROBES=1`，**7 个用例全部通过**。所有读数来自真实云端运行与真实开发库，没有任何 mock 顶替。

### 一、渲染探针：真实云端硬件读数

Trigger.dev 上真跑一次 `orincard-foundation-render-probe`（run `run_06g975uku6n2asr06ojdkdfb01`）：

| 指标 | 实测值 | 来源 |
|---|---|---|
| 渲染耗时（进程内计时） | **1,987 ms** | 探针 `metrics.elapsedMs` |
| 整段机器时间 | **2,124 ms** | Trigger 自己的计费口径 `durationMs` |
| 峰值 RSS | **140,554,240 B（134.0 MiB）** | 真实 `process.memoryUsage().rss` |
| PNG / PDF / PPTX 字节 | 14,981 / 18,168 / 45,836（合计 78,985 B） | 哈希已逐个对上，PNG/PDF 文件头已校验 |
| 计算费 | 0.0071685 美分 = **$0.0000717** | Trigger 结算 |
| 每次运行费 | 0.0025 美分 = **$0.000025** | Trigger 结算 |

**机器内存上限不是猜的，是从账单反推的。** 用例明确要求把真实机器规格传进来而不是在代码里写「大概 1 GB」。Trigger 的 API 与 SDK 都不回报 machine preset，`trigger.config.ts` 也没 pin，所以这样定：

- `baseCostInCents = 0.0025` → $0.000025，与公开的**每次运行费完全相等**
- $0.0000717 ÷ 2.124 s = **$0.00003375/s**，与 small-1x 的 $0.0000338/s **吻合到四位有效数字**
- small-1x 同时也是未 pin 时的默认档

两条独立证据都指向 **small-1x = 0.5 GB = 536,870,912 B**。峰值 RSS 占 **26.2%**，余量充裕。若日后 pin 了更大机器，这个数必须跟着改——它是账单反推值，不是常量。

### 二、第一条真实结算的文本用量 —— 链路确认通电

跑了一次真实访客生成（4 页 listicle，DeepSeek，墙钟 **60.8 s**）。这是 S1–S2 接线之后**第一条真正落库的实测成本**：

```
attempt_key: guest:5ddf8378-daf5-4235-bd24-19b673886e45:generation:1
state:       settled
usage: { inputTokens: 466, cachedInputTokens: 384, outputTokens: 2448, totalTokens: 2914,
         providerCallCount: 1,
         rateCacheHitInputMicroUsdPerToken: 0.022,
         rateCacheMissInputMicroUsdPerToken: 0.66,
         rateOutputMicroUsdPerToken: 1.98 }
actual_micro_usd: 4910
```

费率和用量一起落库，所以这笔账可以当场手验：

| 项 | 计算 | 微美元 |
|---|---|---|
| 缓存命中输入 | 384 × 0.022 | 8.448 |
| 缓存未命中输入 | (466 − 384) × 0.66 | 54.12 |
| 输出 | 2,448 × 1.98 | 4,847.04 |
| **合计** | | **4,909.608 → 记 4,910** |

分文对得上。**一次 4 页 carousel 的真实文本成本 = $0.004910。**

### 三、修正预算估计：预留额是错的，而且是往危险方向错

这正是 T094 要的「修正预算估计」，第一次有真数字可对：

| 类别 | 预留额 | 实测 | 偏差 |
|---|---|---|---|
| 访客生成（4 页） | $0.002 | **$0.004910** | **少预留 2.46 倍** ⚠️ |
| 图片 / 人像 | $0.025 | $0.0085 | 多预留 2.94 倍 |
| 视频解析 / 转写 | $1.00 | 无口径 | 未知 |

图片预留偏大只是保守，不伤人。**访客生成预留偏小是真问题**：预留是花钱之前用来卡预算的闸门，闸门开小了，`AI_MONTHLY_BUDGET_USD=10` 实际能放出去的钱就比 $10 多。而且 4 页是最小档，默认 6 页只会更贵，倍数还会拉大。

### 四、验收过程中查出的缺陷：访客预留结算不掉

跑之前 18 条卡死 / $1.241，跑完 **19 条 / $1.243**——多出来的正好是我这一次运行的 $0.002。

链路只通了一半：

- ✅ 尝试行结算了：`cost_attempts` 拿到 `state = settled`、`actual_micro_usd = 4910`
- ❌ 预留行没结算：`cost_reservations` 停在 `state = unknown`、`settled_micro_usd = 0`
- ❌ 预算行没动：`spent_micro_usd` 仍是 8500，真实花掉的 $0.004910 **一分钱没进 `spent`**

根因定位到具体函数：把「预留 → 已花」推过去的是 `private.finalize_job`（`20260906000100_walking_skeleton.sql:1157-1181`），它按 **`job_id`** 找预留。访客路径**没有 job 行**，所以谁也不会调它。而 `public.server_finish_guest_generation`（`20260907002243_b04.sql:257`）无条件把预留翻成 `unknown`，注释写着「在缺少真实费用时保守保持成本占用」——这在 S2 之前是对的，那时确实没有真实费用；现在费用有了，它却不知道。

**这不是 S2 引入的**：S3 那张泄漏表里 8 条 $0.002 就是它历史上攒下的。S2 补的 `settle_guest_cost_attempt` 是**尝试层**的孪生体，**预留层**的孪生体（对应 `finalize_job` 的那一半）至今没人写。

后果有两条，方向相反、都不好：钱卡在 `reserved` 里回不来（每跑一次访客生成 +$0.002）；同时真实花费进不了 `spent`，账面上这个产品在文本上永远显示花了 $0。

修法明确：加一个按 `guest_guard_id` 关联的预留结算入口，把 `reserved -= 2000 / spent += 4910` 一次性推过去，并把预留置为 `settled`。**并入 S6**（S6 本来就是预留回收那一步）。

### 五、当前真实预算

```
limit 10,000,000 μ$   spent 8,500 μ$   reserved 1,243,000 μ$   →  可用 $8.7485
```

### 六、本次实际花费

| 项 | 金额 |
|---|---|
| DeepSeek 一次 4 页生成 | $0.004910 |
| Trigger 探针 2 次运行（计算 + 运行费） | $0.000195 |
| **合计** | **≈ $0.0051** |

原计划给 S4 估的是 $0.25–0.50，**实际低两个量级**——因为取样本走的是最便宜的访客通道，而不是完整登录态生成。

**T094 判据全部满足，可勾选。**
