# Changelog

Orincard 的重要变更记录在此文件中。版本日期采用 `YYYY-MM-DD` 格式。

## [Unreleased]

### Pending

- 完成 Trigger.dev 云端任务运行验收后，再关闭 B01 技术地基阶段。

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
