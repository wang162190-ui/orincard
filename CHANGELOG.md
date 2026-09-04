# Changelog

Orincard 的重要变更记录在此文件中。版本日期采用 `YYYY-MM-DD` 格式。

## [Unreleased]

### Completed

- 完成 B02 T007：迁移批准设计的纸张、墨色与三组信号色 tokens，并提供 Button、Panel、Dialog 公共基础组件。
- 完成 B01 T004/T006 的 Trigger.dev 真实云端运行验收；Chromium、PNG、PDF、可编辑文字 PPTX 与 qpdf 恢复附件全部通过。

### Verified

- T007 定向测试 6/6、全量非云测试 30/30、既有单元测试 24/24、类型检查和 12 项规划检查通过；Vitest 已能收集并转换 `.test.tsx`。
- 专用开发项目 Production worker 的 `20260903.2` 版本完成 run `run_06g6jhirrjap2onj2ch665dh01`；任务输出耗时 2201 ms，峰值 RSS 145797120 bytes。
- `RUN_CLOUD_PROBES=1 pnpm test:cloud` 的 3 个云测试全部通过；类型检查、24 项单元测试和 12 项规划检查继续通过。
- 三个云产物的文件头/结构、尺寸或页数、字节数与 SHA-256 均经测试复核，PDF 中的 `orincard-project.json` 可逐字取回。

### Known limitations

- Vercel 与 Supabase 仍未初始化；当前 Trigger.dev 部署只包含后台探针任务，不是 Orincard 网站。
- 当前本机终端仍为 Node 24；项目配置与 Trigger.dev worker 固定为 Node 22.23.2，不将本机版本冒充 Node 22 验证。

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
