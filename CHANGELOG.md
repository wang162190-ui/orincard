# Changelog

Orincard 的重要变更记录在此文件中。版本日期采用 `YYYY-MM-DD` 格式。

## [Unreleased]

### Completed

- 完成 B01 T001–T003/T005 复验：在精确 Node 22.23.2 容器中验证 frozen lockfile、测试入口、文档 schema 与字体清单，并补齐首闭环依赖基线。
- 将 `test:unit` 从三份固定旧文件改为收集 `tests/unit` 全目录，防止新增单元测试静默遗漏。
- 建立 T010–T037 三线并行编排与隔离 worktree 规则；规划检查器现在验证并行组文件无交叉、组内依赖、最多三线和批次集成收口。
- 完成 B02 T009：实现逐页新增、删除、复制、排序命令及可逆的撤销/重做历史，并保持封面、结尾和未编辑页面不变。
- 完成 B02 T008：建立真实 `/` 与 `/create` App Router 路由、响应式工作区壳、纸鹤品牌标记及仅指向已实现页面的主导航。
- 完成 B02 T007：迁移批准设计的纸张、墨色与三组信号色 tokens，并提供 Button、Panel、Dialog 公共基础组件。
- 完成 B01 T004/T006 的 Trigger.dev 真实云端运行验收；Chromium、PNG、PDF、可编辑文字 PPTX 与 qpdf 恢复附件全部通过。

### Verified

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

- Vercel 与 Supabase 仍未初始化；当前 Trigger.dev 部署只包含后台探针任务，不是 Orincard 网站。
- 当前本机终端仍为 Node 24；精确 Node 22.23.2 已在隔离容器中验证，后续 Node/非云集成仍需在该版本复验。

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
