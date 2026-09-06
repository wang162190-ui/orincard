# B01 技术地基验收记录

状态：`PASS — B01 T001–T006 全部验收完成`

记录日期：2026-09-05（云探针证据采集于 2026-09-04）

## 本地结果

| 检查 | 结果 |
|---|---|
| 固定运行版本 | 临时隔离的 Docker/Colima profile 使用官方 `node:22.23.2` 镜像，容器实际输出 Node `v22.23.2` 与 pnpm `10.32.1`；当前开发终端仍为 Node 24.14.0，不用本机结果代替精确版本验收 |
| 依赖解析 | Node 22.23.2 容器执行 `pnpm install --frozen-lockfile` 成功并确认 lockfile 无需更新；首闭环所需 IndexedDB、Testing Library/jsdom、dnd-kit、Supabase、Supabase CLI 与 OpenAI SDK 均为精确版本 |
| 类型检查 | Node 22.23.2 容器执行 `pnpm exec tsc --noEmit` 通过 |
| 单元测试 | `test:unit` 已改为收集 `tests/unit` 全目录；Node 22.23.2 容器 4 个文件、32 项通过，不再遗漏编辑器命令测试 |
| 规划测试 | Node 22.23.2 容器执行 `pnpm test:planning`：19 项通过；95 个任务、12 批、5 个最多三线的并行组、11 个 AC、48 条 API 路径有映射 |
| 字体资源 | Inter、Source Serif 4、Noto Sans SC 三个固定 WOFF2 均通过包版本与 SHA-256 校验 |
| 全量非云回归 / 构建 | Node 22.23.2 容器执行 `pnpm test` 为 44/44，通过 `pnpm build`；`/` 与 `/create` 静态预渲染 |
| 云端预检 | Trigger.dev CLI 4.5.16 登录成功；已创建专用 Free 项目 `orincard-dev` |
| Preview 取舍 | Trigger Free 方案支持 0 个 Preview branch，因此 B01 部署到专用开发项目的 Production 环境；不得把它当作未来正式生产项目 |
| 云端测试 | `RUN_CLOUD_PROBES=1 pnpm test:cloud`：3 个测试文件、3 项测试全部通过；密钥只注入测试进程，未写入文件或 Git |

## 已发现并修正的问题

| 本地复验 | 结果 |
|---|---|
| 原 `test:unit` 固定文件列表 | 只运行 setup/document/fonts，遗漏新增的 `tests/unit/editor-commands.test.ts`；已改为收集全部 `tests/unit` |
| 本机 Node 24 与目标不一致 | 创建隔离 Node 22.23.2 容器完成 frozen install、T002/T003/T005 定向测试、全单元、全非云回归、类型检查、规划检查和构建；据此完成 T001–T003/T005 验收 |

| 部署 | 结果 |
|---|---|
| `20260903.1` / `yg58aovg` | 失败；Node 22 构建已启动且 qpdf 安装步骤完成，但 Trigger.dev 4.5.16 的 Playwright 扩展无法解析 Playwright 1.62.1 改版后的 `install --dry-run` 输出 |
| 修正 | 将 `playwright`、`@playwright/test` 和构建扩展安装版本统一锁定为 1.57.0；该版本仍输出扩展需要的 `browser: chromium-headless-shell` 记录 |
| `20260903.2` / `gsl41h40` | 成功；专用开发项目的 Production 环境在 Node 22 运行时完成 Chromium、qpdf、任务依赖与索引构建 |

## 真实云端运行结果

同一个幂等云任务运行生成并返回全部产物；三个云测试分别验证渲染、可恢复性和地基冒烟，不以本地渲染替代。

| 检查 | 真实结果 |
|---|---|
| Trigger 项目 / 环境 | `proj_bhwgeecxnhxxjrkmdqvh` / 专用开发项目的 Production 环境 |
| Deployment / version | `gsl41h40` / `20260903.2`；配置与构建运行时为 Node 22 |
| Run | `run_06g6jhirrjap2onj2ch665dh01`；状态 `completed`；Attempt 1 完成 |
| Chromium | `143.0.7499.4`；真实 PNG 为 360×450，文件头、尺寸、字节数和 SHA-256 断言通过 |
| PDF | 1 页，文件头、页数、字节数和 SHA-256 断言通过 |
| PPTX | ZIP/XML 可读；`Orincard editable probe` 与 `This text must remain editable.` 均存在于 slide XML，确认文字可编辑 |
| qpdf 恢复 | `qpdf version 11.3.0`；附件名为 `orincard-project.json`，取回 JSON 与嵌入前逐字一致 |
| 任务输出耗时 / RSS | `2201 ms` / `145797120 bytes`（约 139.04 MiB） |
| 云测试 | `RUN_CLOUD_PROBES=1 pnpm test:cloud`：3/3 通过；最终复验耗时 4.15 秒 |

## 产物证据

| 产物 | 字节数 | SHA-256 |
|---|---|
| PNG | `14981` | `d361530ec93127d169ef27b79ae97143de1f013fc03d8e0abefbd94ec0ce7d23` |
| PDF（含恢复附件） | `18168` | `e6a164a0c86195109a8b555dc480bb821beed8e052bb32cc1800e17947d9bb39` |
| PPTX | `45836` | `d5552e9cad4da22a83b621f5fa747a056d9a5bfeae703f19f879920684b7febe` |

安全证据入口：[Trigger.dev run `run_06g6jhirrjap2onj2ch665dh01`](https://cloud.trigger.dev/projects/v3/proj_bhwgeecxnhxxjrkmdqvh/runs/run_06g6jhirrjap2onj2ch665dh01)。未提交 Base64 产物、临时文件、密钥或日志；以上数字由云任务输出返回，并由本地云测试对解码后的真实文件复核。

## B02 编辑器地基验收

状态：`PASS — B02 T007–T014 全部验收完成`

记录日期：2026-09-05

| 检查 | 真实结果 |
|---|---|
| T010 草稿 | 13/13 通过；匿名与账号草稿隔离、24 小时过期、刷新恢复、显式原子迁移及 IndexedDB 异常恢复均有断言 |
| T011 渲染与 preflight | 22/22 通过；共享渲染器覆盖布局、主题、局部覆盖、全部素材槽，并在字体、图片或任一层级文字溢出时阻断 |
| T012 编辑器 | 10/10 UI 测试通过；文本、CTA、模式、图片槽、撤销/重做、拖拽与键盘排序及 4–12 页边界均连接到真实 `/editor/[id]` 页面 |
| T013 主题 | 8/8 通过；六套批准主题及平台切换保留内容、素材和局部覆盖 |
| 精确 Node 回归 | 官方 `node:22.23.2` 容器中全量非云测试 98/98、类型检查、19/19 规划检查和生产构建通过；构建包含动态 `/editor/[id]` 路由 |
| 真实 Chromium | Playwright 1.57.0 使用 Chromium 143.0.7499.4、单 worker 执行 4/4 通过；验证离线编辑与刷新、草稿隔离、4→12→4 页边界、真实指针拖拽和键盘排序路径 |
| 人工视觉验收 | 桌面三栏、820 px canvas-first、批准的纸张/墨色/Signal 视觉、样式化控件及横向页面胶片均经截图比对通过 |

浏览器截图仅用于当次人工比对，完成后已从工作区移入废纸篓；Playwright 输出、临时服务日志和测试草稿均未提交。交叉审查发现的草稿事务恢复、嵌套溢出检测、素材槽覆盖、刷新时序和窄屏胶片方向问题均已修正并纳入回归。

## B03 身份与数据地基验收

状态：`PASS — B03 T015–T026 全部验收完成`

记录日期：2026-09-06

| 检查 | 结果 |
|---|---|
| T015 环境隔离 | 精确 Node 22.23.2 中 10/10 通过并完成类型检查；Development/Preview 指向生产项目、项目 ref 与 URL 不符、缺失凭据、公开 server secret 和错误 key 类型均拒绝启动；尚未创建生产项目时 Development 无需伪造 production ref |
| 客户端边界 | 浏览器与 SSR 用户客户端只使用 publishable key；admin client 只在 server 模块读取 secret key；生产 client chunks 不含 server secret 变量或标记；授权辅助方法调用 `auth.getUser()` 重新验证用户 |
| T016 云端身份基线 | 在真实开发项目执行 identity 定义及 18 项 pgTAP 行为套件，`finish(true)` 无失败；覆盖匿名拒绝、本人读取/更新、跨账号隔离、禁止状态/删除/换主及 deleting 状态阻断，事务回滚后测试用户与 profile 均为 0 |
| 云项目 | `orincard-dev` / `ettuzeunkadkfnawawdy`，`us-east-2`，`ACTIVE_HEALTHY`，Postgres 17.6.1.166；使用已授权 Supabase 连接验证，未读取、写入或记录密钥 |
| 权限与结构 | `public.profiles` 已启用 RLS；2 条 policy、2 个 trigger、表注释及 6/6 字段注释存在；匿名 SELECT 与 authenticated 更新 `status` 均为 false |
| 数据库质量门 | pgTAP 1.3.3；安全顾问 0 项、性能顾问 0 项；本地静态检查 1/1 通过。当前 Supabase CLI OAuth 对该项目仍返回 403，因此真实云测试由已授权连接执行 |
| T016 集成回归 | 官方 Node 22.23.2 容器中非云测试 109 项通过、1 项仅在显式云测试模式运行；类型检查、19 项规划检查及生产构建通过 |
| T017 项目与版本 | 真实云库 23/23 pgTAP 通过；CAS 旧 revision 只能成功一次，不可变快照拒绝更新/删除，跨账号及 deleting 账号不可读，客户端不能伪造 owner |
| T018 品牌、来源与素材 | 真实云库 25/25 pgTAP 通过；`sources`/`assets` 桶真实存在且为 private，同 owner 跨表引用、历史引用保护、删除后拒绝及 Storage authenticated policy 通过 |
| T019 任务与双账 | 真实云库 45/45 pgTAP 通过；任务/保存回放幂等、CAS 与回执同事务、取消优先、额度不透支/不双扣、provider attempt 审计及实际成本高于预估仍如实入账均通过 |
| T020 迁移 | 临时本地 Supabase Postgres 17 栈完成干净 `db reset`、111/111 pgTAP 与 DB lint 0 项后立即停止并删除数据卷；同一基线及 private deny policy 已登记为云端迁移 `walking_skeleton`、`private_deny_policies` |
| 云库完整性 | 16/16 应用表存在且全部启用 RLS；表/字段缺失注释均为 0；18 条 policy，`private` 仅 service role 有 schema usage；事务测试回滚后 profiles/projects/jobs 均为 0 |
| 云顾问 | 最终复核有 1 项 Auth WARN：泄露密码保护尚未启用，作为生产前安全配置项记录，不阻断本批次 AC；性能顾问仅报告空库新索引尚未使用的信息项，索引对应已批准的查询、外键或 TTL 清理路径，保留待真实负载复核 |
| B03-2 代码回归 | 官方 Node 22.23.2 容器中非云测试 113 项通过、5 项显式 DB 测试默认跳过；类型检查、19 项规划检查与包含 `/login`、`/signup`、`/reset-password`、`/auth/callback`、Proxy 的生产构建通过 |
| T021 认证 | `tests/cloud/auth.test.ts` 6/6 通过；真实开发 Supabase 测试账号登录成功，非法密码、非法邮箱和过期 session 被拒绝；Google PKCE 入口按契约验证，未声称完成真实 Google OAuth 验收 |
| T022 恢复邮件 | `tests/cloud/auth-recovery.test.ts` 7/7 通过；Supabase Auth 接受经已配置自定义 SMTP 发送的真实密码恢复请求，受信回调、过期/重复恢复 session 与退出清理均通过 |
| T023–T025 服务 | 自动保存、outbox 投递、任务状态、取消、重试与早期对账的 3 个定向套件共 19/19 通过；保存仅在真实写入后成功，冲突保留本地稿，重复投递/重试不双扣 |
| T026 保存闭环 | Playwright 1.57.0、Chromium、单 worker 真实执行 1/1 通过（20.1 秒）：匿名本地稿显式同意迁移、账号登录、云端 revision 1→2、刷新读取恢复全部通过；跨账号猜测项目 ID 的真实 ownership smoke 1/1 通过并返回不可区分的未找到结果 |
| B03 最终门禁 | Node 22.23.2 执行类型检查通过；全量非云回归 17 个文件、114 项通过、5 项显式云/DB 测试按设计跳过；19/19 规划检查与生产构建通过；云端密钥只存在于用户测试终端与平台配置，未写入文件、测试产物或 Git |
