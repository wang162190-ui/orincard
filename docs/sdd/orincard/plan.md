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
| 文本 AI | DeepSeek `deepseek-v4-pro` Responses API + 本地 Zod 校验 | OpenAI `gpt-5.6-luna`、自建 agent 编排框架 | 用户 2026-09-07 批准的供应商替换；结构化契约不变，但 schema 合规改由本地兜底。AC-002/003 |
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

### ADR-007：DeepSeek Responses 结构化生成

背景：B04 需要第一条真实文本生成闭环，用户于 2026-09-07 批准将文本 AI 从 OpenAI `gpt-5.6-luna` 替换为 DeepSeek `deepseek-v4-pro`。产品范围、数据模型和公开 HTTP 契约不因此改变。决策：经 OpenAI Node SDK 指向 `https://api.deepseek.com` 调用 Responses API；固定 `store:false`，不在供应商侧留存会话；输出用 `text.format = {type:"json_schema", name, schema}` 约束。DeepSeek 的 `json_schema` 只接受 `name` 与 `schema`，**不发送 `strict`**，因此供应商侧不保证 schema 合规。后果：schema 合规的唯一判定点是本地 Zod/domain 校验；不合规时做且仅做一次既有 schema 修复，修复仍失败则显式失败，绝不返回空成功。结构约束由供应商侧移到本地，修复路径可能比原方案更常触发，token 成本与端到端延迟须按真实用量复核（该模型默认开启 thinking，输出 token 与耗时高于非思考模式）。匿名正文仍只在短请求中处理，不进入任务载荷与日志。关联 AC-002/003。

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

`[UNVERIFIED-NUMBER: AI 文本待重算]` 表中「AI 文本」区间由已作废的 `gpt-5.6-luna` 单价推导。2026-09-07 换用 `deepseek-v4-pro` 后单价与思考模式输出量均不同，且 DeepSeek 官方定价页在本次核对环境被网络策略拦截、未取得一手数字，故保留原区间仅作占位，须在首次真实用量与账单后重算，不得据此作商业承诺。

| 服务 | 零业务用量 | 1000 DAU 示例月费用 | 升级触发 |
|---|---|---|---|
| Vercel | 本地开发 $0；商业线上 Pro $20 起 | $20–40 | 商业使用即 Pro；算力/流量告警 |
| Supabase（数据/账号/文件） | 开发 Free $0；生产 Pro $25 起 | $35–90，含额外开发算力/容量与出口估算 | >50MB 文件、备份、容量/稳定性要求 |
| Trigger.dev | Free $5/月用量抵扣 | $100–250 | 免费额耗尽、队列等待、媒体量 |
| AI 文本 | 按量，零调用 $0 | `[UNVERIFIED-NUMBER]` $120–180 待重算 | 质量或成本实测 |
| AI 图片/Portrait | 按量，零调用 $0 | $150–450 | 质量/尺寸/token 使用 |
| AI 转录 | 按量，零调用 $0 | 约 $27 | 音频分钟数 |
| Resend | Free $0，100封/日、3000封/月 | $0–20 | 邮件日/月限额 |
| Pexels | API 基础额度内 $0 | 请求额度内 $0；超量先申请 | 配额、许可/用户使用约束 |
| Stripe | Sandbox $0；真实交易按费率 | 另计，不计入上述基础设施总额 | 主体/地区；订阅 Billing 与支付处理费分别计算 |

`[ASSUMPTION: 容量预算，不是实测]` 1000 DAU × 每日1套 × 30天 = 30000套/月；每套文本8000输入+2000输出token；每10套1张AI图（按$0.05–0.15/张估算，不是固定官方单图价）；每10套1段3分钟视频=9000分钟；每套一次图片/PDF渲染、约10%导出MP4。对应约 $450–1100/月，不含域名、税费、佣金、交易费或大规模原视频长期存储。图片/视频用量翻倍会显著改变结果，不能用 DAU 单独推成本。

应用预算按 UTC 月记录实际供应商用量与未结算预留；开发 AI 预算 $10，80% 提醒，100% 停止新付费任务，历史编辑/下载继续。重任务用户并发1、全局导出2，provider rate-limit 指数退避并设最大尝试。预估不准可能产生小额超支，超额记账并熔断，不能声称云账单绝对硬上限。

## 7. 批次与关键路径

任务的精确文件、依赖、验收命令在 [tasks.md](tasks.md)。任务只有在对应验收真实通过后才勾选；命令是实施验收要求，不是规划完成的证明。

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
| B13 | 编辑器对话助手（AC-012，2026-09-14 追加） | B12；原型须经产品所有者过图后才动代码；每轮对话先预留预算后结算，写入只走既有 apply-proposal 路径 |
| B14 | AI 编排器（AC-005/AC-010，2026-09-15 追加） | B13；形态是编排器不是自主循环——一次请求恰好一次模型调用，只产出计划不自动执行；执行阶段复用既有任务链路，每步独立提交并各自过数据库预算闸 |

关键路径：B01 → B02 → B03 → B04 → B05 → B06 → B07 → B08 → B09 → B10 → B11 → B12 → B13 → B14。风险探针失败先修方案，不能继续堆页面；B04 是第一套真实可导出闭环，B12 才是全量验收。

`[UNVERIFIED-NUMBER: 排期估算]` 每任务约0.25–0.5开发日，集成/兼容性任务可增加；实际任务数由验证脚本统计。单人预计8–12周量级，非交付承诺，不含外部开户和等待审批时间。

### 首个真实闭环的三线并行编排

T010–T037 使用一棵协调 worktree 和最多三棵隔离功能 worktree。协调线持有 `codex/walking-skeleton`；A/B/C 工作线每个并行组创建新的 `codex/ws-*` 功能分支。`[P]` 仅表示同一 `Parallel` 组中不同工作线可同时开工；同一工作线内仍按依赖顺序提交。

| 阶段 | 工作线 A | 工作线 B | 工作线 C | 汇合门 |
|---|---|---|---|---|
| B02-1 `WS-B02-1` | T010 IndexedDB 草稿 | T011 共享渲染和 preflight | T013 六主题与平台切换 | 三线定向测试、类型检查 |
| B02-2 | T012 编辑器页面和控件 | — | — | 合并后运行 T012 定向测试 |
| B02-3 | T014 E2E/视觉验收 | — | — | 单 worker 浏览器与人工视觉验收 |
| B03-1 | T015 Supabase 客户端/环境校验 → T016 identity | — | — | 创建开发云项目，完成身份表基线 |
| B03-2 `WS-B03-2` | T017→T018→T019→T020 数据库定义与迁移 | T021→T022 登录、OAuth、找回与邮件 | — | 本地临时栈重放迁移，再推开发云库 |
| B03-3 `WS-B03-3` | T023 项目 API 和自动保存 | T024→T025 任务投递、取消和重试 | — | T026 账号与保存集成冒烟 |
| B04-1 `WS-B04-1` | T027→T028 来源与结构化 AI | — | T034→T035→T036 基础导出链 | T028 合并后开启第二生成线 |
| B04-2 `WS-B04-2` | T029 注册生成与进度 | T030→T032→T033 匿名生成、局部改写和重新生成 | 继续导出链 | T031 等待 T029/T030 后接创建页；三线汇合部署同一 worker 版本 |
| B04-3 | T037 首闭环 E2E | — | — | Topic/Text、保存、刷新、PNG/PDF 全部真实通过 |

关键依赖保持单向：T010/T011/T013 直接依赖公共地基，T012 等待三者；T017 与 T021 在 T016 后分线，T023/T024 等待数据库与认证线汇合；T034 依赖 B03 地基而不等待生成线；T029/T030 都等待 T028，T031 等待两者，T032 不依赖 T031；T037 等待 T031、T033、T036。

### worktree 执行清单

| 角色 | worktree | 分支规则 | 文件边界 | 合并前判据 |
|---|---|---|---|---|
| 协调 | `Orincard-walking-skeleton` | `codex/walking-skeleton` | 规划、依赖、汇合验收、任务勾选、验收文档与 CHANGELOG | 全批统一检查及真实集成证据 |
| A | `Orincard-ws-a` | 每组新建 `codex/ws-a-*` | tasks.md 对应工作线的精确 files 并集 | 定向测试通过、提交已推送、worktree 干净 |
| B | `Orincard-ws-b` | 每组新建 `codex/ws-b-*` | tasks.md 对应工作线的精确 files 并集 | 定向测试通过、提交已推送、worktree 干净 |
| C | `Orincard-ws-c` | 每组新建 `codex/ws-c-*` | tasks.md 对应工作线的精确 files 并集 | 定向测试通过、提交已推送、worktree 干净 |

不同工作线的同组文件集合不得交叉，同组不得跨线依赖，并发不超过三。功能 worker 不接触密钥、不执行数据库/Trigger 部署、不更新任务勾选或 CHANGELOG。协调线在汇合后串行执行数据库变更、云测试、Trigger 部署和 Playwright，避免互相覆盖外部状态。功能分支合并并推送且 worktree 干净后才回收复用；必须扩大文件范围时先修任务清单并重新通过规划检查。

## 8. 四维自检与验收限制

| 维度 | 设计层结论 | 尚需实际验证 |
|---|---|---|
| 上线门槛 | 过：全托管、同仓库发布、无 SSH | 所有账号/区域/回调配置与首个 Preview |
| 成本曲线 | 过：按量、并发/预算保护；商业 Vercel 不假设免费 | 20份样本的真实单位成本与预算超估偏差 |
| 体验性能 | 过：公开页静态、工作区渐进加载、任务进度可恢复 | 长稿编辑流畅度、首屏、低内存浏览器与完整导出 |
| 稳定性 | 过：CAS、outbox、幂等结算、私有存储、对账 | 并发/故障注入、删除中任务、数据库+对象恢复 |

这些是方案评审结论，不是生产验证通过。已有技能 validator 只查基本文本，补充脚本检查任务依赖、文件预算、AC覆盖和设计哈希。所有上线阻断必须有真实凭据、日志或人工签字，不将“未测试”填成“通过”。
