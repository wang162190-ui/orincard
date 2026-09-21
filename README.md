# Orincard

AI carousel creation for individual creators: source → editable slides → brand → assets → export.

把 Topic、Text、URL、Video、PDF、Slides 六类输入转成可编辑的 LinkedIn / Instagram / TikTok 轮播内容，覆盖大纲生成、模板与平台预设、幻灯片编辑、品牌套件、配图、caption、多格式导出与云端保存。

面向全球英文个人创作者。核心任务只有一句话：

> "I have a topic or source, but not the time or design skills to turn it into a professional carousel I can still edit and publish."

## 当前状态

**2026-09-04 → 2026-09-20，17 天，300 次提交。** 从规格文档到可运行应用。

| 指标 | 数量 |
|---|---|
| 源文件 / 代码行 | 226 个 / 约 29,000 行 |
| 测试用例 | **529 条通过**，7 条显式跳过（154 个测试文件） |
| 数据库迁移 | 36 个 |
| API 路由 | 52 条 |
| 规划任务 | 104 个（15 批次 / 7 并行组） |

### 已端到端验证

- 等候名单全链路：迁移已应用于开发库；同一地址连续两次提交均返回 201 且库中只有一行（幂等）；匿名密钥实测读回 0 行、写入被 RLS 拒绝；7 条 Playwright 端到端测试通过，用例提交的地址事后在库中确实查得到。
- 生产构建已由 Vercel 云端构建机独立验证，不只是本机 `pnpm build` 通过。

### 尚未完成（如实列出）

- 生产库缺 4 个迁移：本机没有该 Supabase 账号的凭据，是「够不着」而非「未授权」。
- Stripe 测试密钥缺失，2 条发布闸门仍为红。
- Trigger worker 的内置素材修复尚未实机验证。
- 默认部署域在部分网络不可达，需绑定自定义域名。

本仓库的一条规则是：路线图上的 ✅ 只在真正跑通并验证之后才打，跑不通就打 ❌ 并写一行原因。上面这节是该规则的直接结果。

## 工程方法

这个项目由人与 AI 协作完成（Claude Code）。人负责产品方向、合规边界、技术选型和「跑通」的定义；AI 负责规格拆解、实现、测试与文档。让这套分工成立的是四条强制约束：

1. **规格先于代码。** `spec.md` → `plan.md` → `data-model.md` → `contracts/` → `tasks.md`，52 条 API 路径逐条分配到任务后才开始实现。
2. **设计基线用 SHA-256 锁死。** `scripts/check-planning.mjs` 每次必须报 `15 unchanged design files`，否则整体失败。这是为了防止实现遇阻时悄悄修改需求来迁就实现——这类漂移不拦住，几百次提交后就再也追不回原始意图。
3. **禁止用 mock 假装功能可用。** 跑不通就写跑不通。
4. **环境隔离与密钥纪律。** 只操作开发库；密钥只在子 shell 内加载，绝不进入日志、终端输出或提交历史。

### 一条选型原则：能用确定性工具解决的，不交给模型

源文件解析层完全没有使用 AI：`pdfinfo` 报加密与页数、`pdftotext` 抽文字层，**只有确认是扫描件才走 `tesseract` OCR**；`ffprobe` 判断流构成并优先提取内嵌字幕轨，**没有字幕才切音频送转写**。有文字层的 PDF 直接抽取，结果精确、零 token、零幻觉。模型只用在真正需要理解与创作的环节。

成本上设了每月硬顶，并写进计量代码：供应商未拆分回报缓存命中用量时，按全部未命中计价，取成本上界而非估算值——宁可高估也不低估预算。

## 文档

- [Project guide](project.md)
- [产品规格](docs/sdd/orincard/spec.md)
- [架构与执行计划](docs/sdd/orincard/plan.md)
- [数据模型](docs/sdd/orincard/data-model.md)
- [API 契约](docs/sdd/orincard/contracts/api.md)
- [开发任务](docs/sdd/orincard/tasks.md)
- [路线图（含全部失败记录）](docs/roadmap.md)
- [验收与部署](docs/acceptance/)
- [素材与字体许可清单](docs/licenses/assets.md)
- [Git 与运维约定](docs/sdd/orincard/operations.md)

## 本地运行

需要 Node.js 22 以上。

```bash
pnpm install
pnpm typecheck        # 类型检查
pnpm test             # 单元与集成测试
node scripts/check-planning.mjs   # 文档结构与设计基线完整性
pnpm dev              # 开发服务器
```

`pnpm dev` 之外的四条命令不需要任何云端凭据。完整运行应用需要 Supabase、Trigger.dev 与 AI 供应商的配置，键名见 [.env.example](.env.example)。

## 技术栈

Next.js 16 App Router + Turbopack + TypeScript，部署于 Vercel；Supabase Postgres / Auth / 私有 Storage，全表启用行级安全；Trigger.dev v4 托管异步任务（导出、转写、长耗时生成）；Stripe 计费；Resend 邮件；vitest + Playwright 测试；导出经无头 Chromium 渲染。

AI 供应商：文本 DeepSeek、图像 gpt-image-2（经聚合层）、语音转写火山引擎 seedasr、授权图库 Pexels。

## 权利声明

不含任何竞品的代码、品牌资产、模板或原始文案。

随仓库分发的素材逐项登记在 [docs/licenses/assets.md](docs/licenses/assets.md)，该清单同时是发布闸门测试的数据源——「缺条目」与「条目写着未知」都会导致发布被拦。`public/media/` 下的全部图片为自有（AI 生成或自渲染）；设计参考目录中的 6 张照片为 CC BY 2.0，署名见 `credits.json`。

字体许可另见 [fonts.md](docs/licenses/fonts.md)，来源解析工具的 copyleft 审查另见 [parsers.md](docs/licenses/parsers.md)。

用户内容不用于训练，也不对外分发。
