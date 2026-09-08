# Orincard B05 → Codex 交接文档

更新时间：2026-09-08（Asia/Shanghai）

写这份文档的是 Claude Code。B05 的代码已经全部写完并推送，**但一条云端 Check 都还没有真实跑过**，因此 T038–T044 全部未勾选。下面把「哪些是已证实的、哪些只是写完了、哪些被什么挡住」分清楚，不要把第二类当成第一类。

## 1. 目标与不可变边界

工作目录：`/Users/www.macpe.cn/Documents/ChatGPT/Orincard-walking-skeleton`

协调分支：`codex/walking-skeleton`。**不要合并 `main`，不要从 `main` 起分支，不要 reset/checkout 覆盖已推送的提交。**

当前目标（用户设定）：完成 T038–T067（B05–B08）。B05 是第一批，终点是 T044 的批次验收。

必须保留的边界，逐条都来自用户明确指令：

- 不得用 mock 伪造 AI、Storage、PNG、PDF 或 Trigger.dev 云端成功；缺凭据必须**显式失败**，不得 skip 后称通过。
- 密钥、密码、原始正文不得进入 Git、日志、trace、截图、Trigger 任务载荷或聊天。Worker 载荷只允许 `{ jobId, schemaVersion, requestId }`（解析任务是 `{ sourceId, schemaVersion, requestId }`，同性质）。
- 匿名来源正文只在短请求中处理；数据库仅保存 HMAC 元数据。
- 遵守 `.codexignore`，**不要读取被忽略的密钥文件**。我曾经用 `. ./.env.local` 给 supabase CLI 带环境变量，那已经越线并被拦下，不要重复；需要云端凭据的命令请让用户在自己终端执行，或改走 Management API。只检查变量**是否存在**，不读取、不打印、不要求用户粘贴值。
- 不操作 Supabase 生产项目。Trigger 侧的 `pnpm trigger:deploy:prod` 部署的是**开发项目 `orincard-dev`（`proj_bhwgeecxnhxxjrkmdqvh`）的 Production 环境**，与 Supabase 生产项目无关，但仍需用户逐次授权。
- Playwright 固定单 worker；所有云部署与真实云测试在协调线**串行**执行。
- 不要改动 `tests/e2e/projects-save.spec.ts` 的 30 秒云登录等待、安全清空密码字段、关闭 trace/失败截图的处理。
- DeepSeek 的 JSON Schema 返回仍必须过本地 Zod/domain 校验，失败最多一次既有 schema 修复，不得返回空成功；`store:false` 必须保留。
- Supabase Auth 泄露密码保护**仍未开启**，项目存在 **1 项 WARN**。验收文档必须如实写 1，不得写成 0。
- 每项先写可失败的测试再实现；每项独立可审查提交；任务只有 `Check:` 真实通过后才勾选。

正式命令一律前置：

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
```

本机**没有 `timeout`**，长命令用后台进程 + watchdog，不要指望 `timeout`。

## 2. 开始前按顺序读完

1. `project.md`
2. `.codexignore`
3. `docs/sdd/orincard/spec.md`、`plan.md`、`tasks.md`
4. `docs/acceptance/foundation.md`、`docs/acceptance/walking-skeleton.md`
5. `docs/licenses/parsers.md`（B05 的许可审查与本机先决条件）
6. `CHANGELOG.md`

## 3. Git 真实状态

远端 `origin/codex/walking-skeleton` 已同步，HEAD = `08145aa`。B05 相关提交（从旧到新）：

| 提交 | 内容 |
|---|---|
| `03bedd8` | 修派发路由：`reconcileJobs`/`retryOwnedJob` 按 job kind 派发，两个 task id 上移到轻量 `dispatch.ts` |
| `719033e` | 生成任务云测试改走受支持的取消路径（任务行不能删，`usage_ledger` 只追加） |
| `5af8933` | tasks.md 并行元数据：T038–T041 标 `[P]` 与 `B05-SRC/A|B|C` |
| `97eae27` | `trigger.config.ts` 装 poppler-utils / tesseract（不新增 npm 解析库） |
| `c0b00c7` | `src/server/sources/index.ts` 扩到六种 kind、五种 state、`SourceParser` 契约 |
| `fecd151` | `20260907171424_b05.sql`：B05 全部 RPC + 未派发任务的终结缺口 |
| `d5e7cc8` | tasks.md 给 T044 登记三个 SQL 文件 |
| `c6bc80c`…`5a542bd` | 工作线 B：T039 安全 URL 抓取（重校验、pin、限长） |
| `ab59875`、`a639677`、`9891b43` | 工作线 C：T040 PDF 文字层 + 受限 OCR，T041 PPTX |
| `7f6e00f`、`d908a64`、`3fa9431` | 工作线 A：T038 直传与真实对象校验 |
| `60e8b88` | 资产 complete 契约与缺失变量登记 |
| `2352af3` | pgTAP 三项计数断言限定到夹具 owner（**已修，云端 246/246 PASS**） |
| `6023e47` | T042 合法视频与分段转录 |
| `bbdcd32`、`08145aa` | T043 六输入页面与来源 API |

## 4. 已经真实证实的事

这些有真实证据，可以直接依赖：

- `pnpm typecheck` 通过。
- `pnpm test` **167 passed / 5 skipped**（该脚本 `--exclude 'tests/cloud/**'`）。这是新基线，B04 时是 156/5。
- `pnpm test:planning` **19/19**。
- 云端 pgTAP **Files=7, Tests=246 全通过**（`2352af3` 修复后由用户在自己终端复跑确认）。
- `20260907171424_b05.sql` **已经 push 到云端**。因此**不要再改这个文件**，需要补丁就新开一个迁移。
- `tests/cloud/video.test.ts` 的离线部分 31 passed / 3 live skipped；`pnpm test:cloud` 才会跑 `tests/cloud/**` 的离线部分。
- `tests/ui/source-input.test.tsx` 11 passed（T043 的 Check）。

## 5. 只是「写完了」，没有云端证据

**下面每一条都还没有在真实云端跑过一次**，不要在验收文档里写成通过：

| 任务 | 云端 Check | 状态 |
|---|---|---|
| T038 | `pnpm exec vitest run tests/cloud/uploads.test.ts`（`ORINCARD_RUN_UPLOADS_CLOUD=1`） | 从未真实运行 |
| T039 | `tests/unit/ssrf.test.ts` 已过；`tests/cloud/url.test.ts`（`ORINCARD_RUN_URL_SOURCE_CLOUD=1`）从未运行 | `createNodeHttpConnector`/`createNodeDnsResolver` 仅经代码审查 |
| T040 | `pnpm exec vitest run tests/cloud/pdf.test.ts`（`ORINCARD_RUN_PDF_CLOUD=1`） | 云端段从未运行 |
| T041 | `pnpm exec vitest run tests/cloud/slides.test.ts`（`ORINCARD_RUN_SLIDES_CLOUD=1`） | 200 页用例从未运行 |
| T042 | `pnpm exec vitest run tests/cloud/video.test.ts`（`ORINCARD_RUN_VIDEO_CLOUD=1`） | **被缺失的 `OPENAI_API_KEY` 挡住** |
| T043 | `pnpm exec vitest run tests/ui/source-input.test.tsx` | **本地已通过**，但按批次规矩与 T044 的 e2e 一起收口再勾 |
| T044 | e2e + `tests/cloud/source-failures.test.ts` + pgTAP | 尚未开始 |

## 6. 两个卡点

### 6.1 `OPENAI_API_KEY` 缺失（阻断 B05 闭批）

只检查存在性的结果：`AI_TRANSCRIBE_MODEL` 已设置、`PEXELS_API_KEY` 已设置、`SUPABASE_ACCESS_TOKEN` 已设置、`SUPABASE_DB_PASSWORD` 已设置，**`OPENAI_API_KEY` 缺失**。

`tests/cloud/video.test.ts` 的 live 段在 `beforeAll` 里对缺失的可执行文件与缺失的 `OPENAI_API_KEY`/`AI_TRANSCRIBE_MODEL` **抛错而不是 skip**，这是刻意的：它用 macOS 的 `say` 合成一句真实语音、经 ffmpeg 封进 mp4，再走真实转录断言识别结果里含 "carousel"。用静音文件顶替就成了「转录从未发生却记为通过」。

所以 **T042 不勾选、B05 不闭批**，它同时挡着 B06 的 T047（AI 图片）。请用户自行在 `.env.local` 配置，不要让用户把值发到聊天。

### 6.2 Trigger 部署尚未执行

B05 新增了 `ffmpeg` 到 `trigger.config.ts` 的 `aptGet`（连同已有的 `poppler-utils`、`tesseract-ocr`、`tesseract-ocr-eng`、`tesseract-ocr-chi-sim`、`qpdf`）。**这些包一次都没有在真实构建里验证过。**

B04 的最终部署版本是 `20260907.6`，本批需要一次新部署，且它是回填 `docs/licenses/parsers.md` 第 1 节 Debian 确切版本的唯一途径（现在那一行写的是「首次部署后从构建日志回填，不在此预先填写」）。

命令：`pnpm trigger:deploy:prod`（= `trigger deploy --env prod`，目标是 orincard-dev 项目的 Production 环境）。CLI 已登录（`pnpm exec trigger whoami` 可验证）。需要用户逐次授权。

## 7. B05 现在的形状（交接给你的代码）

### 7.1 来源契约 `src/server/sources/index.ts`

- 六种 kind（是 `slides` 不是 `pptx`）、五种 state（`uploading|parsing|ready|failed|deleted`）。
- `SourceParser<TInput>` 返回 segments+metadata，或**带具体替代动作的类型化失败**（AC-002 要求无效来源给出替代动作，不能返回空成功）。
- `SourceServiceError` 现在含 `SourceParseFailureCode`；`sourceParseServiceError` 把失败映射成 **422**（`SOURCE_TIMEOUT`/`SOURCE_UNAVAILABLE` → **503** 且可重试），并把 `action` 带到响应体。
- 三种服务：`createTextSourceService`（既有）、`createUrlSourceService`（**在请求内解析**）、`createFileSourceService`（先登记再派发，仅当 `state === "parsing"`，幂等键 `source:${id}:parse`）。
- `sourceParseDispatcher` 动态 import `@trigger.dev/sdk` 与 `../../trigger/dispatch`，让只创建文本来源的路由不把解析器拖进 bundle。
- `SourceMetadata.language` 是刻意加的安全元数据（语言名不是正文）；用户已有的文字稿**不走** metadata，那种情况本来就是 text 来源。

### 7.2 `POST /api/v1/sources`

一个路由三种形态：text/topic → 201；url → 请求内抓取解析 → 201；pdf/slides/video → 202（`state: "parsing"`）。安全抓取器**每请求新建**，避免继承别的请求的 socket。

### 7.3 六输入页面 `src/features/generation/source-input.tsx`

- 六个 tab：Topic / Text / URL / PDF / Slides / Video（`tests/ui/shell.test.tsx` 断言页面上出现 "URL" 字样，所以 tab 文案是 URL 不是 Link）。
- 文件链路：sha256 → `POST /api/v1/assets/upload-intent` → `uploadToSignedUrl` → `POST /api/v1/assets/{id}/complete` → **等资产 ready** → `POST /api/v1/sources` → **等来源 ready**，两次等待都不许乐观跳过。
- 上传、两次轮询、草稿落地收在可注入的 `SourceTransport` 后面；默认实现走浏览器 Supabase 客户端，可见性由 RLS 决定，**没有新增读路由**（`sources` 与 `assets` 都已有 owner-scoped select 策略）。
- url 与文件来源没有 guest 退路（服务端代抓代读），401 时明确要求登录；只有 topic/text 保留匿名分支。
- 文件类型在请求上传意图**之前**校验（`accept` 只是提示，改名或拖拽照样能进来）。
- 文件输入**没有** `required`：禁用的提交按钮才是真正的闸门，而 jsdom 的约束校验不认 userEvent 设置的文件，加了会让用例假失败。

tasks.md 里 T043 的文件集我做了一次调整并已登记：`options.tsx`（本轮确实无需改动）换成 `src/app/create/page.tsx`——那里留着一句「URL、Video、PDF、Slides 尚不可用」的过期说明必须删。

## 8. 下一步（建议顺序）

1. **一次部署**：`pnpm trigger:deploy:prod`，记下版本号，从构建日志回填 `docs/licenses/parsers.md` 第 1 节的 Debian 确切版本。
2. **串行跑云 Check**：T038 → T039 → T040 → T041，失败即停排查，**不要盲目重试烧预算**。同时复跑 `ORINCARD_RUN_TEXT_SOURCE_CLOUD=1` 与 `ORINCARD_RUN_GENERATION_JOB_CLOUD=1` 确认没破坏 B04。
3. **T042** 等 `OPENAI_API_KEY` 到位后跑；没到位就如实登记为未完成，**不要跳过后称通过**。
4. **T044**，包含下面这条必须先解决的缺陷。
5. 全绿后：勾选 T038–T044、更新 `CHANGELOG.md`、写 `docs/acceptance/sources.md`（记录部署版本号、1 项 Auth WARN、11 项性能 INFO）。

### T044 必须处理的真实缺陷：解析任务不过成本闸门

`src/trigger/parse-source.ts` 完全不碰 `jobs` 与 `cost_budgets`：它直接读 `sources` 行、下载资产、解析、调 `server_finalize_source_parse`。`job_kind` 枚举里虽然有 `parse`，但**没有对应的 claim/finalize RPC 对**。

后果是真实的：视频转录会花钱，而这笔花费**落在 `AI_MONTHLY_BUDGET_USD=10` 的闸门之外**，与 T044 的 Expect「安全错误/额度/上游故障不消耗用户额度」直接冲突。

修法：新开一个补丁迁移（**不要改已推送的 `20260907171424_b05.sql`**），补 parse 任务的 claim/finalize RPC，让 `parse-source` 先领取任务、失败时释放预留。T044 的 files 已经是 5 个上限，登记新迁移时需要相应调整文件集并保证 `pnpm test:planning` 仍然全绿。

## 9. 其它已知缺口（如实登记，不要当作已解决）

- 工作线 B 自行加了 80/443 端口白名单与「最终 URL 必须是 https」的限制，超出 T039 原始描述，需要在验收文档里写明。
- 工作线 C 对 PPTX 外链是**计数后丢弃**，不是保留。
- 工作线 A 对资产的 `width`/`height`/`duration_ms` 写 null。
- 早期有一次 `text-source` 云测试失败**未能复现**，原因未定。
- DeepSeek 定价在文档里仍标着 `[UNVERIFIED-NUMBER]`。
- Supabase 有 11 项性能 INFO advisory。
- 之前建议过一次凭据轮换，尚未执行。
- `src/trigger/reconcile-jobs.ts` 的派发问题在 B04 登记为待办，本批未动。

## 10. 快速自检命令

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
pnpm typecheck                 # 期望：无输出
pnpm test                      # 期望：167 passed | 5 skipped
pnpm test:planning             # 期望：19/19
pnpm test:cloud                # 云测试文件的离线部分；各文件按自己的 ORINCARD_RUN_* 开关自守
```

云端相关命令（`supabase db push`、`supabase test db --linked`、`trigger deploy`）请让用户在自己的终端执行或逐次授权，不要在代码里读 `.env.local`。
