# 数据模型、事务和隔离

> source: docs/sdd/orincard/spec.md

2026-09-04，Gate 2 review。以下为DDL实施契约；本次没有创建任何线上表。

## 1. 约定

每张表的“用途”即必须写入的 COMMENT ON TABLE。字段行中的中文说明即必须写入 COMMENT ON COLUMN；用逗号并列字段时每个字段分别写注释。通用字段也必须展开，不得只注释新字段。`id uuid pk`注释“记录唯一标识”、`created_at timestamptz not null`注释“创建时间（UTC）”、`updated_at`注释“最近修改时间（UTC）”。所有owner引用auth.users；删除账户先标记停用再按清理工作流处理，不用级联删除掩盖对象清理失败。

业务表优先 public + RLS。安全事件、支付原始元数据和预算管理表放private非暴露schema。禁止直接写auth/storage/realtime内部表。文档JSON使用应用Zod+DB关键约束双校验；可查询状态、所有者、版本不要藏在JSON里。用户输入不可修改owner_id、quota或subscription字段。

## 2. 用户与项目（AC-001/003/004/007）

### profiles — 用户公开工作区配置与账户访问状态

| 字段 | 类型/约束 | COMMENT |
|---|---|---|
| id | uuid pk, auth.users.id | 用户唯一标识，与认证主体一致 |
| display_name | text | 用户显示名称 |
| preferences | jsonb | 默认语言、语气、页数、生成指令；不含权益 |
| status | active/deleting/deleted | 账户访问及删除流程状态 |
| created_at, updated_at | timestamptz | 创建/修改时间（逐列注释） |

### projects — 私有轮播当前稿

| 字段 | 类型/约束 | COMMENT |
|---|---|---|
| id, owner_id | uuid pk/fk | 项目标识；所有者标识（逐列注释） |
| title | text | 项目库显示标题，与文档标题事务内同步 |
| platform | linkedin/instagram/tiktok | 当前输出平台预设 |
| document | jsonb | CarouselDocument当前内容，不含原始文件字节 |
| revision | bigint, >=1 | 乐观并发控制版本 |
| brand_kit_id | uuid nullable | 当前关联品牌，删除可解除但不丢快照 |
| state | draft/archived/deleting/deleted | 项目生命周期状态 |
| deleted_at | timestamptz nullable | 逻辑删除时间，立即影响授权 |
| created_at, updated_at | timestamptz | 创建/修改时间 |

### project_versions — 不可变项目快照

字段：id(uuid pk，版本记录标识)；project_id(uuid fk，所属项目)；owner_id(uuid，所有者)；revision(bigint，所保存编辑版本)；document(jsonb，完整文档快照)；reason(text，manual/pre_generation/export/restore)；created_at(timestamptz，快照创建时间)。唯一(project_id,revision)。恢复创建新revision，不修改旧快照。不是每次按键都新增一条历史。

### project_asset_refs — 当前稿及历史版本的素材引用保护

字段：id(uuid pk，引用标识)；project_id(uuid fk，所属项目)；version_id(uuid nullable，空为当前稿，非空为快照)；asset_id(uuid fk，素材标识)；slot_key(text，引用槽位)；created_at(timestamptz，建立时间)。两个partial unique分别约束当前稿(project_id,asset_id,slot_key)和历史(version_id,asset_id,slot_key)。存档或切换不物理删除被历史引用的资源。

## 3. 品牌、来源与文件（AC-002/005/007/008）

### brand_kits — 可复用品牌配置

字段：id(uuid pk，品牌标识)；owner_id(uuid，所有者)；name(text，品牌名称)；settings(jsonb，显示名称/网站/CTA/颜色/字体/页码配置及资源引用)；revision(bigint，编辑版本)；state(active/deleting/deleted，生命周期)；created_at/updated_at(timestamptz，创建/修改时间)。已应用项目使用brandSnapshot；读项目不实时展开此表。

### brand_asset_refs — 品牌素材引用保护

字段：brand_kit_id(uuid fk，品牌标识)；asset_id(uuid fk，素材标识)；slot_key(text，logo/headshot等用途)；created_at(timestamptz，建立时间)。复合主键(brand_kit_id,asset_id,slot_key)。仅同owner素材可引用。

### assets — 用户素材及处理后的派生文件元数据

字段：id(uuid pk，素材标识)；owner_id(uuid，所有者)；kind(upload/stock/screenshot/ai_image/portrait/audio，来源类别)；bucket(text，私有桶)；object_key(text，不可猜测对象键)；mime(text，服务端检测类型)；bytes(bigint，实际大小)；sha256(text，内容校验值)；width/height(integer nullable，图片像素)；duration_ms(bigint nullable，媒体时长)；parent_asset_id(uuid nullable，派生源素材)；rights(jsonb，来源链接/作者/许可/用户确认/供应商版本)；state(pending_upload/validating/ready/failed/deleting/deleted，资源状态)；error_code(text nullable，公开错误类别)；created_at/updated_at(timestamptz，创建/修改时间)。资源必须ready且rights已确认才能导出。对象新版本写新key，不upsert覆盖正在使用的文件。

补充字段：purpose(source/media/export/tool_output/account_export，用途与授权策略)；accepted_at(timestamptz nullable，用户接受候选素材的时间)。kind增加derived，表示渲染/处理产物。ready只表示技术校验通过；AI图片/Portrait还必须accepted_at非空才能应用或导出。上传的PDF/PPTX/视频以purpose=source保存，不能因同owner就混入素材图库或恢复包。

library_retained(boolean，用户明确保留在个人素材库，默认false)区分可独立复用素材和仅项目临时资源。media下载还要求library_retained或存在未删除项目/品牌/未过期工具结果的活引用；未绑定的新上传可由本人在验证完成后的24小时选择/预览。删除项目立即使仅属于该项目的资源失去下载资格，个人库或其他活引用保留时必须在删除确认中说明。

### sources — 已注册用户的输入资产及解析定位

字段：id(uuid pk，来源标识)；owner_id(uuid，所有者)；project_id(uuid nullable，所属项目)；kind(topic/text/url/pdf/slides/video，输入类别)；asset_id(uuid nullable，原始文件引用)；metadata(jsonb，标题/公开URL/页数/时长)；segments(jsonb或private对象引用，带稳定segmentId的段落/页码/时间定位)；state(uploading/parsing/ready/failed/deleted，处理状态)；expires_at(timestamptz，原始正文清理时间)；created_at/updated_at(timestamptz，创建/修改时间)。文本不写日志；匿名不建此记录。默认输入原件和全文7天清理，项目可见文案/用户保留的引用不随其删除；清理后重生成要求重新提供来源，UI提前说明。

## 4. 任务、导出和额度（AC-002/003/006/009/010）

### jobs — 异步任务与事务outbox

字段：id(uuid pk，业务任务编号)；owner_id(uuid，所有者)；project_id(uuid nullable，所属项目)；kind(generation/rewrite/parse/asset/export/tool/cleanup，任务类型)；input_ref(jsonb，只含经过授权的ID、参数和基础版本)；idempotency_key(text，逻辑请求标识)；request_hash(text，参数一致性摘要)；state(pending_dispatch/queued/running/succeeded/partial/failed/canceled，任务状态)；stage(text，解析/生成/渲染等阶段)；progress(integer 0..100，阶段进度非虚假精确耗时)；provider_run_id(text nullable，云任务编号)；attempt(integer，尝试次数)；heartbeat_at(timestamptz nullable，最近活动时间)；result_ref(jsonb nullable，结果资源/候选内容引用)；error_code(text nullable，用户错误类别)；created_at/updated_at/finished_at(timestamptz，创建/更新/结束时间)。唯一(owner_id,kind,idempotency_key)。任务terminal不可被旧回调改回running。

补充字段：cancel_requested_at(timestamptz nullable，取消请求持久化时点)；parent_job_id(uuid nullable，多格式协调父任务)；lease_token(uuid nullable，当前尝试写回令牌，拒绝过期worker)。kind增加account_export与import。API的cancel_requested由未终态+cancel_requested_at派生，不是遗漏在数据库外的内存标记。cancel与finalize锁同一job：若先提交取消，结果不交付、释放用户额度；若先成功，取消返回已完成且不重复释放。供应商已发生费用始终如实记账。

### tool_outputs — 不依赖轮播页数的独立工具结果

字段：id(uuid pk，工具产物标识)；owner_id(uuid，所有者)；job_id(uuid unique，产物任务)；tool(text，七工具枚举)；result(jsonb，符合ToolResult schema的文本或视觉文档，不含原文/密钥)；context_project_id(uuid nullable，用户明确选取的上下文项目)；context_revision(bigint nullable，上下文版本)；state(ready/expired/deleted，状态)；expires_at(timestamptz，结果保留期限，默认7天)；created_at(timestamptz，生成时间)。独立Quote或Infographic不伪造四页CarouselProject。只读本人结果，应用回项目须重新校验版本。

### tool_output_asset_refs — 独立工具的资源引用保护

字段：tool_output_id(uuid fk，工具结果)；asset_id(uuid fk，所引用素材)；slot_key(text，文件或版面槽位)；created_at(timestamptz，建立时间)。复合主键(tool_output_id,asset_id,slot_key)，仅允许同owner。到期/删除解除引用后，仍被其他活项目或工具使用的素材不清理。

### exports — 固定项目版本的单格式导出记录

字段：id(uuid pk，导出标识)；owner_id(uuid，所有者)；project_id(uuid，所属项目)；project_version_id(uuid，固定快照)；job_id(uuid，生成任务)；format(png_zip/jpg_zip/pdf/pptx/mp4/caption_txt/caption_md，格式)；options(jsonb，恢复附件/音频/时长等选项)；renderer_version(text，渲染版本)；manifest(jsonb，尺寸/顺序/文件哈希)；asset_id(uuid nullable，成品对象)；state(pending/ready/failed/expired/deleted，产物状态)；expires_at(timestamptz，默认7天到期)；created_at(timestamptz，创建时间)。到期可按仍存在的项目版本重导出；不承诺源全文清理后仍能重新AI生成。

主体扩展：project_id/project_version_id改为nullable，新增tool_output_id(uuid nullable，独立工具主体)、account_export_job_id(uuid nullable，账号数据包主体)。CHECK要求“项目+版本”“独立工具”“账号导出任务”三类恰好一类；所有引用同owner。format增加png/jpg（独立单图）和account_zip；前端不能通过指定account_zip绕过账号导出确认。每个主体都必须在授权时检查存在、状态和期限，不能仅凭assetId下载。

### usage_accounts — 用户周期内额度桶

字段：id(uuid pk，额度桶标识)；owner_id(uuid，用户)；period_start/period_end(timestamptz，权益周期)；resource(text，generation/image/minute/export等资源)；granted/reserved/consumed(bigint，授予/预留/消耗单位)；updated_at(timestamptz，修改时间)。唯一(owner_id,period_start,resource)。可用量=granted-reserved-consumed，不能为负。reserved >=0，consumed >=0。没有“编辑前无限免费重生”隐式特权。

### usage_ledger — 只追加的额度流水

字段：id(uuid pk，流水标识)；account_id(uuid，额度桶)；job_id(uuid nullable，关联任务)；event_key(text unique，幂等业务事件)；kind(grant/reserve/settle/release/reversal，流水类别)；units(bigint，单位变化量)；created_at(timestamptz，发生时间)。事务同时变更额度桶和写流水，不能只写其中一个。退款反冲未消耗授权，不删除既有消耗证据；出现透支标记暂停新付费任务而非篡改历史。

### private.cost_budgets — 环境月度AI供应商成本预算

字段：period(text YYYY-MM，UTC月份主键的一部分)；environment(text，环境主键的一部分)；limit_micro_usd/reserved_micro_usd/spent_micro_usd(bigint，预算/预留/实耗)；updated_at(timestamptz，修改时间)。单位为微美元。用户不能访问或写入。超预算停止新外部调用，人工调高需审计。

### private.cost_reservations — 请求级可恢复成本预留

字段：id(uuid pk，成本预留标识)；job_id(uuid nullable，注册任务)；guest_guard_id(uuid nullable，匿名请求元数据)；environment/period(text，预算归属环境和UTC月份)；operation_key(text unique，逻辑成本预留幂等键)；reserved_micro_usd/settled_micro_usd/released_micro_usd(bigint，预留/已结算/已释放金额)；state(open/unknown/settled/released，预留状态)；created_at/updated_at(timestamptz，创建/修改时间)。job或guest恰有一个。汇总预算与本记录在同一事务更新；匿名仅保存金额及不可逆请求关联，不存正文。跨月新外部调用先将尚未使用部分在固定锁顺序下迁移到新月份，旧attempt的未知成本仍归原调用月份，不从新月重复扣。

guest_guard_id不建阻止24小时TTL清理的外键；guard清理后仅留下无法恢复内容/身份的成本编号和金额，不保留请求摘要或IP关联。成本账与用户内容保留政策分别说明，不因对账延长匿名正文存储（正文从不落盘）。

### private.cost_attempts — 每次供应商调用的成本审计

字段：id(uuid pk，尝试标识)；reservation_id(uuid fk，请求成本预留)；attempt_key(text unique，job/stage/attempt幂等标识)；provider_operation_id(text nullable，提供商可对账编号)；state(planned/sent/unknown/settled，调用状态)；usage(jsonb，仅token/分钟/秒数等数字)；actual_micro_usd(bigint nullable，实际成本)；started_at/settled_at(timestamptz，调用/结算时间)。发送前记录，超时保留unknown和预留，不因浏览器断开就释放；对账或保守成本确认后才能结算。重复回调不重复入账；不可查询的供应商故障按保守预估占用预算并标明非实测。真实费用高于预估仍如实记账并停新调用，预算不是供应商硬封顶。

### private.operation_receipts — 非任务写操作的幂等回执

字段：id(uuid pk，回执标识)；owner_id(uuid，操作所有者)；operation(text，端点和资源类型)；idempotency_key(text，客户端操作号)；request_hash(text，请求HMAC摘要)；status(completed/failed，结果类别)；response_ref(jsonb，仅对象ID/revision/状态/HTTP码，不含文档正文)；created_at/expires_at(timestamptz，创建/回执期限)。唯一(owner_id,operation,idempotency_key)。项目保存、复制、品牌应用、恢复确认与回执在同一事务提交；未提交无成功回执。有效回执保留30天，过期幂等键留下拒绝重放的摘要tombstone至90天，客户端操作号不得复用。回执不授予访问已删除资源的能力。

### private.request_guards — 匿名/注册请求去重和速率窗口

字段：id(uuid pk，保护记录标识)；subject_hash(text，带环境盐的用户/session/IP窗口摘要，不存原始IP)；operation_key(text，操作编号)；request_hash(text，HMAC输入摘要不存正文)；state(text，请求状态)；window_start(timestamptz，计数窗口)；count(integer，请求次数)；expires_at(timestamptz，清理时间)。唯一(subject_hash,operation_key)。匿名完成结果只在浏览器，连接中断不能从此表恢复正文；元数据24小时内清理。

## 5. 商业化与运营（AC-009/011）

### subscriptions — 供应商订阅镜像

字段：id(uuid pk，订阅记录)；owner_id(uuid，用户)；provider_customer_id/provider_subscription_id(text unique，Stripe关联标识)；plan_key(free/pro/creator，产品档位)；policy_version(text，权益配置版本)；status(text，供应商有效状态)；current_period_start/current_period_end(timestamptz，已付周期)；cancel_at_period_end(boolean，期末取消)；provider_updated_at(timestamptz，已同步时点)；updated_at(timestamptz，镜像更新时间)。不存卡号。单账号仅一个有效订阅。

### private.billing_events — 已验签支付事件与处理记录

字段：provider_event_id(text pk，供应商事件唯一ID)；type(text，事件类别)；subject_id(text，对应订阅/发票ID)；status(received/processing/applied/failed，处理状态)；attempt(integer，处理次数)；error_code(text nullable，安全错误码)；received_at/applied_at(timestamptz，接收/应用时间)。不保存完整支付payload。事件重复返回成功但不重复授权；乱序通过查询供应商当前状态和发票唯一事件键收敛。

### affiliate_accounts — Affiliate申请、审批和唯一推荐码

字段：id(uuid pk，申请账户标识)；owner_id(uuid unique，申请用户)；application(jsonb，用户主动提供的渠道与申请信息)；state(applied/approved/rejected/suspended，审批状态)；referral_code(text unique nullable，批准后生成的唯一码)；policy_version(text，批准采用的规则版本)；tax_status(missing/verified，受控税务资料核验结果，不存税号/证件原件)；payout_reference(text nullable，受控收款记录编号，不返回公开端点)；reviewed_at(timestamptz nullable，审批时间)；created_at/updated_at(timestamptz，申请/修改时间)。普通用户只能申请和读取脱敏状态，不能写审批/收款状态。受控运维工具审批并写审计，payout开关未开启不能标真实付款成功。

### referrals — 经同意记录的Affiliate归因

字段：id(uuid pk，归因标识)；affiliate_owner_id(uuid，推荐人)；referred_owner_id(uuid nullable，被推荐人)；code(text，公开推荐码)；policy_version(text，归因规则版本)；consent_at(timestamptz，用户同意时间)；attributed_at(timestamptz，归因时间)；expires_at(timestamptz，窗口结束)；state(text，有效/自荐拒绝/撤销)。支付前由服务端绑定，推荐人不能看到被推荐人的邮件/项目/支付详情。唯一有效被推荐账号归因。

referrals新增affiliate_account_id(uuid fk，已批准的推荐账户)，code为归因当时的快照；实时入口检查账户仍approved，不从任意自由文本推定推荐人。

### commissions — 佣金与冲销流水

字段：id(uuid pk，佣金标识)；referral_id(uuid，归因记录)；provider_invoice_id(text，关联账单)；policy_version(text，计算规则)；amount_minor(integer，最小货币单位)；currency(text，币种)；state(pending/eligible/paid/reversed，佣金状态)；reversal_of(uuid nullable，被冲销流水)；created_at/updated_at(timestamptz，创建/修改时间)。唯一业务事件防止重复计算；已付退款形成负向调整，不删除已付证据。真实支付默认关闭。

### support_tickets — 用户支持申请

字段：id(uuid pk，工单标识)；owner_id(uuid，申请用户)；category(text，账号/账单/导出/版权)；message(text，用户主动提交内容)；diagnostic_refs(jsonb，用户选定项目/任务ID，不自动附正文)；status(open/closed，处理状态)；created_at/updated_at(timestamptz，创建/修改时间)。支持人员仅经受控管理入口处理，不提供用户可提升角色字段。

### private.audit_events — 最小化安全与运营审计

字段：id(uuid pk，事件标识)；actor_id(uuid nullable，行为主体)；kind(text，操作类别)；resource_id(uuid nullable，对象标识)；request_id(text，追踪编号)；safe_metadata(jsonb，允许字段白名单)；created_at(timestamptz，事件时间)；expires_at(timestamptz，保留截止)。禁止正文、API密钥和原始支付事件入库。

模板、价目配置版本、静态帮助/SEO内容保存在审核过的代码/内容文件；不额外建CMS数据库。正式价目缺失时生产启动校验失败；测试使用明确标记的fixtures。

## 6. RLS与权限矩阵

| 数据 | 匿名 | 注册所有者 | 后台任务/支付 | 删除后 |
|---|---|---|---|---|
| 公开模板/内容 | 静态读取 | 读取 | 发布流程修改 | 按发布规则 |
| profiles | 无 | 读自己的允许字段；设置经服务层更新 | 受控状态变更 | 禁止工作区 |
| projects/versions | 无 | 读；写入经CAS RPC | 只对绑定job校验后写候选 | 禁止新读取/写回 |
| assets/sources/brands | 无 | 自己的ready资源；带校验写入 | 有限处理权 | 授权查询即拒绝 |
| jobs/exports/tool_outputs | 无 | 读自己的安全状态/产物；提交经接口 | 状态转换/回写 | 禁止结果暴露 |
| usage/subscriptions | 无 | 只读自己的摘要 | 事务内写入 | 不得重启消耗 |
| affiliate_accounts/referrals/commissions | 无 | 读本人申请状态；批准后读取脱敏摘要 | 受控审批/计费/冲销 | 按政策合法保留 |
| private.* | 无 | 无 | 只允许相应内部操作 | 审计按保留策略 |

所有exposed表启用RLS并显式最小GRANT；UPDATE包含USING+WITH CHECK。所有权关系通过复合约束/服务端SQL检查同owner，禁止只验证根项目后拼任意assetId。public函数默认撤销PUBLIC EXECUTE；写RPC不得允许绕过CAS/额度。需要特权的函数放private，固定search_path并仅给内部可信角色，调用方身份从已验证会话取得。服务密钥仅worker/服务端持有，绝不将“有密钥”当作“无需owner检查”。

Storage桶：sources、assets、exports，均private；对象key为ownerUUID/resourceUUID/version/file。SELECT策略首先校验账户和同owner，再按purpose检查主体：source检查来源未过期；media检查个人素材未删且ready；export检查其项目/版本未删且成品未过期；tool_output检查工具结果及任务；account_export检查已确认的本人导出任务。项目引用资源还须检查当前访问项目状态；个人素材库不因没有项目引用而无法读取。禁止签名下载绕过判断。原件上传先创建pending资产并签发指定key授权，不允许改bucket或覆盖已有key。

## 7. 必须原子化的操作

1. save_project：验证会话/账户/owner访问资格 → 按key/hash读取操作回执，存在则返回同ID/revision或键冲突，不再拿旧expectedRevision做CAS → 新操作才校验state/expectedRevision → 更新文档/引用/快照 → 同事务保存回执。响应丢失重试不产生新版本；零行匹配且无回执才是版本冲突。
2. submit_job：验证会话/账户/owner → 先检查已有job的幂等key+requestHash；已有操作返回原job，不因来源已到期重复扣或再次执行 → 新操作才校验来源/版本/策略 → 行锁额度和环境预算 → 插入请求级预留及pending_dispatch任务，同事务提交。提交失败全部回滚；已删除资源仍不可从重放结果取得正文。
3. dispatch_job：事务外调用Trigger；以jobId作幂等key。投递超时保留pending_dispatch，由定时reconciler重试；不能重复预留。
4. finalize_job：锁job/取消标记/当前lease与流水 → 核对状态/主体删除/版本 → 保存候选或产物 → settle或release → 标记terminal。成本attempt结算与用户额度分开记录；重复完成不重复扣减，取消先提交则不交付；旧revision不能直接覆盖当前稿。
5. restore_project：校验全部引用和包大小 → 新建project、version和新资源映射 → 失败清理已上传临时对象，不出现半个可访问项目。
6. delete_project/account：先停用/逻辑删除 → 拒绝下载与任务写回 → 清理引用、无其他活引用的对象和原件 → 记录完成。失败保持deleting并可重试；不泄漏对象路径。
7. apply_billing_event：事件唯一键 → 获取最新订阅/账单 → 幂等授予或反冲 → 写脱敏审计，不能因事件时间戳近似比较漏处理不同发票。

## 8. 索引与测试要求

索引：projects(owner_id,state,updated_at desc)、assets(owner_id,state)、sources(expires_at)、jobs(state,updated_at)、jobs(owner_id,created_at)、exports(project_id,created_at)、各FK与唯一约束、usage_accounts唯一周期资源、referrals有效唯一归因。先验证实际查询，再增加JSON GIN，不预建全部索引。

DB测试必须覆盖：两个账号/匿名/删除账号；读写/修改owner/猜ID；CAS并发只有一次成功；额度并发不透支；失败释放恰好一次；重复支付/任务回调；历史素材引用保护；所有业务表字段的注释非空。测试在CI临时库或专用开发库事务中执行，不在生产执行重置。
