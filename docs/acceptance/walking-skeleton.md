# B04 第一条真实小闭环验收记录

状态：`PASS — B04 T027–T037 全部验收完成`

记录日期：2026-09-08（真实云端证据采集于 2026-09-07 至 2026-09-08）

闭环范围：`Topic/Text → DeepSeek 真实生成 → 编辑 → 注册保存 → 删除本地库并刷新恢复 → 真实 PNG/PDF 导出与授权下载`。全部结果来自真实云端调用，未使用任何 mock 替代 AI、Storage、渲染或 Trigger.dev。

## 云端环境

| 项 | 真实值 |
|---|---|
| Supabase 项目 | `orincard-dev` / `ettuzeunkadkfnawawdy`，`us-east-2` |
| 本批次迁移 | 仅应用 `20260907002243_b04.sql`；应用后云端账本 4/4，`exports` 表由 404 变为可用 |
| 生产项目 | 全程未接触；`APP_ENV=development` 下未设置 `SUPABASE_PRODUCTION_PROJECT_REF` |
| Trigger 项目 / 环境 | `proj_bhwgeecxnhxxjrkmdqvh` / 专用开发项目的 Production 环境 |
| 最终部署版本 | `20260907.6`（本记录的 5 条云测试全部在该版本上复跑通过） |
| 文本 AI | DeepSeek `deepseek-v4-pro`，经 OpenAI Node SDK 调用 `https://api.deepseek.com` 的 Responses API |

## 真实云端测试结果

5 条云测试按协调线串行执行，均在最终部署版本 `20260907.6` 上通过。

| 测试 | 真实结果 |
|---|---|
| `tests/cloud/text-source.test.ts` | 10/10 通过（`ORINCARD_RUN_TEXT_SOURCE_CLOUD=1`）；匿名正文只在短请求中处理，数据库仅保存 HMAC 元数据 |
| `tests/cloud/generation.test.ts` | 7/7 通过（`ORINCARD_RUN_GENERATION_CLOUD=1`）；真实 DeepSeek 结构化返回通过本地 Zod/domain 校验 |
| `tests/cloud/generation-job.test.ts` | 19/19 通过（`ORINCARD_RUN_GENERATION_JOB_CLOUD=1`）；Supabase 任务 → Trigger worker → DeepSeek → 4 页文档落库 |
| `tests/e2e/text-generation.spec.ts` | 3/3 通过（`ORINCARD_RUN_TEXT_GENERATION_E2E=1`，Playwright 1.57.0 单 worker）；匿名 Topic 与注册 Text 两条真实生成路径 |
| `tests/e2e/walking-skeleton.spec.ts` | 1/1 通过，耗时 2.4 分钟；完整闭环含删除本地 IndexedDB 后刷新恢复、真实导出、授权下载与未认证下载被拒 |

### `store:false` 结论

计划中列为最高风险的「DeepSeek 可能拒绝 `store:false`」未发生。真实调用接受该参数，约束按原样保留，未做任何放宽。

### 移除 `strict` 后的结构合规

DeepSeek 的 `json_schema` 只接受 `name` 与 `schema`，不发送 `strict`。本地 Zod/domain 校验是唯一防线，一次有界 schema 修复保留。上述真实生成全部一次通过本地校验，未观察到返回空成功。

## 产物证据

来自最终通过的 `walking-skeleton` 运行，导出清单由云端任务写入 `exports.manifest`，数字未经本地改写。文档哈希 `a88d64273068c9cae45ff756353e52c42101d488bc2213dc05d992b8ce605ad5`，渲染器 `b04-v1`，画布 1080×1350，4 页。

| 产物 | 字节数 | SHA-256 |
|---|---|---|
| `01.png` | `142931` | `07ee359030218312e032b26509d56261145d1009be8cf114c5c4817359a35c97` |
| `02.png` | `86199` | `6378f1eb0c6034de46d0cc7db48c67ce4a5100771721533416797fa72d95d923` |
| `03.png` | `84359` | `8c914f916d40fc3f3472b9c21faee8333f7e5b2bd628a8f5c4e9ea8a9e7ee8a8` |
| `04.png` | `96507` | `1b7724472494b5d783653068f99a2943f66d3cd8c531de746ef8e61c9beac5fd` |
| `orincard.pdf` | `207581` | `b02cd6eaa3d2c64a71413a412aa0913c7963cf2f32e9323239bc4b87df4eb141` |

测试在字节层面复核了真实文件：PDF 首 5 字节为 `%PDF-`，ZIP 内 4 个 PNG 首 8 字节均为 `89504e470d0a1a0a`，下载字节数与授权接口返回的 `bytes` 一致。未认证客户端下载同一对象被拒绝。

| Trigger run | 任务 | 状态 |
|---|---|---|
| `run_06g7p574vge5uudqb4f9lrm701` | `orincard-basic-export` | COMPLETED（`20260907.6`） |
| `run_06g7p56vnss3lncp88jk2sjc01` | `orincard-basic-export` | COMPLETED（`20260907.6`） |

产物对象与项目行在测试的 `finally` 中已清理；上述数字取自保留下来的导出清单行，未提交任何二进制产物、临时文件、密钥或日志。

## 本批次发现并修正的真实缺陷

全部为真实运行暴露的问题，均先定位真实根因再修复，未放宽断言、未加 mock、未跳过测试。

| 缺陷 | 根因 | 修复 |
|---|---|---|
| 生成任务全部失败为 `SOURCE_UNAVAILABLE` | `server_claim_generation_job` 是集合返回函数，supabase-js 返回行数组，`claim` 却按对象读取，`job_id` 为 `undefined` 触发守卫，随后 `fail(undefined, ...)` 抛错掩盖了原始错误 | `src/trigger/generate.ts` 按数组解包首行；先补两条失败单测（数组映射、空结果视为无可领取工作）再修复 |
| 导出预检 503 `SERVICE_UNAVAILABLE` | Turbopack 把 `require.resolve` 的字面量说明符改写成打包模块 id，`readFile` 无法打开，字体加载失败；`responseError` 又吞掉了真实异常 | `src/render/render-deck.ts` 用运行时路径播种 `createRequire`，使打包器不再识别该模式，字体仍从磁盘读取以保留版本与 SHA-256 校验 |
| 导出任务在 Trigger 容器失败 `ENOENT .../src/trigger/slide.css` | 打包后 `import.meta.url` 指向入口目录而非 `src/render`，且样式表本身不在产物中 | render-deck 改为从 `process.cwd()` 解析样式表；`trigger.config.ts` 增加 `additionalFiles` 把 `src/render/slide.css` 打进容器 |
| `text-generation` 注册用户流程稳定失败 | 断言只给 15 秒，而真实云端下 `POST /api/v1/sources`（3.0s）加 `POST /api/v1/generation`（12.0s）恰好耗尽该窗口，进度组件还需一次轮询才脱离 `Starting generation…` | 该条断言超时改为 60 秒并写明实测依据；断言内容不变，仍要求进度 UI 在跳转编辑器前真实出现 |
| `walking-skeleton` 最终恢复断言必然失败 | `toMatchObject` 按长度比较数组，`slides: [{ title }]` 无法匹配 4 页文档；该断言此前从未被真实执行过 | 改为直接校验 revision、页数为 4、首页标题等于编辑后的 headline，强度高于原断言 |
| `text-source` 云测试偶发 15 秒超时 | 该条是仓库中唯一没有显式超时的云测试，落回 15 秒全局默认，而真实往返实测 9.3–59 秒 | 补上 60 秒显式超时，与其余云测试一致 |

`POST /api/v1/generation` 的约 12 秒耗时经排查为真实云端串行往返（Supabase 认证与三次查询/RPC，加 Trigger 派发实测 0.4–3.7 秒），非开发服务器冷编译，也非代码缺陷；此处如实记录，未做超出 B04 范围的接口改造。

## 最终门禁

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | 17 个文件、114 项通过、5 项显式云/DB 测试按设计跳过（与 B03 基线一致） |
| `pnpm test:planning` | 19/19 通过 |
| `pnpm build` | 通过 |
| `pnpm exec supabase test db` | 6 个文件、191/191 通过；`Result: PASS` |

## 已知限制

| 项 | 说明 |
|---|---|
| Supabase Auth 安全顾问 | 仍为 **1 项 WARN**：泄露密码保护未启用。作为生产前安全配置项保留，不阻断本批次 AC，不得记为 0 项 |
| 性能顾问 | 11 项 INFO，均为空库下新索引尚未被使用；索引对应已批准的查询、外键或 TTL 清理路径，待真实负载复核 |
| `reconcile-jobs` 派发错误 | `src/trigger/reconcile-jobs.ts` 向 `reconcileJobs` 传入 `triggerDispatcher`，它触发的 `orincard-job-dispatch` 只做校验并返回 `{ accepted: true }`，因此停滞的生成任务无法被真正重新派发。该文件不在 T029 声明的文件清单内，属 B03 任务基础设施，且不影响 B04 正常路径（正常路径使用 `generationTriggerDispatcher`）。本次未修，登记为待办 |
| 生成任务云测试不清理 | `tests/cloud/generation-job.test.ts` 创建的任务不做清理；在每用户并发上限为 1 的约束下，一次失败运行会持续占用名额并让后续运行返回 `CONCURRENCY_LIMIT`。本次曾据此把残留任务置为 `canceled`，未级联删除双账 `usage_ledger` |
| `text-source` 一次未复现的失败 | 在最终版本复跑序列的首次执行中出现 1 项失败，随后连续 10 次全部 10/10 通过，未能复现，原始输出未保留，根因未确认。如实记录，不声称已解决 |
| DeepSeek 成本数字 | 官方定价页在本环境被网络策略拦截，未能核实；`plan.md` 与 `research.md` 中相关金额保留 `[UNVERIFIED-NUMBER]` 标注，待按真实用量复核 |
