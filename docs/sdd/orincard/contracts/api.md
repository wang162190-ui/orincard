# HTTP、任务与错误契约

> source: docs/sdd/orincard/spec.md

2026-09-04，Gate 2 review；下列为内部产品API，不对外承诺公共开发者API。

## 1. 通用约定

前缀`/api/v1`。JSON请求和响应；二进制直传Storage。会话由Supabase验证；服务端不信任getSession返回的用户对象做授权。CSRF检查Origin、SameSite cookie及允许站点；敏感操作重新检查账户状态。列表默认20条、最大50条，返回不透明cursor，按updated_at+id稳定排序。

成功：`{data: ..., requestId: string}`。失败：`{error:{code,message,retryable,fields?,affectedSlideIds?},requestId}`。message用于UI，不回传堆栈、数据库表名、文件key或供应商原始错误。

写请求携带`Idempotency-Key`；保存另带`expectedRevision`。验证当前会话/所有者后，先查同一owner+operation+key+requestHash的业务回执，存在则重放原ID/revision，不用已经变化的版本再拒绝成功操作；同key不同内容返回409 IDEMPOTENCY_CONFLICT。仅新操作才做CAS/来源有效期校验。已删除资源不因回执恢复访问权。普通写回执30天、过期摘要90天内返回410 OPERATION_EXPIRED；支付事件永久业务唯一。离线缓存只保存自己当前账号草稿，不共享cookie内容。

## 2. 项目与品牌（AC-003/004/007/008）

| 方法/路径 | 请求 | 成功产物 | 失败与禁止副作用 |
|---|---|---|---|
| POST /projects | document；可选localDraftId和explicitMigrationConsent | 201 projectId/revision=1 | 无同意不迁移匿名；schema不合法422；不信任包内owner |
| GET /projects | cursor、platform、state、q | 项目摘要列表，不带全文原件 | 未登录401；仅本人 |
| GET /projects/:id | 无 | document/revision/saveState | 非本人/已删除404，避免枚举 |
| PUT /projects/:id | expectedRevision、document | 新revision、savedAt、documentHash | 409 VERSION_CONFLICT；旧内容不覆盖 |
| POST /projects/:id/duplicate | expectedRevision、title | 新projectId | 只复制拥有权利的资源引用，不复制账单/任务 |
| POST /projects/:id/archive | expectedRevision、archived boolean | 新state/revision | 不删除来源/素材 |
| GET /projects/:id/versions | cursor | 不可变快照摘要 | 不返回其他项目版本 |
| POST /projects/:id/restore | expectedRevision、versionId | 新revision | version不属于该项目404；不修改历史 |
| DELETE /projects/:id | expectedRevision、confirmation=项目标题 | 202 deletionJobId | 立即阻止新授权下载；异步物理清理不假报完成 |
| GET/POST /brand-kits | GET分页；POST name/settings | 列表或新kit/revision | 跨账号素材422/404 |
| GET/PUT /brand-kits/:id | GET无；PUT expectedRevision、settings、可选name（省略则保留原名） | GET返回kit与受影响项目清单；PUT返回新kitVersion | 非本人404；PUT并发冲突409，且不自动重写已应用该kit的项目 |
| POST /brand-kits/:id/apply | projectId、expectedProjectRevision、previewConfirmed | 新project revision/品牌快照 | 模板不适配先preflight，无确认不改变 |
| POST /brand-kits/:id/duplicate | expectedRevision、name | 新kitId/revision=1 | 只复制同owner可用资源，不继承其他账户权限 |
| DELETE /brand-kits/:id | expectedRevision、affectedProjects[{id,expectedRevision,action,replaceKitId?}] | 202处理结果 | 项目集合已变409；不允许漏选影响项目 |
| GET/PATCH /settings | GET无；PATCH偏好字段白名单 | 当前偏好或已保存偏好 | 仅本人；不能写plan、quota或role |
| POST /account/export | 用户确认 | 202 jobId | 只导出本人数据，不包含认证密钥、支付凭证 |
| GET /account/export | jobId | 本人已完成数据包的授权下载信息 | job必须为本人account_export，非本人404、过期410，不读其他job文件 |
| DELETE /account | 重新认证、明确确认 | 202 deletionJobId | 先停用并撤销会话；失败可恢复清理任务，不恢复使用权 |

## 3. 输入、生成与工具（AC-001/002/003/010）

| 方法/路径 | 请求 | 成功产物 | 失败/不变性 |
|---|---|---|---|
| POST /guest/generate | topic或text、语言、模板、页数、session nonce | NDJSON阶段消息+最终Document | 短请求仅临时处理；不建云来源；中断明确不可后台恢复 |
| POST /sources | kind、text/url或已验证assetId | sourceId，必要时parse jobId | 输入安全校验失败不创建生成任务、不扣生成额度 |
| POST /generation | sourceId、language、format、pageCount、instructions、templateId、platform | 202 jobId | 429额度/预算/并发；不直接写已有项目 |
| POST /projects/:id/regenerate | expectedRevision、参数、明确确认 | 候选文档jobId | 已编辑稿不自动覆盖；用户另行接受 |
| POST /projects/:id/rewrite | slideId、field、baseSlideRevision、action、instruction | 202 jobId，结果为before/after提案 | 仅选定字段；服务端使用指定版本，不信任客户端拼接全部项目 |
| POST /projects/:id/apply-proposal | proposalJobId、expectedRevision、baseSlideRevision | 新revision | 提案不属于本用户/目标字段已变则拒绝 |
| GET /jobs/:id | 无 | state/stage/progress/error/resultRef | 仅本人，无内部provider payload |
| POST /jobs/:id/retry | 原任务ID、同逻辑操作 | 相同业务jobId或受关联attempt | 只重试可重试阶段；不重复结算成功步骤 |
| POST /jobs/:id/cancel | 无 | cancel_requested或terminal状态 | 已执行外部调用费用仍入成本账；未交付用户结果不扣产品额度 |
| GET/POST /tools/:tool | GET jobId；POST typedInput、可选projectId+expectedRevision+selectedContext | GET返回该工具任务的state/progress与候选；POST 202 jobId/resultType | 仅七个注册工具；GET仅本人且候选工具须与路径一致否则404；失败不修改项目 |
| POST /tools/:tool/apply | resultJobId、projectId、expectedRevision、target | 新revision或新项目 | 必须显式应用；Portrait仍需素材确认 |

guest结果不持久化意味着无法从服务器再次取回。重复已完成匿名请求返回410 RESULT_NOT_RETAINED并提示重试或用本地结果，不偷偷重新收费/调用。匿名无货币扣费，但反滥用限制仍适用。注册长任务结果可按jobId恢复。

## 4. 素材与导出（AC-005/006/007）

| 方法/路径 | 请求 | 响应/契约 |
|---|---|---|
| POST /assets/upload-intent | originalName、declaredMime、size、purpose、rightsConfirmation | 指定assetId和上传授权；服务端选bucket/key，过期可刷新但不能覆盖已有对象 |
| POST /assets/:id/complete | 无 | 202与assetId/state，客户端经RLS轮询assets行；按实际字节/MIME/大小校验后才ready。不为素材验证建job：每用户并发名额为1，占用它会让上传期间无法生成 |
| GET /assets | cursor、kind | 本人可用素材及候选列表；不返回source原件或他人内容 |
| POST /assets/:id/accept | rightsConfirmation、keepInLibrary boolean | 记录accepted_at；无确认不能将AI候选放入项目或导出 |
| GET /assets/search | Pexels query/orientation/cursor | 缩略图、作者、来源及许可信息；导入需用户选择 |
| POST /assets/import-stock | providerId、确认许可 | 导入任务；不把任意第三方URL当授权图库 |
| POST /assets/screenshot | publicURL | 安全截图任务；无私网、无登录会话、无凭证 |
| POST /assets/generate | image或portrait、prompt、可选本人授权参考assetId | 候选asset job；用户接受前不可自动放入导出 |
| DELETE /assets/:id | expectedState、替换/解除引用方案 | 有活引用409 ASSET_IN_USE；展示影响范围，不删别的页 |
| POST /projects/:id/preflight | expectedRevision、format、options | issues[]、canExport、documentHash；纯检查不扣额度 |
| POST /projects/:id/exports | expectedRevision、formats[]、options、confirmedWarnings | 202 exportIds/jobIds；冻结同一快照，每格式独立记录 |
| GET /exports | projectId可选、cursor | 历史导出、到期、失败重试状态 |
| POST /exports/:id/download | 无 | 授权的Storage authenticated endpoint信息；客户端带JWT发起下载，不返回可分享长期签名URL |
| POST /imports/inspect | verifiedAssetId | 202 inspection job；包结构/资源缺失/大小/版本报告 |
| POST /imports/:jobId/confirm | inspectionHash、接受缺失资源boolean | 新projectId；预览变化则409，拒绝过期检查 |
| POST /tools/outputs/:id/download | format、可选exportId | 根据owner/toolOutput/job授权的下载信息；无需创建轮播项目；文件未生成时202，过期410 |

GET私有资源禁用公共缓存，响应`Cache-Control: private, no-store`。已过期导出返回410 EXPORT_EXPIRED和重新导出入口。下载按钮根据浏览器能力使用流式保存；fallback Blob设开发上限50MiB、生产100MiB，超过则提示受支持浏览器/按格式或页分包，不一次把无限大视频读进内存。这是下载实现安全限制，不伪装为生成成功。

## 5. 支付、Affiliate和支持（AC-009/011）

- POST /billing/checkout：planKey、interval（月/年），服务端解析允许priceId、优惠码策略和当前用户customer，返回托管Checkout URL；不信任客户端金额/折扣；production policy未配置503 BILLING_NOT_CONFIGURED。
- POST /billing/portal：无customerId输入；使用当前用户映射返回Portal URL。
- GET /billing：当前权益、周期、账单安全摘要、额度；不读取客户端自报plan。
- POST /webhooks/stripe：验证原始body签名，持久记录事件后应答，异步重试；没有持久化成功不得应答“已接收”。
- POST /affiliate/apply、GET /affiliate/dashboard：申请/查看脱敏归因与佣金；批准通过内部受控运维，不提供客户端改审批状态的接口。
- POST /affiliate/attribute：同意记录+推荐码，由服务器校验非自荐、窗口和规则版本。未同意不设置营销归因cookie。
- POST /support：category、message、用户选择的diagnosticRefs；不能自动附原文。

真实收费、退款和Affiliate payout均由配置开关阻断直至政策和主体确认；Sandbox seed只是`[ILLUSTRATIVE-EXAMPLE: 测试价目与政策]`，绝不能出现在公开价格页作为真实承诺。

Affiliate申请返回affiliateAccountId/state；批准后返回唯一码与脱敏汇总。审批/暂停、税务资料核验和已付款记录只由受控运维命令处理，有环境确认、授权和审计；不是用户可调用的公开接口，不自行保存证件/税号原件。

## 6. 错误码与验收

400 INVALID_REQUEST；401 AUTH_REQUIRED/SESSION_EXPIRED；403 FEATURE_NOT_ALLOWED/ACCOUNT_DISABLED；404 NOT_FOUND；409 VERSION_CONFLICT/IDEMPOTENCY_CONFLICT/ASSET_IN_USE；410 RESULT_NOT_RETAINED/EXPORT_EXPIRED；413 FILE_TOO_LARGE；415 UNSUPPORTED_FORMAT；422 EMPTY_SOURCE/OCR_FAILED/INVALID_PACKAGE/EXPORT_PREFLIGHT_FAILED/UNSAFE_URL；429 QUOTA_EXCEEDED/BUDGET_EXCEEDED/CONCURRENCY_LIMIT/RATE_LIMITED；502 PROVIDER_FAILED；503 SERVICE_UNAVAILABLE/BILLING_NOT_CONFIGURED。只有网络、速率或供应商临时故障retryable=true；业务不合法必须先修输入。

每个端点测试合法/非法输入、身份隔离和重复操作；不以单个200证明完整授权。所有成功响应的版本/任务/下载内容必须能追溯到实际数据库和文件，不返回硬编码成功。
