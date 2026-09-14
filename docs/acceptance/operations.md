# T086 预算 / 到期清理与监控

## 2026-09-12 · 实测验收 — 四条 Expect 全部通过，但**暂不勾选**（路线图 S6）

`tasks.md:578` 的 Expect 有四条：**来源/导出到期清理**、**80% 告警 / 100% 熔断**、**复验已有 reconciler**、**日志无正文**。

四条都是运行时行为，`pnpm exec vitest run tests/cloud/operations.test.ts` 原来只有 4 条全替身用例，一条也证明不了。这次全部拿开发项目（`orincard-dev`）实跑了一遍。过程中查出**两个真缺陷**，都不是配置疏漏，是代码本身就走不通。

---

## 一、缺陷 1：对账巡检从上线第一天起，一次都没成功执行过

`src/trigger/retention.ts:58`（修复前）：

```ts
client.schema("private").from("cost_reservations").select(...)
```

Data API 暴露的 schema 只有 `["public","graphql_public"]`。任何 `client.schema("private")` 一律回 **PGRST106 `Invalid schema: private`**；何况 `private.cost_reservations` 连 `service_role` 都 `revoke all`。也就是说每小时那个 `retentionTask` 跑到巡检这一步就抛错，`reconciler.verified` 从来没有被发出过一次。

**已修**：改走 `public.server_count_unsettled_reservations` 这个 `security definer` 只读入口。

新增两条用例锁住它（`tests/cloud/operations.test.ts:101-127`），用的是**模拟 Data API 真实行为**的替身——`schema()` 一律回 PGRST106，而不是一个什么都答应的 mock：

| 用例 | 断言 |
|---|---|
| 走 RPC 而非 private schema | 读数正确，且 `schema` **一次都没被调用** |
| PGRST106 必须炸出来 | 读失败不许被吞成「健康的 0」 |

**变异验证**：把 `retention.ts` 改回 `.schema("private")`，用例立刻转红。

## 二、缺陷 2：80% 告警是死代码

`assertProviderBudget`（`src/server/observability.ts`）实现完整、单测齐全，但**全仓零调用点**。100% 硬闸门在 SQL 里是真的（每个预留入口都算 `limit - reserved - spent < 请求额 → budget_exceeded`），而「快到上限了」这件事从来没有任何地方会说出来。

**已接**：接在每小时的 `runRetentionMaintenance` 里，清理之后、巡检之前（`retention.ts:36-44`）。选这个位置的理由写在代码注释里——不给用户请求加一次往返，又能每小时把比例喊一次。查不到预算行按熔断处理，和 SQL 侧 `budget.period is null` 直接拒绝预留保持一致。

### 实测三档（真读开发库的 `private.cost_budgets` 行）

固定 `reserved = 0 / spent = 1,254,410`，只改上限：

| 场景 | `limit_micro_usd` | 比例 | 结果 | 发出的事件 |
|---|---|---|---|---|
| A 当前额度 | 10,000,000 | 12.54% | 通过，`state: open` | 无 |
| B 收紧 | 1,475,776 | **85.00%** | 通过，`state: warning` | `budget.warning` |
| C 打满 | 1,254,410 | **100%** | **抛 `BudgetCircuitOpenError`** | `budget.circuit_open` |

B 档关键点：**告警不是熔断**，这一轮清理与巡检照常走完。

上限已还原为 `10000000`。

### 100% 熔断在 SQL 侧的实测

告警是应用层的。真正拦住花钱的是 SQL。把可用额度压到 1,000 μ$，发起一次 2,000 μ$ 的访客预留：

```
{"outcome":"budget_exceeded"}
```

并且**没有建 guard 行、没有建预留行**（两处都实查为 0）。失败是关闭的方向。

## 三、到期清理 —— 第一次跑其实什么也没证明

第一次跑 `runRetentionMaintenance` 返回 `removed: {source: 0, export: 0}`——因为库里所有 `expires_at` 都在未来。**绿得毫无信息量**。

于是造了真实夹具：2 个 Storage 上传 + 2 条 assets + 1 条已到期 source + 1 条已到期 export，再跑一次：

| 对象 | 前 | 后 |
|---|---|---|
| source `7c545a5f-…` | `ready` | **`deleted`** |
| export `98b5f5b0-…` | `ready` | **`expired`** |
| asset `9809b984-…` | `ready` | **`deleted`** |
| asset `3b9a2b68-…` | `ready` | **`deleted`** |
| `storage.objects` where `s6-retention/%` | 2 个对象 | **`[]`** |

Storage 里的字节是真的没了，不只是数据库标了个位。

## 四、复验 reconciler —— 顺带清掉了 19 条卡死预留

巡检能跑之后，第一次读到的 `unsettledReservations` 是 **19 条 / $1.243**。逐条查过成因，是两个独立的洞。

### 洞 A：访客预留永远结算不掉

`private.finalize_job` 按 `job_id` 找预留，而访客预留挂在 `guest_guard_id` 上、`job_id` 为 `null`——**它永远查不到**。`public.server_finish_guest_generation` 又无条件把预留翻成 `'unknown'`。结果：每跑一次访客生成就多卡死 $0.002，而真实花掉的钱一分进不了 `spent`。

**已修**（`20260912030000_reservation_settlement_close.sql`）：新增 `private.finalize_guest_reservation`，是 `finalize_job` 里成本预留那一半的访客孪生体，审计条件逐条一致（有尝试仍处于 `sent`/`unknown`、或一条尝试都没有 → 不结算）。**兜底分支原样保留**：审计不过仍翻 `'unknown'`，宁可卡住额度也不记成 0。

实测（走真实 Data API 的 `server_finish_guest_generation`）：

| | 前 | 后 |
|---|---|---|
| `reserved_micro_usd` | 1,243,000 | 1,241,000 |
| `spent_micro_usd` | 8,500 | **13,410** |
| 预留状态 | `unknown` | `settled` / `settlement_source = measured` |

那 `+4,910` 就是 S4 那次真实访客生成花掉的 **$0.004910**，第一次落进账本。注意它比预留额 $0.002 高 **2.46 倍**——预留开小了，`released` 为 0，预算净额如实收紧。这正是预留开小该有的代价。第二次调用是 no-op（幂等）。

### 洞 B：18 条历史陈旧预留，没有任何可结算的实测数字

逐条查过：每条要么有一条仍在 `sent`/`unknown` 的尝试，要么一条尝试都没有；`settledMicroUsd` **全为 0**。也就是**供应商调用已经发出、用量从没回报过**。

两条错误的处置方式：

- **直接 release** —— 等于宣称这次调用免费。**这是最危险的方向**，会把额度放回去让人接着花。
- **编一个数字** —— S3 已经因为 `$0.025` 这个常数否掉过一次。

采用 S3 给图片资产定下的同一条 policy：**按预留额全额保守入账**，标记 `unmeasured_reserved`。预留额是花钱之前就从预算里扣掉的上界，用它入账不凭空造数，方向只会让预算显得更紧。

按 ID 逐条核销全部 18 条（1×1,000,000 + 9×25,000 + 8×2,000）：

| | 前 | 后 |
|---|---|---|
| `reserved_micro_usd` | 1,241,000 | **0** |
| `spent_micro_usd` | 13,410 | **1,254,410** |
| 未结算预留数 | 18 | **0** |

**这不释放任何额度。** 预留本来就已经计入占用，核销只是把「悬着」变成「记为已花」——净可用额不变，但告警比例从此有意义了。

核销刻意**不放进 retention 定时任务**：预留是钱，5 分钟没结算就自动核销会把本可回收的额度烧掉。巡检只报数，核销是需要人看一眼的显式动作。`p_min_age`（下限 1 小时）是防手滑的第二道闸——插一条新鲜预留试核销，如实被拒：

```
reservation is not stale enough to write off
```

### 巡检现在读到的

`staleJobs = 0`，`unsettledReservations = 0` → 发出 `reconciler.verified`。

新增的 `public.server_list_stale_reservations` 让巡检不止给一个数字，还能看清哪一条卡住、卡了多久、有没有可结算的实测数字——只回报金额与计数，不含任何正文。

## 五、日志无正文

`expect(JSON.stringify(events)).not.toMatch(/body|prompt|transcript|content|text/i)` —— 替身用例和真实云验收用例都断言了。实跑通过。事件里只有 `code` / `resource` / `count` / `ratio` 四类字段。

## 六、用例现状

`tests/cloud/operations.test.ts`：4 条 → **8 条本地通过 + 1 条真实云用例**（`ORINCARD_RUN_OPERATIONS_CLOUD=1` 时运行，带真实凭据实跑为 **9 passed**）。

云用例的写法有一处值得说明：它**不预设巡检是绿的**。健康数非零时断言必须抛 `RECONCILER_UNHEALTHY`，为零时才断言 `reconciler.verified`。红本身就是要报的结论，不允许调绿。

注意 `pnpm test` 是 `vitest run --exclude 'tests/cloud/**'`，所以这个文件不在 CI 的常规 test 步骤里——和 S5 发现的发布守卫是同一类问题，但这里 Check 命令本身就点名了文件，不构成绕过。

## 七、为什么暂不勾选

**四条 Expect 全部实测通过**，且是在两个真缺陷修掉之后通过的，不是靠替身糊过去的。

挡着的只有一条：`tasks.md:580` 写 `Depends: T085`，而 **T085 未勾**（卡在 B-4，见 `docs/acceptance/deployment.md`）。S5 刚用「依赖未满足的任务本来也不该先勾」这条理由挡下 T085，这里不能换一套标准。

但两者性质不同，需要摆清楚：

| | T085 | T086 |
|---|---|---|
| 自身 Expect | **一半无法验证**（发布流水线从未注册、从未运行） | **四条全部实测通过** |
| 阻塞来源 | 自身缺证据 + 依赖未满足 | **仅依赖未满足** |
| 依赖的实质关联 | T084 付费链路确实是发布前提 | T085 是发布流水线；T086 的清理/告警/巡检**不依赖它存在**就能验证 |

**这是你的决定。** 要按「实质通过、仅形式依赖未满足」先勾 T086，说一声我就勾并在这里记一行说明；要保持严格依赖顺序，就等 B-4 配完、T085 转绿后一并勾。默认保持未勾。

## 八、迁移历史的一个附带修复

`supabase_migrations.schema_migrations` 里缺 S2 的 `20260912010000` 与 S3 的 `20260912020000`——两个迁移都已 apply，但没有登记。`supabase db push --linked --include-all` 会试图重跑它们。已补录三条（含本步的 `20260912030000`）。

## 九、本步花费

**$0.00。** 没有调用任何 AI 供应商。全部是只读查询、记账 RPC、本机测试。本月真实 AI 花费累计约 **$0.0134**（S4 $0.004910 + 此前 $0.0085），预算 $10.00。
