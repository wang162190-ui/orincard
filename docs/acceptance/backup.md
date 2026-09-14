# T087 备份与隔离恢复

> 与 `docs/acceptance/recovery.md` 不是一回事 —— 那份是 T056「恢复包」（用户上传 ZIP 重建项目）。本文是 T087「运维层面的库与 Storage 备份 / 隔离恢复」。

## 2026-09-13 · 实测验收 — 四项检查全部真实通过，但**暂不勾选**（路线图 S7）

`tasks.md:585` 的 Check 是 `pnpm exec vitest run tests/cloud/backup.test.ts`。它原来 **3 条全绿**，但三条用例的输入全是内存替身：`dump: async () => Buffer.from("isolated database")`。也就是说 `createBackup` 从未接触过真实数据库或真实 Storage，`backup.mjs` 的 CLI 入口 `main()` **一次都没执行过**。

所以这次按 `docs/runbooks/recovery.md` 从头做了一次真实演练。

## 一、演练构成

| 环节 | 用的是什么 |
|---|---|
| 备份源 | 开发项目 `orincard-dev`（`ettuzeunkadkfnawawdy`），**只读** |
| 数据库 dump | 真实 `pg_dump` 走 IPv4 pooler（`supabase db dump` 的容器路径连续挂住，见第六节） |
| Storage 导出 | 经 Storage API 真实下载 **19 个对象 / 5.8 MB** |
| 隔离恢复库 | 一次性 Docker Postgres 17.6，本会话创建、用完即删 |
| 隔离恢复 Storage | 开发项目里的临时私有桶 `s7-drill-restore`，用完已删 |
| 生产 | **全程未触碰**。`SUPABASE_PRODUCTION_PROJECT_REF` 本机未设置 |

口令只在子 shell 里 `set -a` 加载；`pg_dump` 的口令经 **stdin** 传入容器，不进 argv、不进进程表、不进本文档。

## 二、备份：`backup.mjs` 的 CLI 入口首次真实执行

先跑两个反例，都在读取任何数据**之前**就被拒：

| 反例 | 结果 |
|---|---|
| `APP_ENV=production` | `Production backup and restore targets are forbidden.` exit 1 |
| 审批串指向另一个目录 | `Isolated target approval does not match.` exit 1 |

正例产出：

```json
{"schemaVersion":1,"environment":"development","objects":19,"references":26,"tombstones":12}
```

- 数据库 dump **670,282 字节**，29 张表、86 个函数，`pg_dump` stderr 为空、结尾标记完整
- 19 个对象逐个 SHA-256 入 manifest
- `database.dump` 与 `manifest.json` 权限均为 **`-rw-------`**

顺带量到一个开发库的真实状态：**26 条活引用里有 7 条是悬空的**（asset 行非 deleted，但 `storage.objects` 里没有对应对象）。备份因此只装得下 19 个。不是备份工具的缺陷，但恢复演练时这 7 条不会被校验到，记在这里。另一侧是干净的：**12 条 tombstone 没有一条还留在 Storage 里**。

## 三、恢复：DB 与 Storage 共同恢复，四项检查全过

数据库恢复进隔离 Postgres（真实数据，`public.assets` **38 行**），Storage 恢复进真实私有桶，然后用真适配器跑 `verifyRestore`：

```
隔离库读到：活引用 26 / tombstone 12
verifyRestore → {"databaseHashVerified":true,"referencesVerified":26,
                 "tombstonesVerified":12,"objectsVerified":19}
```

三个反例，全部对着**真实**的隔离库与隔离桶制造：

| 反例 | 结果 |
|---|---|
| 篡改隔离桶里一个已恢复对象的字节（追加 1 字节） | ✅ `Storage hash mismatch for assets/…/restored.` |
| 把一个 tombstone 对象上传回隔离桶 | ✅ `A tombstoned object was restored.` |
| 在隔离**库**里把一条已删 asset 改回 `ready` | ✅ `Restored database resurrected 1 tombstones.` |

每个反例之后都还原了现场（字节、对象、行状态）。

### 一处需要更正的中间判断

过程中我先用内存替身探到一个"漏洞"：把某个 key 同时放进 `references` 和 `tombstones` 时，`verifyRestore` 返回全绿。**这个判断是错的** —— Orincard 的活引用与 tombstone 都由 `public.assets.state` 这一个枚举列导出（`<>'deleted'` / `='deleted'`），天然互斥，真实数据造不出那个状态。上表反例 3 用真实数据复现时正常被拦住。

残留的只是：这条互斥前提从来没写进适配器契约，而 `verifyRestore` 接受任意适配器。已加两行断言 + 一条用例把它从口头约定变成检查（`restore-check.mjs:12-16`）。

## 四、查出的真缺陷（两个，都已修）

### 缺陷 1 · 恢复出来的库丢掉了大半安全策略，而且不报错 —— 严重

runbook 第 2 步只写"produce a read-only database dump"，**没规定范围**。按最自然的读法只 dump `public` + `private`，恢复日志里 **40 条错误**，逐条归因后是同一个根因：`auth` schema 不在范围内。

| | 源库 | 恢复后（无 auth） |
|---|---|---|
| RLS 策略 | 23 | **5** |
| 启用 RLS 的表 | 29 | 29 |
| 外键 | 52 | **31** |
| 表 / 函数 / `assets` 行 | 29 / 122 / 38 | 29 / 122 / 38 |

**危险的地方在于它看起来是成功的**：表齐、函数齐、数据一行不少。但 18 条调用 `auth.uid()` 的策略和 21 条指向 `auth.users` 的外键静默消失，而 RLS 在 29 张表上**仍然是开着的** —— 于是表变成"拒绝一切"，最可能的后续动作是有人把 RLS 关掉"修好"它。等于恢复出一个既不是原库、又把安全边界拆了的数据库。

**已修**：runbook 第 2 步现在明确要求 dump 含 `auth` schema，并给出恢复后必须比对的策略数 / 外键数 SQL。

**并且验证了修法有效** —— 带 `--schema=auth` 重新 dump（755,891 字节）再恢复进第二个隔离库：

```
错误行数: 1   （只剩无害的 schema "storage" already exists）
policies 23 / rls_tables 29 / fkeys 52 / assets 38
源库      23 /            29 /       52 /        38
```

**逐项相等。**

### 缺陷 2 · 唯一的生产闸门是大小写敏感的黑名单

`assertIsolatedTarget` 原来写的是 `environment === "production"`。实跑确认：

| `APP_ENV` | 修复前 | 修复后 |
|---|---|---|
| `production` | ✅ 拒 | ✅ 拒 |
| `Production` | ❌ **备份照常写出** | ✅ 拒 |
| `PRODUCTION` | ❌ **备份照常写出** | ✅ 拒 |
| `prod` | ❌ **备份照常写出** | ✅ 拒 |
| `staging` / 空 | ❌ / ✅ | ✅ 拒 |

这是**唯一**的生产闸门 —— 脚本拿到的是外部注入的适配器，看不到 Supabase project ref，没法像 S5 那些 CI 守卫一样比对 `SUPABASE_PROJECT_REF != SUPABASE_PRODUCTION_PROJECT_REF`。在这个位置用黑名单是错的做法。

**已改为白名单**（只放行 `development` / `preview`，与 runbook 第 3 步的措辞一致），并加 5 条参数化用例锁住。**变异验证**：把白名单改回原来的黑名单，9 条用例立刻红 4 条。

## 五、写进 runbook 的三条「这些检查证明不了什么」

- **`databaseHashVerified` 名字比它做的事大。** 它拿备份目录里的 dump 文件去比同一份备份的 manifest 哈希 —— 证明的是**归档没有静默损坏**，和"恢复出来的库是否等于 dump"无关。后者的唯一证据是引用/tombstone 比对，加上第四节那两个计数。
- **`objectsVerified` 是货真价实的**：字节从恢复后的 Storage 取回再哈希，能证明字节级一致。
- **仓库里没有 `verifyRestore` 的执行器**。它是个库，runbook 第 5 步假设操作者自己写 harness 提供两个适配器。本次演练用的 harness 是临时脚本，未入仓。

## 六、遇到但没解决的环境问题

`supabase db dump --linked` 连试三次都挂住：IPv6 直连不可达（自动降级正常），但降级到 IPv4 pooler 后它起的 pg_dump 辅助容器一直 `unhealthy`，5 分钟无输出、dump 文件 0 字节。推测与本机已在运行的整套本地 Supabase 栈（9 个容器）争抢资源有关，**不是 T087 的缺陷**。

绕法：直接在已运行的本地容器里调 `pg_dump` 连云端 pooler，一次成功。这条绕法已在本文第一节记录，但**没有写进 runbook** —— 它是本机环境的权宜之计，不是推荐做法。

## 七、为什么暂不勾选

Expect 是「已批准备份目标的 DB 和 Storage 共同恢复，哈希/引用/删除 tombstone 检查通过」。**四项全部真实通过**，且是在两个真缺陷修掉之后通过的。

挡着的是 `tasks.md:584` 的 `Depends: T086`，而 T086 也未勾（它自己卡在 `Depends: T085` → B-4）。这是**同一条依赖链上的第三个**「自身证据齐全、只差前置」的任务：

| | 自身 Expect | 阻塞来源 |
|---|---|---|
| T085 | **一半无法验证** | 缺证据 + B-4 |
| T086 | 四条全部实测通过 | 仅 `Depends: T085` |
| T087 | 四项全部实测通过 | 仅 `Depends: T086` |

链条底部是 B-4（GitHub 发布环境配置）。**T086 与 T087 是否按「实质通过、仅形式依赖未满足」一并勾上，是产品所有者的决定**，说一句即可。默认保持未勾。

## 八、演练留下的东西：全部已清理

| 创建的东西 | 状态 |
|---|---|
| 临时桶 `s7-drill-restore` + 19 个上传对象 | **已删**；开发项目桶列表回到 `["assets","exports","sources"]` |
| 隔离容器 `orincard-s7-drill` / `orincard-s7-drill2` | **已删** |
| `supabase db dump` 留下的 2 个 unhealthy 孤儿容器 | CLI 停止后自行退出，**已不存在** |
| 你的本地 Supabase 栈（9 个容器） | **未触碰**，全部 healthy；只以只读方式借用其 `pg_dump` |
| 开发库数据 | `assets` 仍为 25 ready / 12 deleted / 1 failed；预算行仍为 `10000000 / 0 / 1254410` |

备份产物（含真实数据库 dump 与 19 个对象）只落在 `/tmp/s7/`，**未入仓**。

## 九、本步花费

**$0.00。** 没有调用任何 AI 供应商，没有新建 Supabase 项目，没有触碰生产。全部是只读 dump、Storage 读写（临时桶已删）和本机容器。
