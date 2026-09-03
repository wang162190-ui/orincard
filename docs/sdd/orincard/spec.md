# Orincard Carousel Creator Spec

> source: 用户批准的全量开发计划、`aicarousels-teardown.html`、`audit-aicarousels/` 九张实测截图与 aiCarousels 官方公开指南。
>
> 版本: v1.0 + approved technical clarifications · 状态: 产品方向与技术方向已获用户批准；开发任务待 HARD-GATE 2 review · 整理: 2026-09-04
>
> 本文是唯一需求基线，替代旧 v0.4“知识主稿工作台”方向。旧研究材料保留，但不再作为开发依据。具体技术栈、数据库、供应商与部署在 tech-spec 决定。

## 1. 产品定位与边界

Orincard 是面向全球英文个人创作者的 AI Carousel Creator：把 Topic、Text、URL、Video、PDF 或 Slides 转成可编辑的 LinkedIn、Instagram、TikTok 轮播内容，并完成品牌化、素材、caption、导出、云端保存与恢复。

核心任务：

> “I have a topic or source, but not the time or design skills to turn it into a professional carousel I can still edit and publish.”

系统主线：

```text
Source → AI outline → template + platform preset → slide editing
→ assets + Brand Kit → caption / companion tool → export → save or restore
```

已确认决策：

- 品牌：Orincard；英文优先；个人创作者优先；不做团队协作。
- 平台：LinkedIn、Instagram、TikTok；只提供手动发布所需导出物，不做账号授权或直接发布。
- 输入：Topic、Text、URL、Video、PDF、Slides；输出：PNG/JPG ZIP、PDF、PPTX、MP4、Caption。
- 商业化：匿名先试后注册；Free、Pro、Creator 月付/年付；国际支付优先；用户可保存多个 Brand Kit。
- 增长：官网、SEO 内容、案例/模板页、免费工具矩阵、帮助中心与 Affiliate。

永久边界：不得复制 aiCarousels 或任何第三方的品牌、商标、代码、原始文案、插图、模板资产、私有数据或像素级界面；不得绕过登录、付费墙、robots 或访问控制；不得将用户内容用于训练或公开分发。

## 2. 证据、复刻范围与差异化点

aiCarousels 的主页、模板选择、编辑器、三步引导、生成器、Topic 结果与单页控制共九张截图属于 Lv2 实测证据。登录、支付、最终下载质量、取消、完整移动端和无障碍流程均为 `[UNVERIFIED-COMPETITOR-DETAIL]`。

| 已验证/公开机制 | Orincard 行为 |
|---|---|
| 无注册编辑器和模板先行 | 匿名用户可开始、选原创模板、生成低清预览；保存、高清导出、持续额度触发注册 |
| Topic/Text/Website/Video/PDF/Slides | 六类输入进入同一生成任务，保留来源特有校验、进度、失败与重试 |
| Intro / 正文 / Outro | 角色化 `Slide` 结构，生成可编辑轮播而不是长文本 |
| 模板、颜色、字体、背景、计数器、品牌 | `Template`、`ThemeSettings` 与 `BrandKit` 分离；全局规则可由单页覆盖 |
| 单页文本、图文、图片、截图 | 支持新增/复制/删除/重排、布局切换与局部 AI 写作 |
| Pexels/上传/AI 图片/头像/截图/Emoji | 使用授权图库、用户素材、AI 生成和截图，并保存权利/来源状态 |
| Caption 和相邻工具 | Caption、LinkedIn Post、Post Ideas、Quote Card、Infographic、Portrait、Carousel-to-Video 可独立或继承项目上下文 |
| 草稿、下载、重新导入 | 云端项目、版本、ZIP/PDF 项目恢复和独立导出记录 |
| 免费工具、SEO、Affiliate | 作为公开获客层，而不是编辑器附属页 |

差异化：Orincard 使用原创英文品牌和模板；首期只把三平台预设做深；以“可恢复项目 + 可复用 Brand Kit + 导出视觉检查”为持续制作资产，避免只有一次性生成。

## 3. 战略验证与发布切分

最脆假设：用户会从匿名预览转注册，并在第二个项目中复用 Brand Kit 或购买额度，而不是只停留在免费工具。

最低成本证伪：20 个原创/授权英文主题或来源、10 名目标用户；记录首次导出、注册、二次项目、导出失败和整体重写比例。

以下均为 `[UNVERIFIED-NUMBER: 内测阈值]`：首次导出 ≥7/10、注册保存 ≥5/10、7 天内第二项目 ≥4/10、整体推倒重做页数 ≤25%。若导出普遍不可用、用户只使用免费工具、生成内容需重写大半或试用成本无法被转化覆盖，停止扩张能力。

| 能力 | R0 封闭试用 | R1 公开商业闭环 | R2 增长闭环 |
|---|---|---|---|
| 匿名体验 | Topic/Text、模板、编辑、低清预览 | 延续 | 延续 |
| 输入 | Topic/Text/URL/PDF | Video/Slides、异步媒体 | 授权连接器候选另立项 |
| 编辑 | 三平台、模板、主题、逐页文案/布局 | 多 Brand Kit、完整素材/截图 | 更多原创模板 |
| 项目/导出 | PNG/JPG、PDF、Caption | 云端版本、ZIP/PDF 恢复、PPTX | MP4、批量导出 |
| 商业化 | 权益/额度提示 | Free/Pro/Creator、支付、账单 | Affiliate、优惠码 |
| 工具 | Caption、Post Ideas | LinkedIn Post、Quote/Infographic | Portrait、Carousel-to-Video |
| 内容站 | 首页、价格、帮助 | SEO 指南、模板/案例 | Affiliate 资源中心 |

上表保留原需求讨论的能力分组，不是本轮范围裁剪或“R1即可宣称全量完成”的授权。本轮覆盖R0–R2全部已确认功能（授权连接器候选除外），以tech-spec的B01–B12为实施顺序；B04只验收内部小闭环，B12全部AC与发布条件通过后才验收全量产品。不得以P1/P2标签跳过项目、账单、工具或Affiliate。

## 4. 页面与功能清单

### 4.1 公开站与认证

- 首页：三平台产出、立即创建、原创模板/案例、免费工具、价格、帮助和登录入口；状态：默认、降级、地区/服务不可用。
- 模板/案例页：可索引的原创分类、平台预设和“创建副本”入口；不得展示竞争模板资产。
- 指南/帮助：输入、编辑、导出、账单、取消、恢复、发布教程；项目页禁止索引。
- 注册/登录/找回：支持匿名草稿迁移；状态：重复邮箱、失败、会话过期、账户删除。
- 价格/账单：Free/Pro/Creator 权益、月年切换、额度、账单、失败支付、取消/降级、退款支持；实际价格/额度见 BLOCKER。

### 4.2 项目库与 Brand Kit

- 项目库：新建、搜索、按平台/状态/更新时间筛选、复制、归档、删除、版本、重新导出、导入恢复。
- Brand Kit：logo/headshot、名称、网站/CTA、颜色、字体、默认页码设置；支持创建、复制、重命名、删除和项目应用。
- 删除 Brand Kit 显示受影响项目，用户必须选择替换 Brand Kit 或保留为项目内联样式。
- 状态：空、加载、保存中、同步失败、删除确认、无权限、会话失效。

### 4.3 Carousel Editor

- 创建时选择 LinkedIn、Instagram 或 TikTok 预设、原创模板、页数、输入方式；之后仍可切换但须展示重排检查。
- 全局设置：模板、调色板（含交替色）、字体/大小/对齐/标题规则、背景渐变/形状/纹理/箭头、圆角、页码、Brand Kit。
- 幻灯片：`intro`、`content`、`outro`；新增、复制、删除、排序；移动端支持上移/下移。
- 页面模式：`text`、`text_image`、`image`、`screenshot`；可控制标题、正文、CTA、图片、页码与背景透明度。
- AI Writing Assistant：improve、rephrase、shorten、simplify、grammar、custom instruction；必须能预览、接受和拒绝。
- 状态：空模板、加载、生成中、部分成功、文字溢出、素材缺失、保存中、离线、会话过期、导出检查失败。

### 4.4 Generator、素材、导出与工具矩阵

- AI Carousel Generator：Topic、Text、URL、Video、PDF、Slides 标签；字段为语言、内容格式、页数、指令、默认指令、重新生成。
- 素材：授权图库搜索、上传、Emoji、URL 截图、AI Image、AI Portrait；`Asset` 显示来源、用户权利声明/许可、处理状态和已绑定页面。
- 导出中心：PNG/JPG ZIP、PDF、PPTX、MP4、Caption；显示版本、尺寸、预览、错误、下载到期和重新导出。
- 独立工具：Caption、LinkedIn Post、Post Ideas、Quote Card、Infographic、Portrait、Carousel-to-Video；从空输入或当前项目启动；任一工具失败不得改写项目。
- 导入恢复：接受 Orincard ZIP/PDF；先展示版本、可恢复 slides/主题/字体/素材与不可恢复项，再让用户确认。

### 4.5 Affiliate 与支持

- Affiliate：申请、审批、唯一链接、cookie 归因、转换、待付/已付佣金、税务资料；退款必须反冲佣金，防自荐和重复归因。
- 支持：账户、账单、导出、版权问题；诊断不含项目正文、原图或支付凭证。

## 5. 内容、编辑、项目与导出契约

### 5.1 输入与来源

- Topic 最大 500 字符，Text 最大 30,000 字符；均为 `[UNVERIFIED-NUMBER]`。
- URL 仅公共 HTTP/HTTPS；拒绝凭证 URL、localhost、私网、重定向私网、付费墙、空正文和不支持 MIME。
- PDF/Slides 必须可提取文本或明确可读图像；失败不得产生空轮播。
- Video 必须公开可访问且用户有权使用；转录/帧提取失败不可伪造内容或截图。

### 5.2 核心对象

- `CarouselProject`：owner、source、platformPreset、slides、ThemeSettings、BrandKit 引用、version、export records、status。
- `Slide`：role、layout、title、body、CTA、image slots、screenshot、counter visible、local overrides、edit version。
- `Template`：原创类别、支持角色/画布、布局约束、默认 ThemeSettings。
- `ThemeSettings`：palette、font、background、counter、corner radius、title rule。
- `BrandKit`：logo/headshot、display name、website/CTA、palette、font、counter defaults。
- `Asset`：source type、rights status、original/derived files、crop/opacity、used-by projects、deletion status。
- `GenerationJob`：input type、outline parameters、language、page count、idempotency key、status、error、usage delta。
- `Entitlement`、`Subscription`、`UsageLedger`：plan、features、balance、ledger、invoice/payment webhook state。

### 5.3 编辑与导出规则

- 每个 Template/画布声明页面文字容量；超限先使用允许布局，再提示缩写/拆页；禁止静默裁切、拉伸或使用不可读字体。
- 局部 AI 写作和素材替换只能影响目标字段/页面；后台重试不得覆盖人工编辑。
- PNG/JPG 按顺序编号并打 ZIP；PDF 一页一 slide；PPTX 保留可编辑文本/图片但不承诺任意设计软件完全兼容；MP4 使用用户有权使用的音频。
- Caption 以纯文本/Markdown 导出，不得声称已发布或自动加未经确认的账号提及。
- 恢复包含 manifest、slide 结构、主题与可恢复资源；不得含未选择源内容或其他项目资产。

## 6. 跨切面决策

| 决策 | 决定 | 状态 |
|---|---|---|
| 语言 | 英文界面/输出优先；模型可支持其他语言但不承诺完整本地化 | 已确认 |
| 认证 | 匿名生成/预览；保存、高清导出、持续使用需注册 | 已确认 |
| 支付 | Free + Pro + Creator；国际支付优先 | 已确认 |
| 保存 | 私有云项目、版本、恢复；个人账户多 Brand Kit | 已确认 |
| 发布 | 仅手动导出，不做社媒账号授权 | 已确认 |
| 团队 | 不做协作、审批、共享工作区 | 已确认 |
| 素材 | 图库、上传、截图、AI Image/Portrait，保留权利信息 | 已确认 |
| 分析 | 仅漏斗、额度、性能、错误类别，不记录全文 | 已确认 |
| SEO/GEO | 官网、免费工具、帮助/案例均为产品分发层 | 已确认 |

## 7. SEO 与 GEO

关键词：AI carousel maker、LinkedIn carousel maker、Instagram carousel generator、TikTok carousel maker、text to carousel、URL to carousel、PDF to carousel、YouTube to carousel、carousel templates、carousel caption generator。

标题：`Orincard — Create Social Carousels with AI`。

Meta：`Turn a topic, text, URL, video, PDF, or slides into editable LinkedIn, Instagram, and TikTok carousels. Design, brand, caption, and export in one workspace.`

答案块：

> Orincard is an AI carousel creator for individual creators. It turns a topic or source into editable LinkedIn, Instagram, and TikTok slides, then lets users apply original templates, brand settings, assets, captions, and export formats for manual publishing.

## 8. 技术可行性初判

| 能力 | 可评估的真实候选 | 难度 |
|---|---|---|
| URL/PDF/Slides 解析 | [Unstructured](https://github.com/Unstructured-IO/unstructured)、[PDF.js](https://github.com/mozilla/pdf.js) | 需要经验 |
| 视频/MP4 | [FFmpeg](https://github.com/FFmpeg/FFmpeg)；转录供应商 tech-spec 决定 | 高风险原型 |
| 受控卡片渲染 | HTML/CSS 模板，评估 [Satori](https://github.com/vercel/satori) | 需要经验 |
| PNG/PDF/PPTX | [sharp](https://github.com/lovell/sharp) 与 PPTX 生成方案，兼容性须原型 | 高风险原型 |
| 图库/AI 图 | 仅选择具明确许可/API 的服务；模型可替换 | 需要经验 |
| 支付/项目/任务 | 支付 webhook、持久化、对象存储、异步任务在 tech-spec 深化 | 需要经验 |

## 9. 核心验收标准

### AC-001 · 匿名模板优先试用 (P0)
- 起始条件：访客未登录且服务可用。
- 触发：选择 LinkedIn、Instagram 或 TikTok 预设并开始 Topic/Text 草稿。
- 预期产出：可选择原创模板、获得可编辑预览且无需注册。
- 禁止副作用：不得云端保存匿名正文、展示竞争品牌或资产。
- 验证方法：全新会话分别走三预设，确认到编辑器前无认证拦截。
- 示例：`[ILLUSTRATIVE-EXAMPLE: “Create a LinkedIn carousel from a topic” opens template selection then a six-slide editable draft.]`
- 优先级：P0
- EARS：WHEN an anonymous visitor starts a valid Topic or Text draft THE SYSTEM SHALL open an editable carousel preview without authentication.

### AC-002 · 六类输入与安全失败 (P0)
- 起始条件：用户位于 AI Carousel Generator。
- 触发：提交 Topic、Text、URL、Video、PDF 或 Slides。
- 预期产出：有效来源创建可观察的 GenerationJob 并生成 Intro/Content/Outro draft；无效来源显示具体替代动作。
- 禁止副作用：不得访问私网、绕过访问控制、伪造视频内容或为失败来源扣额度。
- 验证方法：对六种合法输入和私网重定向、空 PDF、失效视频、超限文件测试。
- 示例：`[ILLUSTRATIVE-EXAMPLE: A URL redirecting to localhost returns “This link can’t be imported. Paste the public text instead.”]`
- 优先级：P0
- EARS：IF any URL redirect resolves to a non-public address THEN THE SYSTEM SHALL stop retrieval and create no generation job.

### AC-003 · AI 轮播结构与局部写作 (P0)
- 起始条件：GenerationJob 已生成 draft。
- 触发：用户生成、重新生成或对选中文本使用 AI Writing Assistant。
- 预期产出：包含 cover、内容页、CTA/outro；局部操作仅修改目标字段并可接受/拒绝。
- 禁止副作用：不得重排其他 slides、丢失人工编辑或承诺事实正确性。
- 验证方法：先编辑两页，再改写第三页，比较其他页文字、顺序与版本。
- 示例：`[ILLUSTRATIVE-EXAMPLE: “Make shorter” changes only “Meetings create activity, not progress.” to “Meetings aren’t progress.”]`
- 优先级：P0
- EARS：WHEN a user accepts an AI rewrite THE SYSTEM SHALL update only the selected text field.

### AC-004 · 模板、主题与三平台重排 (P0)
- 起始条件：项目至少有四张 slides。
- 触发：切换原创模板、ThemeSettings、Brand Kit 或平台预设。
- 预期产出：内容、顺序、素材保留；系统重新布局并报告文字/素材冲突。
- 禁止副作用：不得静默裁切、拉伸、丢失用户局部覆盖。
- 验证方法：三预设×模板类别×长文本/图片/无图片组合比较预览与导出。
- 示例：`[ILLUSTRATIVE-EXAMPLE: Switching an Instagram project to LinkedIn retains all six texts and changes only supported layout geometry.]`
- 优先级：P0
- EARS：IF a target layout cannot contain its text at the minimum readable size THEN THE SYSTEM SHALL block damaged export and show a repair action.

### AC-005 · 逐页编辑与素材能力 (P0)
- 起始条件：用户打开生成或空白项目。
- 触发：新增、复制、删除、排序 slide，或添加图库/上传/截图/Emoji/AI 图/Portrait。
- 预期产出：每页支持四种模式；素材可裁切、调透明度、替换、跨页复用。
- 禁止副作用：不得因删一页删除其他素材；不得导出未确认 AI 图或无权利素材。
- 验证方法：对四种模式和六种素材来源执行添加、替换、裁切、删除与导出检查。
- 示例：`[ILLUSTRATIVE-EXAMPLE: A URL screenshot is attached to slide 4 in screenshot mode while slides 1–3 stay unchanged.]`
- 优先级：P0
- EARS：WHEN a user replaces an asset on one slide THE SYSTEM SHALL preserve every other slide asset and text.

### AC-006 · 导出与视觉完整性 (P0)
- 起始条件：项目通过内容和素材检查。
- 触发：请求 PNG/JPG ZIP、PDF、PPTX、MP4 或 Caption。
- 预期产出：记录版本、预设、文件清单；预览和输出的尺寸/页数一致；失败格式可独立重试。
- 禁止副作用：不得夹带其他项目资源、隐藏源正文或未授权音乐；失败不得删项目或重扣额度。
- 验证方法：逐格式检查尺寸、页数、缺字、裁切、顺序和 manifest。
- 示例：`[ILLUSTRATIVE-EXAMPLE: A six-slide Instagram export contains 01.png–06.png and a six-page PDF in identical order.]`
- 优先级：P0
- EARS：IF export preflight finds missing fonts, overflow, or missing assets THEN THE SYSTEM SHALL list affected slides and prevent that export.

### AC-007 · 注册、云端项目与恢复 (P1)
- 起始条件：匿名草稿或注册用户项目存在。
- 触发：注册、保存、恢复版本、导入 Orincard ZIP/PDF 或删除项目。
- 预期产出：可选择迁移匿名草稿；仅所有者可访问项目；恢复前展示不可恢复项。
- 禁止副作用：不得自动公开/迁移内容；删除后不得继续下载。
- 验证方法：双账号权限、版本、完整/损坏 ZIP/PDF 导入、删除链接测试。
- 示例：`[ILLUSTRATIVE-EXAMPLE: “2 assets could not be restored. Continue with placeholders?” appears before import.]`
- 优先级：P1
- EARS：WHEN a user imports an Orincard package THE SYSTEM SHALL show unrecoverable items before creating the restored project.

### AC-008 · Brand Kit 与资产隔离 (P1)
- 起始条件：用户有两个 Brand Kit 和两个项目。
- 触发：应用、编辑、删除或替换 Brand Kit。
- 预期产出：保存 logo/headshot、名称、网站、颜色、字体与页码；显示项目影响范围。
- 禁止副作用：不得跨账户访问 Brand Kit；删除不得静默改变项目品牌。
- 验证方法：创建、复制、跨项目应用、删除与跨账户访问测试。
- 示例：`[ILLUSTRATIVE-EXAMPLE: Deleting “Consulting Brand” offers “replace with Personal Brand” or “keep project styles.”]`
- 优先级：P1
- EARS：WHEN a Brand Kit is deleted THE SYSTEM SHALL require a replacement or explicit keep-inline-styles decision for each affected project.

### AC-009 · 订阅、额度与账单 (P1)
- 起始条件：账户处于 Free、Pro 或 Creator。
- 触发：升级、续费失败、取消、降级、退款或 AI 操作。
- 预期产出：权益、余额、流水、账单、到期可见；重复支付事件不重复扣/加额度；退款关联权益反冲。
- 禁止副作用：失败任务不得扣额度；取消不得立即删项目；不得暴露支付敏感数据。
- 验证方法：模拟各状态迁移、重复 webhook、失败生成、并发扣减、退款和降级。
- 示例：`[ILLUSTRATIVE-EXAMPLE: “Your Pro plan stays active until 30 September. New projects then use Free limits.”]`
- 优先级：P1
- EARS：IF a payment event is received more than once THEN THE SYSTEM SHALL apply its entitlement change once.

### AC-010 · 工具矩阵互通 (P1)
- 起始条件：用户有项目或进入独立工具。
- 触发：使用 Caption、LinkedIn Post、Post Ideas、Quote Card、Infographic、Portrait 或 Carousel-to-Video。
- 预期产出：支持空输入或项目上下文；结果可带回项目或单独导出。
- 禁止副作用：工具失败不得覆盖 slides、Brand Kit 或其他工具结果。
- 验证方法：从空输入和已有项目启动全部七种工具，检查继承、取消、导出与项目不变性。
- 示例：`[ILLUSTRATIVE-EXAMPLE: Caption Generator pre-fills the carousel title and returns a copyable LinkedIn caption.]`
- 优先级：P1
- EARS：WHEN a companion tool launches from a project THE SYSTEM SHALL inherit only user-selected project context.

### AC-011 · SEO 免费工具与 Affiliate (P2)
- 起始条件：访客访问公开页面或 Affiliate 已批准。
- 触发：访问免费工具、创建链接、归因试用/付费。
- 预期产出：公开页有可索引正文/canonical/CTA；Affiliate 可见链接、转换、佣金状态。
- 禁止副作用：不得索引私有项目或泄露购买者内容/支付数据；退款反冲佣金。
- 验证方法：检查 robots/canonical/sitemap、归因路径、自荐、退款反冲。
- 示例：`[ILLUSTRATIVE-EXAMPLE: “Your referral started a trial. Commission is pending until the refund window closes.”]`
- 优先级：P2
- EARS：WHEN a refunded payment is attributed to an affiliate THEN THE SYSTEM SHALL reverse its commission under the published policy.

## 10. Out of scope

- 团队工作区、实时协作、审批、评论、客户门户；
- Facebook、Threads 等新平台预设；
- 社媒账号授权、直接发布、自动互动、评论管理、账号分析；
- 通用自由画布、复杂矢量设计器、非受控视频剪辑、配音、数字人；
- 抓取任何网页图片、无权使用影视/人物内容或训练用户内容；
- 未验证前的税务自动化、企业采购和团队计费。

## 11. BLOCKER

- `[NEEDS CLARIFICATION: Pro/Creator 的实际价格、额度、页数、高清/PPTX/MP4 权益。]`
- `[NEEDS CLARIFICATION: 国际支付主体、税务地区、退款窗口和 Affiliate 佣金规则。]`
- `[NEEDS CLARIFICATION: 图库、AI Image/Portrait、视频转录和音乐供应商的许可证与可用地区。]`
- `[NEEDS CLARIFICATION: Orincard 商标、域名、隐私政策、用户内容权利声明和数据删除承诺。]`

## 12. 自我审稿结论

| 视角 | 发现的问题 | 已处理 / 待拍板 |
|---|---|---|
| 零上下文 | “照抄”可能被理解为复制受保护资产 | 固定为功能等价、原创实现，并列永久边界 |
| 样例真假 | 登录/支付/下载细节未实测 | 标记竞品未验证；构造示例统一标 illustrative |
| 状态与错误 | 多来源、导出、订阅、恢复容易遗漏失败 | 页面、项目状态和 AC-002/006/007/009 写入失败、重试、隔离 |
| 最脆假设 | 用户可能只用免费工具 | 写入注册/二次项目指标与停止条件 |
| 自相矛盾 | “全量”与“三平台优先”冲突 | 模块完整、平台只锁三种；其他平台需新 Spec |

## 13. Review Gate

用户已批准全量产品方向、提供设计稿，并批准云端技术方向。当前顺序：技术契约与任务编排 → HARD-GATE 2 review → 实现。不得将尚未批准的任务编排视为已完成实现。

## 14. 已批准技术方案的需求澄清

以下按用户最新云端方案及所选设计包落地，不复活历史“知识主稿工作台”方向。

- 设计基线：`docs/design/reference/`；原竞品研究仅为历史证据，未复制进产品仓库。五个 HTML 是模拟交互设计，不是后端实现。
- `[ASSUMPTION: 采用已选设计的产品边界]` 页数 4–12，默认 6；LinkedIn/Instagram 为 1080×1350，TikTok 为 1080×1920。这是 Orincard 预设，不宣称平台唯一可用尺寸。
- 匿名 Topic/Text 仅短请求临时处理；不在项目库、Storage 或任务平台持久保存正文；浏览器草稿 24 小时失效。注册迁移需用户确认。云端供应商的数据保留政策另行披露，不把“不存项目”表述为供应商绝对不留存。
- `.pptx` 为 Slides 导入格式；`.key` 提示先转 PPTX。普通 PDF 是来源导入；仅带 Orincard 恢复附件的 PDF 能还原编辑项目。
- 所有视觉导出均受文字、字体、素材 preflight 阻断；Caption 可独立导出。恢复包默认不包含原始输入正文、内部提示、账号/支付标识或其他项目资源。
- 删除立即阻止后续授权下载和任务写回；对象物理清理异步完成。已下载文件不可撤回。
- 品牌应用为快照；用户显式更新才影响已有项目；保留单页覆盖。
- 开发先用 Sandbox；真实价目、退款窗口、Affiliate 佣金以及支付/模型账号资格仍是公开上线阻断，不以假账号或假支付代替。
- 技术默认预算为开发 AI $10/月、每用户长任务并发 1、全局导出并发 2；这些是保护开发账单的技术限额，不是 Free/Pro/Creator 的销售权益。
- 订阅优惠码机制包含在Stripe托管Checkout，服务端控制允许的promotion code配置；不另建优惠券营销引擎。公开售价、折扣和佣金数值仍受用户批准的政策约束。
