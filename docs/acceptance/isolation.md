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

真实云端结果由协调线在跑完后补写。
