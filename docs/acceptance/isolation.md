# T092 跨账号与故障幂等矩阵

## 已实现行为

`tests/cloud/security-matrix.test.ts` 在真实开发 Supabase 上断言七条矩阵。它不接受任何 mock 顶替云端成功：断言全部来自真实 RLS 策略、真实服务端 RPC、真实 Storage 对象，以及生产代码里的导出授权实现 `createSupabaseExportDownloadStore`。

用例在 `beforeAll` 里用第二个测试账号登录，用 service_role 造一份真实夹具：`server_create_project` 建两个项目，`server_create_exports` 建真实任务与导出记录，把一个真实对象上传到 `exports` 桶并登记 `assets` 行，再把导出记录置为 `ready`。`afterAll` 删除导出记录、素材行、Storage 对象与任务行，并把两个项目置为 `deleted`。

| 矩阵项 | 断言的已实现行为 |
|---|---|
| 盗 ID | 另一账号拿到真实 `projectId`、`exportId`、`assetId` 与真实对象键后，`projects`、`project_versions`、`exports`、`assets` 四张表读回空集；`createSupabaseExportDownloadStore` 对它返回 `NOT_FOUND` 404，即使同时报出真实 `ownerId` 也一样；Storage 直下载被拒。同一时刻所有者本人读得到、下得到，作为阳性对照 |
| 改 owner | 另一账号改 `owner_id`、改 `title` 均报错；所有者本人改自己项目的 `owner_id` 也报错（`authenticated` 只有 select 授权）；登录用户直调 `server_save_project` 报错（RPC 只授予 service_role）；service_role 身份下用错误的 `p_owner_id` 保存他人项目同样失败。事后对比 `owner_id`、`revision`、`title` 三列未变 |
| 过期 JWT | 伪造的过期令牌被 `auth.getUser` 拒绝；带该令牌直接请求 Data API 返回 401，响应体不含项目 ID 与标题；仅带 publishable key 的匿名请求读不到该行。该令牌同时具备过期的 `exp` 与不可验证的签名 |
| 并发保存 | 两个不同幂等键、同一 `expected_revision` 的 `server_save_project` 并发发出，恰好一个成功、一个返回 `40001`；项目落到 `revision = 2`，`project_versions` 恰好两行（revision 1、2）；用胜出者的幂等键与请求哈希重放，回执原样返回，版本数不再增长 |
| 重复回调 | `server_register_billing_event` 首次返回 `true`、重复投递返回 `false`；`server_claim_billing_event` 首次拿到 `attempt = 1`，处理中重复领取返回空；`server_fail_billing_event` 后可再次领取且 `attempt` 递增到 2；未登记的事件调用 `server_apply_billing_event` 报错；登录用户直调回调登记 RPC 报错 |
| 未知上游状态 | 无法识别的 `subscription_status` 与无法识别的 `billing_plan_key` 都在写库前报错，事后 `subscriptions` 行与调用前逐列相同；上游拿着真实 `jobId`、`exportId`、`assetId` 但任务状态不匹配时，`server_finalize_export` 的绑定检查报错，`jobs.state` 与 `jobs.result_ref` 不变 |
| 删除后下载 | 项目转入 `deleted` 之前所有者授权成功；转入 `deleted` 之后同一 `exportId` 的授权返回 `NOT_FOUND` 404，`projects`、`exports`、`project_versions` 对所有者读回空集，Storage 对象下载被拒 |

前置条件由测试自己检查。打开开关但缺任一变量时，用例在 `beforeAll` 抛错并点名全部缺失变量，不会 skip 后当作通过；两个测试账号必须是不同的 `auth.users`，否则同样显式失败。

需要的变量：`NEXT_PUBLIC_SUPABASE_URL`、`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`、`SUPABASE_SECRET_KEY`、`ORINCARD_AUTH_TEST_EMAIL`、`ORINCARD_AUTH_TEST_PASSWORD`、`ORINCARD_AUTH_OTHER_EMAIL`、`ORINCARD_AUTH_OTHER_PASSWORD`。测试进程不读取任何 `.env` 文件，变量需在自己的终端里配置。

运行会在 `private.billing_events` 留下一行 `evt_t092_<runId>`，状态 `failed`、错误码 `T092_MATRIX`。该表位于 `private` schema，不经 Data API 暴露，测试不做清理。

## 验收命令

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
# 门禁（不触云端；pnpm test 按配置排除 tests/cloud/**）
pnpm typecheck
pnpm test

# 真实云端验收（开发项目，串行执行）
ORINCARD_RUN_SECURITY_MATRIX_CLOUD=1 pnpm exec vitest run tests/cloud/security-matrix.test.ts
```

## 真实云端结果 — 2026-09-10 Blocked

### 第一次尝试：缺凭据，未取得任何证据

用例按设计在 `beforeAll` 显式失败并点名缺失变量，`Test Files 1 failed (1)`、`Tests 7 skipped (7)`：

```
ORINCARD_RUN_SECURITY_MATRIX_CLOUD=1 requires development variables:
ORINCARD_AUTH_OTHER_EMAIL, ORINCARD_AUTH_OTHER_PASSWORD
```

开发环境里这两个变量名存在但值为空。`tests/cloud/ownership-smoke.test.ts` 用同一对变量名，因此同样从未真实跑过。

### 第二次尝试：凭据补齐后真实执行，4 项失败

`ORINCARD_AUTH_OTHER_*` 已指向 `ORINCARD_AUTH_SECONDARY_TEST_*` 的账号。改指向前先验证过该账号能真实登录，且其 `auth.users.id` 与 `ORINCARD_AUTH_TEST_EMAIL` 的不同——用例自身的「两个账号必须不同」检查也随之通过。

真实执行结果：`Tests 4 failed | 3 passed (7)`，261.75s。通过的是项 1（盗 ID）、项 3（过期 JWT）、项 5（重复回调）。**这不是通过，T092 在 tasks.md 保持未勾选。**

失败分两类，均已定位到根因。

#### 缺陷 A — `40001` CAS 冲突导致 Data API 请求永不返回（项 2、4、6）

`private.save_project`（`supabase/migrations/20260906000100_walking_skeleton.sql:1198-1238`）在乐观并发冲突时执行：

```sql
raise exception using errcode = '40001', message = 'project revision conflict';
```

`40001` 是 `serialization_failure`。PostgREST 把它当作瞬时冲突自动重试，而 revision 不匹配是**确定性**的，重试永远不会成功，请求因此永不返回。

HTTP 层实测（同一夹具，三次调用）：

| 场景 | 结果 |
|---|---|
| owner 不匹配（抛 `40001`） | `http=000`，40 秒 max-time 打满，无响应 |
| revision 不匹配（抛 `40001`） | `http=000`，同上 |
| 正常保存 | `http=200`，12.2s，`{"state":"draft","revision":2,...}` |
| owner 为不存在的 UUID（抛 `42501`） | `http=403`，4.0s，`{"code":"42501","message":"account is not active"}` |

数据库侧采样佐证：挂起期间 `pg_stat_activity` 中相关连接的 `query_start` 年龄始终为 `0.0` 秒，并伴有 `idle in transaction (aborted)` / `ClientRead`——是同一条语句被反复重启，不是单条慢查询，也不是锁争用。

这不是用例写错，而是产品自身乐观并发路径上的真实缺陷：两个标签页同时保存同一项目时，落败的那个请求不会收到冲突错误，而是一直挂着。

#### 缺陷 B — 已下载过的私有导出对象在项目删除后仍由缓存供给（项 7）

项 7 断言项目转入 `deleted` 后 `owner.storage.from("exports").download(artifact.objectKey)` 被拒，实测返回成功。

RLS 策略本身是对的。开发库上实际生效的 `storage_download_owned_exports` 与迁移一致，确实要求 `projects.state in ('draft','archived')`；`storage_download_owned_tool_outputs` 要求 `purpose='tool_output'`，与本夹具的 `purpose='export'` 不匹配，不参与判定；`exports` 桶为私有。

判别实验（同一项目下两个同样 `ready` 的导出对象）：

| 对象 | 删除前 | 删除后 |
|---|---|---|
| A（删除前已下载过一次） | OK 16 bytes | **OK 16 bytes** |
| B（从未下载过） | 未下载 | **DENIED (Object not found)** |

B 被立即拒绝，证明策略生效；A 仍可读，是缓存命中。项 7 之所以失败，是因为矩阵项 1 里所有者已成功下载过同一个 `objectKey`，项 7 复用该键时命中缓存——**用例的取证前提无法区分「策略失效」与「缓存命中」**。

项 7 中其余断言均已通过：`createSupabaseExportDownloadStore` 的授权在删除后正确抛 `NOT_FOUND` 404，`projects` / `exports` / `project_versions` 对所有者均读回空集。

附带的真实结论：已下载过的私有导出对象在授权撤销后仍会在缓存有效期内被供给。这是较低严重度的真实现象，需要单独记录，不应混入项 7 的断言。

### 解除条件

1. 缺陷 A 修复后重跑（需要为业务级 CAS 冲突改用不会被自动重试的 SQLSTATE；同时项 4 断言的期望错误码需一并更新）。
2. 项 7 改为对一个**从未下载过**的对象取证，或只对授权路径取证，以排除缓存干扰。

两项完成后重跑上面的验收命令，真绿才勾选。`ownership-smoke` 的凭据封锁已随本次配置一并解除。

## 真实云端结果 — 2026-09-11 通过（7/7）

缺陷 A 已修复并真实部署到开发库，项 7 的取证前提已改正。重跑结果：

```
ORINCARD_RUN_SECURITY_MATRIX_CLOUD=1 pnpm exec vitest run tests/cloud/security-matrix.test.ts
Tests  7 passed (7)
```

### 缺陷 A 的修复：`40001` → `PT409`

新迁移 `supabase/migrations/20260911000000_conflict_errcode_pt409.sql` 把 9 处业务级冲突的 `errcode` 从 `40001` 改为 `PT409`（`supabase/definitions/` 下 `projects.sql` 1 处、`jobs-usage.sql` 2 处、`b04.sql` 6 处，共 11 个函数、13 个 raise 点；改后全库 `'40001'` 为 0 处）。

选 `PT409` 的理由：PostgREST 把 `PTxxx` 形式的 SQLSTATE 直接翻译成「用这个 HTTP 状态码回答」，因此 revision 冲突现在以 `409` 立即返回，而不再被当成瞬时 `serialization_failure` 无限重试。`40001` 保留给真正的串行化失败——那是 Postgres 自己抛的，重试确实有意义。

应用侧新增 `src/server/db-errors.ts`：

```ts
export function isRevisionConflictCode(code: string | undefined): boolean {
  return code === "PT409" || code === "40001";
}
```

三个映射点（`src/app/api/v1/projects/[id]/exports/route.ts`、`src/server/project-library.ts`、`src/server/projects.ts`）改为调用它。仍认 `40001`，是因为一次真正的串行化失败对调用方意味着同一件事：你的写入没落地，拿最新版本重来。

迁移经 `supabase db push --include-all` 真实推送到开发项目 `ettuzeunkadkfnawawdy`。项 4 现在约 3–4.5 秒返回，此前会挂过 25 秒超时。

### 项 7 的取证改正

用例改为额外造一件**从未被下载过**的成品 `coldArtifact`，项 7 只对它取证；项 1 下载过的那件不再参与项 7 断言。两件成品的授权路径完全相同，唯一差别是有没有被任何一层缓存见过，因此 `coldArtifact` 的被拒只可能来自 RLS 判定本身。

### 保留的真实结论（未修，如实记录）

**已下载过的私有导出对象，在授权撤销后仍会在缓存有效期内被供给。** 上一节的判别实验（对象 A 已下载过 → 删除后仍 OK 16 bytes；对象 B 从未下载过 → 删除后 DENIED）就是它的证据。授权撤销本身是有效的；这是一个独立的缓存残留问题，严重度较低，**没有用一条断言把它固化成预期行为**。修复方向属于 Storage/CDN 缓存失效策略，不在 T092 范围内。

### 结论

T092 真实通过，可勾选。`tests/cloud/ownership-smoke.test.ts` 的凭据封锁已一并解除。
