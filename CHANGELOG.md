# Changelog

Orincard 的重要变更记录在此文件中。版本日期采用 `YYYY-MM-DD` 格式。

## [Unreleased]

### Completed

- 完成 B03 T021–T026：邮箱密码登录与恢复邮件、项目 API 和可靠自动保存、任务 outbox/状态/取消/重试，以及账号保存与 ownership 真实云端闭环全部通过。
- 完成 B03 T017–T020：建立项目 CAS 与不可变版本、品牌/来源/素材和私有 Storage、任务 outbox 与用户额度/供应商成本双账，并生成可确定重放的首组数据库迁移。
- 完成 B03 T016：在真实 `orincard-dev` Supabase 项目建立用户 profile、最小 GRANT、RLS、私有触发器函数及完整表/字段注释。
- 完成 B03 T015：建立 Supabase browser/SSR/admin 客户端边界、真实用户重新验证和 Development/Preview/Production 环境隔离；开发与预览误指生产库时拒绝启动。
- 完成 B02 T010–T014：IndexedDB 草稿按身份隔离并支持显式原子迁移；共享 React renderer/preflight 阻断字体、图片和文字问题；六主题与三平台切换保留内容、素材和局部覆盖；真实 `/editor/[id]` 页面连接编辑控件、撤销重做、排序和离线刷新恢复。
- 完成 B01 T001–T003/T005 复验：在精确 Node 22.23.2 容器中验证 frozen lockfile、测试入口、文档 schema 与字体清单，并补齐首闭环依赖基线。
- 将 `test:unit` 从三份固定旧文件改为收集 `tests/unit` 全目录，防止新增单元测试静默遗漏。
- 建立 T010–T037 三线并行编排与隔离 worktree 规则；规划检查器现在验证并行组文件无交叉、组内依赖、最多三线和批次集成收口。
- 完成 B02 T009：实现逐页新增、删除、复制、排序命令及可逆的撤销/重做历史，并保持封面、结尾和未编辑页面不变。
- 完成 B02 T008：建立真实 `/` 与 `/create` App Router 路由、响应式工作区壳、纸鹤品牌标记及仅指向已实现页面的主导航。
- 完成 B02 T007：迁移批准设计的纸张、墨色与三组信号色 tokens，并提供 Button、Panel、Dialog 公共基础组件。
- 完成 B01 T004/T006 的 Trigger.dev 真实云端运行验收；Chromium、PNG、PDF、可编辑文字 PPTX 与 qpdf 恢复附件全部通过。

### Verified

- T021/T022 的认证套件 13/13 通过：真实开发 Supabase 测试账号登录成功，真实密码恢复请求经已配置自定义 SMTP 被接受；Google PKCE 入口仅完成契约验证，未记录为真实 Google OAuth 验收。
- T023–T025 定向服务测试 19/19 通过；T026 使用 Playwright 1.57.0、Chromium 和单 worker 完成匿名稿显式迁移、登录保存、revision 1→2 与刷新恢复，1/1 通过（20.1 秒）；真实跨账号 ownership smoke 1/1 通过。
- B03 最终门禁在 Node 22.23.2 下通过：类型检查、17 个非云测试文件（114 项通过、5 项按设计跳过）、19/19 规划检查及生产构建全部成功。
- T017–T020 在临时本地 Supabase Postgres 17 栈完成干净 `db reset`、111/111 pgTAP 与 DB lint 0 项；同一迁移应用到真实开发云库后再次通过 111/111。云库 16/16 应用表启用 RLS、表/字段注释无缺失、安全顾问 0 项，测试事务回滚后无 profile、project 或 job 数据。
- B03-2 汇合后在 Node 22.23.2 容器中非云测试 113 项通过、类型检查、19 项规划检查与生产构建通过；认证云套件保持显式关闭，未以本地结果冒充真实登录或邮件验收。
- T016 在真实开发云库通过 18/18 pgTAP 行为验收；RLS、2 条 policy、2 个 trigger、表注释和 6/6 字段注释均存在，事务回滚后无测试数据；安全与性能顾问均为 0 项。Node 22.23.2 集成回归为非云测试 109 项通过、类型检查、19 项规划检查和生产构建通过。
- T015 在精确 Node 22.23.2 中通过 10/10 定向测试和类型检查；Next 生产构建的 client chunks 未发现 server secret 变量、生产项目 ref 变量或 secret-key 标记；Development 可在生产项目尚未创建时省略其 ref，Preview/Production 仍强制校验。
- T010/T011/T013 三线定向测试合计 43/43，T012 UI 测试 10/10；汇合后在 Node 22.23.2 容器中全非云 98/98、类型检查、19 项规划检查与生产构建全部通过。
- T014 使用 Playwright 1.57.0、Chromium 143.0.7499.4 和单 worker 完成 4/4 浏览器验收；离线刷新、草稿隔离、4→12→4 页边界、指针/键盘排序、桌面三栏和 820 px canvas-first 布局均通过，临时截图人工检查后已移出工作区。
- 官方 `node:22.23.2` 容器实际输出 Node `v22.23.2`、pnpm `10.32.1`；`pnpm install --frozen-lockfile`、类型检查、T002/T003/T005 定向测试、全单元 32/32、全非云 44/44、生产构建全部通过。
- 规划检查扩展为 19/19 通过；95 项任务、12 批、5 个最多三线的并行组、11 个 AC 与 48 条 API 路径均通过完整性检查。
- T009 定向测试 8/8、全量非云测试 44/44、既有单元基线 24/24、类型检查和 12 项规划检查通过；4/12 页边界及分支编辑清除 redo 均有断言。
- T008 定向测试 5/5、全量非云测试 36/36、类型检查、生产构建和 12 项规划检查通过；Next.js 将 `/` 与 `/create` 静态预渲染。
- Playwright 1.57.0 使用本机 Google Chrome 152.0.7977.76 验证根页 200、主入口跳转、820 px 窄屏当前页语义与零控制台错误；桌面和窄屏截图已人工检查后删除，未提交临时产物。
- T007 定向测试现为 7/7；既有单元测试 24/24、类型检查和 12 项规划检查继续通过，Vitest 已能收集并转换 `.test.tsx`。
- 专用开发项目 Production worker 的 `20260903.2` 版本完成 run `run_06g6jhirrjap2onj2ch665dh01`；任务输出耗时 2201 ms，峰值 RSS 145797120 bytes。
- `RUN_CLOUD_PROBES=1 pnpm test:cloud` 的 3 个云测试全部通过；类型检查、24 项单元测试和 12 项规划检查继续通过。
- 三个云产物的文件头/结构、尺寸或页数、字节数与 SHA-256 均经测试复核，PDF 中的 `orincard-project.json` 可逐字取回。

### Known limitations

- Vercel 仍未初始化；Google provider 与真实 Google OAuth 尚未配置/验收。当前 Supabase CLI OAuth 对 `orincard-dev` 返回 403，但已授权 Supabase 连接可完成迁移和真实云库验证；Trigger.dev 部署仍只包含后台探针任务，不是 Orincard 网站。
- Supabase Auth 的泄露密码保护当前未启用，安全顾问报告 1 项 WARN；它不影响本批次已定义验收，但需在正式生产发布前结合套餐能力启用并复核。
- 系统默认 Node 仍为 24；本次验收通过 Homebrew Node 22.23.2 明确执行，后续 Node/非云集成继续使用该精确版本。

## [0.1.0] - 2026-09-04

### Added

- 建立 Orincard 产品规格、技术方案、数据模型、接口契约、设计快照和串行开发任务基线。
- 初始化 Next.js、React、TypeScript、pnpm、Vitest、Playwright 与 Trigger.dev 工程依赖。
- 增加版本化 `CarouselDocument` 结构、校验错误类型、示例文档及单元测试。
- 增加可校验的自托管字体清单与字体许可记录。
- 增加 Node 22 云端渲染探针，用于验证 Chromium、PNG、PDF、PPTX 和 qpdf 恢复附件能力。
- 将 Playwright 锁定为 1.57.0，规避 Trigger.dev 4.5.16 与新版 `install --dry-run` 输出格式的不兼容。

### Verified

- Trigger.dev 专用开发项目部署版本 `20260903.2` 构建成功。
- 本地类型检查、24 项单元测试和 12 项规划完整性测试通过。

### Known limitations

- Trigger.dev 的三个真实云端任务测试尚未执行，B01 验收状态仍为进行中。
- 当前本机终端使用 Node 24；项目与云端运行时固定为 Node 22.23.2。
