# 交接文档：B06–B11（T045–T087）

写于 2026-09-10。上一份交接是 [b05-codex.md](b05-codex.md)（截至 T044 之前）。这份覆盖 Codex 在其之后独立完成的全部工作，直到额度耗尽为止。**Codex 本人没有写交接文档，本文由重新读取仓库真实状态得出，凡是无法从仓库或本地复跑证实的，一律标注为"未证实"，不做推断性结论。**

## 0. 不可变边界（继续全程适用，逐字保留）

- 正式检查显式使用：`export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`。本机无 `timeout`，长命令用后台 + watchdog。
- 遵守 `.codexignore`，不读取被忽略的密钥文件。**`.env.local` 属于 `.env.*`，禁止读取或 source。**（上一轮我本人违反过一次，已登记，不得重复。）
- 不得用 mock 伪造 AI、Storage、PNG、PDF、MP4、PPTX 或 Trigger.dev 云端成功；缺凭据必须显式失败并报告先决条件，禁止 skip 后称通过。
- 密钥、密码、原始正文不进 Git、日志、trace、截图、Trigger 载荷或聊天。Worker 载荷只允许 `{ jobId, schemaVersion, requestId }`（解析任务为 `{ sourceId, schemaVersion, requestId }`）。
- 匿名来源正文只在短请求中处理；数据库仅保存 HMAC 元数据。
- 需要用户在自己的终端安全配置 `SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_PASSWORD` 等；只检查变量是否存在，不读取、不打印、不要求粘贴值。
- 不操作生产项目，不合并 `main`。集成分支是 `codex/walking-skeleton`。
- Playwright 固定单 worker。所有云部署与真实云测试在协调线串行执行。
- DeepSeek 结构化返回仍必须经本地 Zod/domain 校验；失败最多一次既有 schema 修复，不返回空成功。`store:false` 必须保留。
- **Supabase Auth 泄露密码保护仍未开启，项目存在 1 项 WARN；验收文档必须如实保留，不能写成 0 项。** Codex 在 `docs/acceptance/sources.md` 中已正确保留这一项。
- 本会话挂载的 Supabase MCP 指向 `ngilnscjerbziemomxnl`，**不是** orincard-dev `ettuzeunkadkfnawawdy`。**不要用 MCP 工具操作本项目**，改用 Management API 或 Supabase CLI。

## 1. 真实 Git 状态（已复核）

```
分支    codex/walking-skeleton
HEAD    eff80dc  T087 add isolated backup recovery checks
状态    工作区干净；相对 origin/codex/walking-skeleton **ahead 1**（eff80dc 未推送）
自上份交接（8fe466d）以来：76 个提交
```

`eff80dc` 内容：`docs/runbooks/recovery.md` +13、`scripts/backup.mjs` +55、`scripts/restore-check.mjs` +29、`tests/cloud/backup.test.ts` +37。纯新增，无删改。**下一位接手者第一件事：确认后 `git push`。**

分支侧还残留大量已合并的工作线分支（`codex/b06-*` 3 条、`codex/b07-*` 7 条、`codex/b08-*` 8 条、`codex/b09-*` 6 条、`codex/b10-*` 7 条、`codex/b11-*` 6 条）。它们已 `--no-ff` 并入集成分支，可择期清理，**不要 reset 或覆盖集成分支**。

## 2. 任务进度

`docs/sdd/orincard/tasks.md`：**82 项已勾选 / 95 项**，13 项未勾选。

| 未勾选 | 状态判定 |
|---|---|
| T073 支付生命周期验收 | **实现完成，验收被阻塞**（缺 Stripe 测试 Price 映射与 Sandbox 显式启用） |
| T084 增长闭环验收 | **实现完成，付费链路验收被阻塞**（缺真实 Sandbox 生命周期） |
| T085 分环境 CI 与受控发布 | **代码已落地，Check 本地通过，但从未真实运行过一次 CI 或 Vercel 发布** |
| T086 预算/到期清理与监控 | **代码已落地，Check 本地通过，但用注入适配器，无真实云端证据** |
| T087 备份与隔离恢复 | 同上；恢复演练需要一个全新的隔离 Supabase 项目，尚未执行 |
| T088–T089（B11 尾） | 未开始 |
| T090–T095（B12 全量验收矩阵） | 未开始 |

T085/T086/T087 未勾选是**正确的诚实判断**，不是遗漏 —— 它们的 `Expect` 要求真实发布、真实到期清理与真实隔离恢复，而目前只有本地断言。不要因为"测试绿了"就补勾。

## 3. 本地门禁（我已在 Node 22 下实际复跑）

```
pnpm typecheck                 exit 0
pnpm test                      37 个文件，225 passed | 7 skipped，exit 0
pnpm test:planning             19 pass / 0 fail
pnpm exec vitest run tests/unit/deployment.test.ts tests/cloud/backup.test.ts tests/cloud/operations.test.ts
                               3 文件 / 11 passed（347 ms —— 全部为本地断言，未触云端）
```

最后一条的耗时本身就是证据：`tests/cloud/backup.test.ts` 与 `tests/cloud/operations.test.ts` 虽在 `tests/cloud/` 目录下，实际是**纯逻辑测试**（注入 `database`/`storage`/`RetentionStore` 适配器），不连接任何云资源。交接时必须知道这一点，否则会把它们误当成云端验收。

## 4. 已有真实云端证据的部分（来自 Codex 的验收文档，均已复核文字）

| 批次 | 真实证据 |
|---|---|
| B05 来源 | `docs/acceptance/sources.md`：PASS。Trigger 部署 `20260908.7`，补丁迁移 `20260908110457_b05_parse_budget.sql` 已应用（正是上一份交接指出的解析任务成本闸门缺陷）；b05 pgTAP 72/72；**保留 1 项 Auth WARN、9 项性能 INFO**；无字幕视频改用真实豆包录音文件识别 2.0 异步转写 |
| B06 素材与品牌 | `docs/acceptance/assets.md`：PASS，2026-09-09。图片供应商为 **APIMart GPT-Image-2**，最低成本 `1k` / `1:1`。Pexels 真实导入、隔离截图真实 PNG、跨账号隔离、Brand Kit 应用/复制/删除影响清单全部通过，Playwright `1 passed (2.8m)`。已修：代理未继承、`projects.brand_kit_id` 未同步（迁移 `20260909090000`）、AI 图片预算原子化（`20260910090000`） |
| B07 导出与恢复 | `docs/acceptance/b07.md` + `pptx.md` / `mp4.md` / `recovery.md`：真实持久 PPTX 与 MP4 产物（Trigger `20260909.8`），PowerPoint 16.109.1 打开 6 页成功；`ffprobe` 验证 1080×1350 H.264。**Keynote 14.4 自动化导入超时，明确记为兼容性限制而非通过。** T059 分阶段删除跑在 `20260909.10`。T061 组合验收 2026-09-10 真实云端 `1 passed (4.2m)`，隐私契约 `2 passed` |
| B08 工具矩阵 | `docs/acceptance/tools.md`：Trigger `20260910.1`，迁移 `20260910130000_b08_tool_outputs.sql` 已应用，`tool-outputs.sql` pgTAP 10/10（本机直连为 IPv6-only，改走 IPv4 Session pooler） |
| B09 支付 | `docs/acceptance/billing.md`：迁移 `20260910160000_b09_billing.sql` 已应用，`billing.sql` pgTAP 27/27，Trigger `20260910.2` 部署成功 |

Codex 的记录风格是诚实的：阻塞就写阻塞，Keynote 不通过就不写通过，Auth WARN 保留为 1 项。**请延续这个标准。**

## 5. 三个明确的发布阻塞项（按优先级）

1. **四条视觉工具路由返回 `503 TOOL_UNAVAILABLE`**（`docs/acceptance/tools.md` 末段）。三条文本工具已由公开 API 派发，Quote Card / Infographic / Portrait / Carousel-to-Video 的 worker 部署尚未启用。候选渲染与供应商契约已本地验证，**真实视觉供应商验收是发布阻塞项**。这是 B08 唯一未闭合的口子。
2. **T073 支付生命周期**：缺 `STRIPE_TEST_MONTHLY_PRICES_JSON`（服务端持有的**测试** Price 映射）与 `RUN_STRIPE_SANDBOX_LIFECYCLE=1` 显式启用。升级/续费/失败扣款/期末取消/退款五条路径全部 Blocked。禁止用 live key 或 live Price。
3. **T084 付费推荐归因与佣金冲正**：依赖同一套 Stripe Sandbox 生命周期。当前 Affiliate 申请/看板浏览器测试用的是**受控路由 fixture**，Codex 已明确标注"不作为开发 Supabase 或支付供应商证据"。另：三份法务文档（Privacy / Terms / Affiliate）保持 `draft` + `noindex`，人工审核批准精确版本与内容哈希前不得发布。

## 6. 我在复核中发现、Codex 未登记的问题

1. **`CHANGELOG.md` 头部结构被破坏**：第 1 行 `# Changelog` 之后直接插入了一节 `## 2026-09-09`（Pexels 条目），把原本的说明段落 `Orincard 的重要变更记录在此文件中…` 挤到了它下面。应是某条工作线合并时的插入位置错误，需要修回。
2. **`CHANGELOG.md` 的 `### Completed` 只写到 B05**。B06–B11 共 40+ 项任务、五次 Trigger 部署、十余个迁移完全没有进入 CHANGELOG。B12 发布清单（T095）会要求这份记录齐全，越晚补越难还原。
3. **三个 growth 迁移没有任何"已应用到开发库"的书面记录**：`20260910124717_growth_affiliate_support.sql`、`20260910210000_affiliate_review_audit.sql`、`20260910211000_fix_referral_hash.sql`。提交 `469d74d Fix referral hashing in remote database` 暗示至少有一次远程应用，但**没有文档证据，我不把它算作已验证**。接手后请先核对开发库实际迁移列表再继续 B10。

## 7. 建议的下一步顺序

1. `git push`（1 个未推送提交）。
2. 修 CHANGELOG 头部结构，补写 B06–B11 的 `Completed` / `Verified` / `Known limitations`。
3. 核对开发库已应用迁移清单，把三个 growth 迁移的真实状态写进 `docs/acceptance/growth.md`。
4. 部署四条视觉工具的 worker，跑真实供应商验收，闭合 B08 的 `503 TOOL_UNAVAILABLE`（注意 APIMart 与 MP4 都消耗预算，按真实用量登记，超预算即停）。
5. 请用户在自己终端配置 Stripe **测试** Price 映射与 Sandbox 启用，再串行跑 T073 与 T084 的真实生命周期。
6. 之后才是 T088（许可与安全发布检查）、T089（发布/回滚演练），进入 B12。

## 8. 自检命令（接手第一步照此跑一遍）

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/www.macpe.cn/Documents/ChatGPT/Orincard-walking-skeleton
git status -sb
pnpm typecheck && pnpm test && pnpm test:planning
grep -c '^- \[x\]' docs/sdd/orincard/tasks.md   # 期望 82
grep -n '^- \[ \]' docs/sdd/orincard/tasks.md   # 期望 13 行，见第 2 节
```

预算提醒：`AI_MONTHLY_BUDGET_USD=10` 同时覆盖文本、转录、图片与 MP4。B08 视觉工具与任何 MP4 复跑是当前最烧钱的两处，失败不要盲目重试。
