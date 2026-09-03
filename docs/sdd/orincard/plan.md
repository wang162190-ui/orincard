# Orincard 技术方案与执行编排

> source: docs/sdd/orincard/spec.md；用户批准的云端技术方案；docs/design/reference/

版本：1.0，2026-09-04。Gate 1 已批准；Gate 2 等待任务编排审阅。本次仅交付规划与 Git 基线，不声称产品、云资源或付费接入已实现。

## 1. Phase -1 Gates

| 闸门 | 决策与理由 |
|---|---|
| Simplicity | 单仓库 Next.js 网站 + Trigger.dev 任务，统一 Supabase。没有独立 API 服务、Redis、ORM、向量库、CMS 服务或本地模型。完整媒体/导出需求现在就需要后台计算，不等上线超时后再改。 |
| Anti-Abstraction | 文档类型服务编辑/保存/恢复；SlideRenderer 服务预览/导出；AI 模块服务生成/改写/七工具。只提取这些真实重复点，不做通用插件系统、工作流编排器或多租户团队层。 |
| Integration-First | 先验证云端渲染/恢复可行，再打通 Topic/Text → 编辑 → 保存 → PNG/PDF；其后扩展来源、素材、其他格式与商业化。小闭环是实施顺序，不是范围删减。 |

## 2. 架构与选型

浏览器负责交互和本地草稿；Vercel 负责 SSR/静态内容、短业务请求、鉴权与任务提交；Supabase 管身份、Postgres 和私有对象；Trigger.dev 管持久化长任务；外部 AI/Stripe/Resend/Pexels 使用服务端 SDK/API。

本机内存 16GB：仅一个开发服务；浏览器视觉测试单 worker；完整矩阵交 CI。不得启动本地完整 Supabase Docker、本地模型或 `trigger dev` 媒体 worker 作为默认运行方式。重任务部署到云端开发隔离环境。

网站：Next.js 16（本次 npm 查询为 16.3.4）、React 19、TypeScript 5+、Node.js 22、pnpm 10。实际安装时检查安全更新并锁精确版本和 lockfile，不用 canary。保留现有 CSS tokens，交互用 React reducer/Context 与操作历史；拖拽用 dnd-kit；框架部署位置独立于业务文档。

优先 Server Components 读取和静态公开页；编辑保存/任务/导出使用明确 HTTP 契约；简单表单 Server Actions 复用同一服务函数，不形成第二套业务校验。后台任务不得整包导入网站构建，渲染依赖只进入 worker。

### 选型矩阵

| 问题 | 选中 | 未选 | 取舍 / AC |
|---|---|---|---|
| 网站 | Next.js on Vercel | 继续将静态 HTML 当产品、单独 SPA+API | SEO 与交互同仓库；保留设计而重写状态。AC-001/011 |
| 账号/数据 | Supabase Auth/Postgres/Storage | Auth.js+独立数据库+S3 | 用户指定、少服务；RLS 和授权请求必须实测。AC-007/008 |
| 长任务 | Trigger.dev Cloud | 全塞 Vercel HTTP、自己管 VPS/Redis | 支持 FFmpeg/Chromium/重试；增加一项供应商成本。AC-002/006 |
| 卡片渲染 | 同一 HTML/CSS 渲染器 + Chromium | Satori、自由 Canvas | 现有设计含浏览器 CSS；Satori 受限 CSS 会产生第二套排版。AC-004/006 |
| PPTX | PptxGenJS | 全页截图、复杂原生 Office 自动化 | 保留文字/图片可编辑，允许装饰栅格化；需要兼容性样本。AC-006 |
| 恢复 PDF | qpdf 附件 + 校验后的恢复 ZIP | 从普通 PDF 猜测布局、pdf-lib 新依赖 | 普通 PDF 无法保证可逆；pdf-lib 最近维护不足，避免作主依赖。AC-007 |
| 数据访问 | supabase-js + SQL RPC | Prisma 与第二套迁移源 | 原子事务在数据库；RLS/类型由同一 schema 推导。AC-007/009 |
| 支付 | Stripe 托管 Checkout/Portal | 自收卡号、自建账单 | Sandbox 可开发；真实主体资格不推定。AC-009 |

详见 [复用与调研](research.md)。库为工具而非产品代码基线；不复制竞品源码和模板。

## 3. ADR（已批准方向的实施细化）

### ADR-001：单仓库、两种运行目标

背景：媒体与导出会超出短请求能力，本机受内存约束。决策：网站跑 Vercel，任务跑 Trigger.dev；均读取 Supabase。候选与权衡见上表。后果：不用运维服务器，但必须版本化任务输入、隔离环境和协调发布；供应商故障时保留任务/草稿，不能假成功。关联 AC-002/006/007。

### ADR-002：项目文档 + 不可变快照

背景：编辑、版本恢复和导出需要相同内容。决策：项目存 JSONB 文档，独立版本表保存快照；保存用 revision 比较交换。后果：不把每个文本节点拆表；大图在 Storage；同一用户多标签页也必须处理冲突。关联 AC-003/004/007。

### ADR-003：品牌快照与共用渲染

背景：品牌变更不能暗中改写历史项目。决策：template defaults < brand snapshot < project settings < slide overrides。品牌更新只提供显式应用操作；浏览器和导出共享组件。后果：模板、字体和 rendererVersion 均要固定，不能自动迁移旧稿。关联 AC-004/006/008。

### ADR-004：幂等、额度预留、结果不直接覆盖

背景：支付、生成、任务投递不是一个分布式事务。决策：DB 写入 job+reservation 后作为 outbox 投递；Trigger 幂等键为 job ID；回写事务检查 job 状态、项目存在和预期版本。后果：允许至少一次执行，但业务结算恰好一次；外部 AI 超时不代表没收费，供应商未知状态需对账。关联 AC-002/003/006/009。

### ADR-005：所有者隔离与带身份下载

背景：签名链接不能满足立即撤销后续授权的语义。决策：业务与 Storage RLS 检查用户、账户状态、项目/素材状态；下载走 authenticated Storage 请求。后果：不发长效分享 URL，导出按钮用流式文件写入（支持时）或有上限的 Blob 下载；已接收字节不能回收。关联 AC-007/008。

### ADR-006：匿名短请求例外

背景：匿名正文不能持久化，而托管后台任务会持久化载荷。决策：匿名 Topic/Text 通过 Vercel 短流式请求临时生成，仅存无正文请求元数据；不提交到 Trigger，不建匿名云项目。后果：匿名断网不能后台恢复；告知重试，注册后才启用持久化长任务。匿名源码和结果不进日志，供应商数据保留单独披露。关联 AC-001/002。

## 4. 业务约束与接口

- 文档结构、格式枚举、style precedence 见 [document.md](contracts/document.md)。
- API、错误码、版本与幂等见 [api.md](contracts/api.md)。
- 原子事务、表字段注释、RLS 见 [data-model.md](data-model.md)。
- 来源安全、渲染/任务状态、导出恢复见 [processing.md](contracts/processing.md)。
- 配置、商业发布阻断、备份、Git 和 CI 见 [operations.md](operations.md)。

服务端是权益唯一判断点。客户端不能指定 owner_id、credits delta、任意 Stripe price ID 或任意 Storage 路径。恢复包是非可信上传，不能携带可执行 HTML/JS。所有 HTML 只由可信模板生成，AI 仅返回结构化数据。

## 5. 页面地图与目录边界

公开路由：`/`、`/templates`、`/templates/[slug]`、`/tools`、`/tools/[tool]`、`/pricing`、`/help/[slug]`、`/guides/[slug]`、`/affiliate`、`/legal/[slug]`。

账号路由：`/login`、`/signup`、`/reset-password`、`/auth/callback`。工作区：`/create`、`/editor/[id]`、`/projects`、`/brand-kits`、`/exports`、`/settings`、`/billing`、`/affiliate/dashboard`。匿名 editor ID 仅本地解析，不暴露云项目。

缺失设计页必须在同风格补齐并 review；新增页面不是将设计导航 index 当官网。错误页包含空、加载、失败重试、无权限、失效会话、额度不足、超限、部分成功、冲突；可访问组件具有焦点管理与键盘控制。

```text
src/app/                  路由、页面、API 薄入口
src/features/             auth / editor / projects / generation / assets / brands / exports / billing / tools / affiliate
src/components/           同风格公共 UI；不包含业务请求
src/domain/               文档 schema、纯函数、错误及策略
src/server/               DB、AI、存储、供应商适配与业务事务
src/render/               编辑器和 worker 共用卡片组件/模板/测量
src/trigger/              任务入口；只接 ID 与版本
content/                  原创帮助、指南、案例 MDX 与模板索引
supabase/definitions/     分领域 SQL 源与表/列注释
supabase/migrations/      CLI 创建的、审核后提交的实际迁移
supabase/tests/           RLS/原子操作/注释测试
tests/                    单元、契约、云集成、视觉、E2E、授权样本
```

definitions 不是第二套迁移历史：发布任务将经审查的 SQL 整理进 `supabase migration new` 生成的迁移并提交，生产只运行 migrations。不凭空指定时间戳文件名；生成文件是该集成任务的受审查输出。

## 6. 费用与成本模型

价格按 2026-09-03 官方快照，2026-09-04 整理，非永久报价。

| 服务 | 零业务用量 | 1000 DAU 示例月费用 | 升级触发 |
|---|---|---|---|
| Vercel | 本地开发 $0；商业线上 Pro $20 起 | $20–40 | 商业使用即 Pro；算力/流量告警 |
| Supabase（数据/账号/文件） | 开发 Free $0；生产 Pro $25 起 | $35–90，含额外开发算力/容量与出口估算 | >50MB 文件、备份、容量/稳定性要求 |
| Trigger.dev | Free $5/月用量抵扣 | $100–250 | 免费额耗尽、队列等待、媒体量 |
| AI 文本 | 按量，零调用 $0 | $120–180 | 质量或成本实测 |
| AI 图片/Portrait | 按量，零调用 $0 | $150–450 | 质量/尺寸/token 使用 |
| AI 转录 | 按量，零调用 $0 | 约 $27 | 音频分钟数 |
| Resend | Free $0，100封/日、3000封/月 | $0–20 | 邮件日/月限额 |
| Pexels | API 基础额度内 $0 | 请求额度内 $0；超量先申请 | 配额、许可/用户使用约束 |
| Stripe | Sandbox $0；真实交易按费率 | 另计，不计入上述基础设施总额 | 主体/地区；订阅 Billing 与支付处理费分别计算 |

`[ASSUMPTION: 容量预算，不是实测]` 1000 DAU × 每日1套 × 30天 = 30000套/月；每套文本8000输入+2000输出token；每10套1张AI图（按$0.05–0.15/张估算，不是固定官方单图价）；每10套1段3分钟视频=9000分钟；每套一次图片/PDF渲染、约10%导出MP4。对应约 $450–1100/月，不含域名、税费、佣金、交易费或大规模原视频长期存储。图片/视频用量翻倍会显著改变结果，不能用 DAU 单独推成本。

应用预算按 UTC 月记录实际供应商用量与未结算预留；开发 AI 预算 $10，80% 提醒，100% 停止新付费任务，历史编辑/下载继续。重任务用户并发1、全局导出2，provider rate-limit 指数退避并设最大尝试。预估不准可能产生小额超支，超额记账并熔断，不能声称云账单绝对硬上限。

## 7. 批次与关键路径

任务的精确文件、依赖、验收命令在 [tasks.md](tasks.md)。所有任务保持未完成，命令是实施后的验收要求，不是现已通过的测试。

交叉审查后共95项、12批，覆盖48个API路径；检查范围和保留的发布阻断见[审查记录](review.md)。

| 批次 | 目标与可见产出 | 开门条件 |
|---|---|---|
| B01 | 工程、schema、测试工具、云渲染/恢复高风险探针 | Gate 2 批准；云探针需隔离资源 |
| B02 | 设计公共组件、匿名草稿、编辑器与样式切换 | B01 探针通过 |
| B03 | 账号、项目保存、版本、权益与任务安全骨架 | B02 |
| B04 | Topic/Text 真生成、局部 AI、基础导出 → 首条闭环 | B03；模型与任务凭据 |
| B05 | URL/PDF/OCR/PPTX/Video 与安全失败 | B04 |
| B06 | 素材、截图、AI 图、品牌全流程 | B05 |
| B07 | PPTX/MP4、恢复包、版本历史、删除与用户数据包 | B06 |
| B08 | 七种工具与编辑器互通 | B07 |
| B09 | 订阅、账单、退款/降级、额度对账 | B08；Sandbox 资格 |
| B10 | 公开站、SEO、帮助、Affiliate、支持 | B09；公开内容审查 |
| B11 | 生产发布、监控、备份、隐私/许可审计 | B10；生产先决条件 |
| B12 | 完整测试矩阵、人工验收、发布证据 | B11；不得用 mock 代替真实集成 |

关键路径：B01 → B02 → B03 → B04 → B05 → B06 → B07 → B08 → B09 → B10 → B11 → B12。风险探针失败先修方案，不能继续堆页面；B04 是第一套真实可导出闭环，B12 才是全量验收。

`[UNVERIFIED-NUMBER: 排期估算]` 每任务约0.25–0.5开发日，集成/兼容性任务可增加；实际任务数由验证脚本统计。单人预计8–12周量级，非交付承诺，不含外部开户和等待审批时间。

### 并行能力探底与降级

2026-09-04 工具可创建并发 subagent，exec 可后台回收；但 spawn 接口未暴露可验证的独立工作目录/worktree 隔离。按技能三项全部具备的标准，当前执行编排明确降级为**串行**，不标 `[P]`，不以“多代理”承诺加速。后续仅在验证隔离能力后重排，不更改数据契约。

### worktree 执行清单

本次只建立 main 基线，不创建开发 worktree。Gate 2 批准后一次只开一棵树，六要素如下：

| 批次 | worktree | 分支 | 文件集合与任务 | 合并前判据 | 合并顺序 |
|---|---|---|---|---|---|
| B01–B12 | 主仓同级 `Orincard-bNN`，NN 对应该批次两位数字 | `codex/bNN` | tasks.md 中该批次逐项列出的精确 files 并集；全部任务按依赖执行 | 所有任务 Check + 该批次 Integration；有失败不合并 | 01到12顺序；一批合入并冒烟后才开下一批 |

集合由验证后的任务条目机械生成，不允许 worker 自行增加文件。依赖声明中的公共配置先串行完成；必须增加文件时先修任务清单再执行。冲突停下请求方向，禁止覆盖用户更改。收树只移除已合并且干净的 worktree。

## 8. 四维自检与验收限制

| 维度 | 设计层结论 | 尚需实际验证 |
|---|---|---|
| 上线门槛 | 过：全托管、同仓库发布、无 SSH | 所有账号/区域/回调配置与首个 Preview |
| 成本曲线 | 过：按量、并发/预算保护；商业 Vercel 不假设免费 | 20份样本的真实单位成本与预算超估偏差 |
| 体验性能 | 过：公开页静态、工作区渐进加载、任务进度可恢复 | 长稿编辑流畅度、首屏、低内存浏览器与完整导出 |
| 稳定性 | 过：CAS、outbox、幂等结算、私有存储、对账 | 并发/故障注入、删除中任务、数据库+对象恢复 |

这些是方案评审结论，不是生产验证通过。已有技能 validator 只查基本文本，补充脚本检查任务依赖、文件预算、AC覆盖和设计哈希。所有上线阻断必须有真实凭据、日志或人工签字，不将“未测试”填成“通过”。
