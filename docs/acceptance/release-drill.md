# T089 发布与回滚演练

对应 `docs/sdd/orincard/operations.md:49` 的失败回滚策略：

> 网站回滚到上一已知版本；worker 保留旧 schema 兼容并固定 run 版本；DB 优先前向修复，不自动破坏性回滚。若涉及数据恢复，进入维护模式并用户授权后恢复，不冒称 Git revert 能够恢复数据。

Check：`pnpm exec vitest run tests/cloud/release-drill.test.ts` —— **9 条通过**。

## 2026-09-14 · 四个环节逐个定性，**不勾**（路线图 S8）

先把话说在前面：**四个环节里有一个根本没法验证**。下表是每一项的真实成色，不是通过率。

| 环节 | 成色 | 依据 |
|---|---|---|
| 旧版兼容 | **真实验证** | 27 个已 apply 的迁移逐行扫描；载荷校验器跑的是生产同一份代码 |
| worker 故障 | **真实代码路径 + 内存 store** | 跑的是 `dispatchPendingJob` 本体，但 store 是内存替身；另有开发库真实状态佐证 |
| 网站回滚 | **无法验证** | `release.yml` 从未运行过，也跑不了（B-4）。只能验证「回滚是安全的」这个前提条件 |
| DB 恢复 | **真实验证（S7 已做）** | 真 dump、真 Storage、隔离 Postgres 容器、真实私有桶，见 [`backup.md`](backup.md) |
| 生产无破坏操作 | **真实验证** | 四种大小写写法全部被拒；`release.yml` 无任何破坏性命令 |

## 一、旧版兼容：回滚后的站点不会撞上少了东西的 schema

网站回滚意味着**旧代码去读新 schema**。只要迁移一直是加法，这件事就成立。

逐行扫过 `supabase/migrations/` 全部 **27 个**文件，寻找 `drop table` / `drop column` / `drop type` / `drop schema` / `truncate` / `alter column … set not null` / `alter column … type`：

**零命中。** 迁移集目前完全是加法。

`drop function|trigger|policy if exists` 不计入 —— 那是 `create or replace` 的常规前置，不动数据。

这条性质是**载荷**性的（网站回滚的安全性全靠它），但此前没有任何检查守着它，下一个迁移随手加一句 `drop column` 就会悄悄破坏回滚能力。已加断言。**变异验证**：临时放进一个 `alter table public.assets drop column state;`，用例立刻转红并逐行报出位置；移除后恢复绿。

### 顺带查出的结构性事实：worker 载荷没有任何版本容忍度

所有 worker 的载荷校验器都是**精确匹配**：`schemaVersion` 一律 `z.literal(1)` 或 `!== 1` 直接抛，对象形状一律 `.strict()` 或 `Object.keys().sort().join(",")` 全等比较。实测：

```
{jobId, schemaVersion: 1, requestId}          → 接受
{…, schemaVersion: 2}                          → 拒绝
{…, extra: "from a newer website"}             → 拒绝
```

也就是说 `operations.md:49` 那句「worker 保留旧 schema 兼容」**在代码里并不成立** —— worker 不兼容任何别的版本，多一个字段就整条拒。

今天没出事，是因为全仓只有 schemaVersion 1，而且 `release.yml` 的顺序是 `migrate → worker → website`：**worker 永远先于站点部署**，所以新站点发出的新载荷总能遇到已经就位的新 worker；回滚站点时，新 worker 收到的是它本来就认识的旧载荷。

结论：**回滚安全性完全由「迁移只加不减」＋「worker 先于 website 部署」两条前提支撑，没有第三道保险。** 两条前提现在都有断言钉着。这不是缺陷，是一条必须写下来的约束——将来要引入 schemaVersion 2，必须先给 worker 加版本容忍，否则这两条前提不够用。

## 二、worker 故障：任务不丢、不重复计费

跑的是 `src/server/jobs.ts` 的 `dispatchPendingJob` 本体（store 为内存替身，如实标注）：

| 场景 | 结果 |
|---|---|
| Trigger.dev 不可达，`trigger()` 抛错 | 任务停在 `pending_dispatch`，`providerRunId` 仍为 `null`，`markQueued` **一次没调**——可重试，没有半截状态 |
| 派发失败后重试 | 两次用的幂等键都是 `<jobId>:0`，**不是新随机值**。上游会去重，所以重试不会让供应商跑第二遍、不会二次计费 |
| 上游 run 已建但入队写丢了竞态 | 重读当前行并返回已有的 `run_existing`，不覆盖、不制造第二个 run |

**开发库的真实状态佐证**（只读查询）：

```
在飞任务（pending_dispatch / queued / running）: 0
终态任务: succeeded 33 / failed 8 / canceled 1
8 条失败全部带具体 error_code:
  SOURCE_MALFORMED 2 / PROVIDER_FAILED 2 / PROJECT_VERSION_UNAVAILABLE 2 / AUDIO_NOT_EXPORTABLE 2
```

没有卡住的积压，也没有一条「失败但说不出为什么」的任务。

## 三、网站回滚：**这一环没有验证过**

`release.yml` 至今从未运行过，也无法运行——两份工作流都不在默认分支 `main` 上，GitHub 因此从未注册 `release.yml`，`workflow_dispatch` 无从触发；`production` environment 返回 404。这是 S5 查明并登记为 **B-4** 的同一件事。

所以**「把网站回滚到上一已知版本」这个动作，本次演练一次也没做过**，本文不声称它可用。

能验证的只有它的前提条件，已全部验证：

- 部署顺序 `test → migrate → worker → website`，**website 在最后** —— 单独回滚站点不需要回滚 worker，更不需要动 DB
- `release.yml` 里**没有任何破坏性数据库命令**：`db reset` / `--force` / `drop table` / `drop column` / `truncate` 全部零命中
- 只执行 `supabase db push --linked --include-all`（推已验证的迁移），**没有** `supabase migration new` —— 流水线不现场生成迁移，符合「生产只执行已经在 CI 和开发验证过的 migration」

换句话说：**回滚的地基是好的，回滚本身没试过。** B-4 解开之前无法改变这个结论。

## 四、DB 恢复：S7 已真实做过一次

不重复造轮子。完整证据在 [`docs/acceptance/backup.md`](backup.md)：真 `pg_dump`、真下载 19 个对象、隔离 Postgres 容器、开发项目里的临时私有桶，`verifyRestore` 四项全过，三个真实反例全部被拦。

本演练只补一条 `operations.md` 明写而 S7 未单独点名的要求——**「恢复也要重新执行删除 tombstone，避免复活已删除内容」**：

```
恢复后 tombstone 仍不在 Storage  → 通过
恢复把一条已删对象带了回来      → 抛 "A tombstoned object was restored."
```

演练在这种情况下**必须失败**，而不是签字通过。

## 五、生产无破坏操作

- `createBackup` 对 `production` / `Production` / `PRODUCTION` / `prod` 四种写法全部拒绝，且在读取任何数据**之前**就拒（S7 改成白名单后的效果，这里再锁一遍）
- 本演练全程只读开发项目；唯一的写操作是往系统临时目录写备份夹具，进程结束即弃
- 未创建任何 Supabase 项目、未触碰生产、未调用任何 AI 供应商

## 六、为什么不勾

`tasks.md:596` 写着 `Depends: T088`，而 T088 是法律文本审定，卡在 **B-1**（12 项商业决策）。这是纯形式依赖——发布演练和退款条款没有技术关系，但依赖就是这么写的。

更重要的是**自身也有缺口**：第三环「网站回滚」没有验证过。所以 T089 与 T086/T087 不同，它**不属于**「实质通过、只差前置」那一类：

| | 自身 Expect | 阻塞 |
|---|---|---|
| T086 / T087 | 全部实测通过 | 仅形式依赖 |
| **T089** | **四环过三环，网站回滚未验证** | B-4（自身缺口）+ B-1（形式依赖） |

即便 B-1 明天解开，T089 也应该等 B-4 之后补跑一次真实发布与回滚再勾。

## 七、本步花费

**$0.00。** 全部是本地静态扫描、内存用例和开发库只读查询。
