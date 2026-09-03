# Orincard 项目说明

## 当前状态

- 产品：面向全球英文个人创作者的完整 AI Carousel Creator。
- 需求基线：`docs/sdd/orincard/spec.md`；用户已批准全量方向。
- 技术方向：用户于 2026-09-03 批准云端技术方案；Vercel + Supabase + Trigger.dev，云端 AI，Stripe Sandbox，Resend。
- 当前交付：技术文档、数据模型、接口契约、设计快照、开发任务和独立 Git 仓库。
- HARD-GATE 2：任务编排完成后交用户审阅。产品功能尚未开发，不把设计演示或文档检查称为功能验收。

## 先读什么

1. `docs/sdd/orincard/spec.md`：做什么。
2. `docs/sdd/orincard/plan.md`：怎么实现、为什么、费用、批次。
3. `docs/sdd/orincard/data-model.md` 与 `docs/sdd/orincard/contracts/`：数据和接口契约。
4. `docs/sdd/orincard/tasks.md`：执行任务及验收命令。
5. `docs/design/reference/README.md`：用户设计快照与许可边界。

## 工程约定

- 一个产品仓库；网站与后台任务分别部署。目录中的设计 HTML 是参考，不是已经上线的应用。
- 本机仅运行轻量前端和有限测试，不常驻数据库容器，不运行本地模型或媒体 worker。
- 沿用用户提供的视觉设计；缺失页面先依照同一设计体系补稿，不自行换风格。
- 使用 TypeScript、pnpm、精确版本和锁文件；SQL migrations 管理数据库、RLS、Storage 策略。
- 每张业务表、每个业务字段和数据库函数必须有 COMMENT；数据库变更必须附权限测试。
- 新增依赖说明现有用途，不添加尚无用途的抽象、微服务、Redis 或向量数据库。
- 人工编辑使用 apply_patch；保护现有文件；不覆盖原设计和原研究目录。
- 搜索遵守 `.codexignore`。依赖、密钥、用户素材和备份不得读取或提交。
- Git 使用 `codex/` 功能分支、显式暂存、提交前审查；提交说明引用 AC。不提交 `.env` 或真实用户数据。
- 有未确认价格、支付资格或素材许可时，标为发布阻断；不伪造集成成功，不绕过供应商限制。

## 已锁定产品边界

六类来源、三平台、模板/素材/Brand Kit、项目版本与恢复、全格式导出、七种工具、订阅额度、SEO/帮助和 Affiliate 全部保留。个人账户优先；不做团队协作或社媒直接发布。

## 文档验证

`node scripts/check-planning.mjs`

此命令只证明规划结构、任务映射和设计资源完整，不证明业务功能或云端集成已经实现。
