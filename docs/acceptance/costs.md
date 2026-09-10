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
