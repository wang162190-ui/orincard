# 环境、Git、上线门槛与运维

> source: docs/sdd/orincard/spec.md

## 1. 环境隔离

开发、Preview 使用独立 Supabase 开发项目和已部署的云端开发worker；Production独立配置和数据。默认美国东部；不将用户真实数据复制到开发。Preview开启访问保护和noindex；公开私有Git仓库链接不等于站点有访问保护。

本次未创建Supabase/Vercel/Trigger/Stripe/Resend资源，不读取或写入任何真实密钥。`.env.example`仅示例。`SUPABASE_SECRET_KEY`、OpenAI、Stripe、Resend、Trigger密钥永不使用NEXT_PUBLIC前缀。CI的Vercel/Supabase访问令牌在平台Secrets中配置，禁止写文档或任务payload。环境启动时检查secret类型、APP_ENV、项目ID和站点Origin；发现Preview指向生产则拒绝启动。

认证采用Supabase邮箱密码和Google OAuth；找回/验证邮件走Resend SMTP。只有服务端验证后的用户能操作自己的数据，不能依赖JWT里user_metadata的plan/role。删除账户先停用profiles并撤销session；敏感请求检查实时账户状态。

## 2. 开发默认与真实商业政策

开发值：页数4–12/默认6；Topic500字/Text30000字；AI预算$10/UTC月；每用户长任务并发1，全局导出2；80%预算告警；匿名本地草稿24小时，注册原件/全文7天，导出文件7天，脱敏运维日志30天。到期说明出现在输入/下载/隐私界面；项目可见内容保留至用户删除。

开发订阅fixtures可以覆盖Free/Pro/Creator各权益分支，但只在测试环境可用，明确写`test_only=true`，生产装载fixture立即报错。以下发布条件不能用默认测试值代替：

| ID | 条件 | 未满足时行为 | 所需证据 |
|---|---|---|---|
| L01 | 支付主体、地区和Stripe真实资格 | live billing关闭，展示内测说明 | 账户可用、支持国家/主体核验 |
| L02 | Pro/Creator售价、月年周期、额度/高清/PPTX/MP4权益、退款窗口 | 禁止真实Checkout与公开价目 | 用户批准的版本化policy |
| L03 | Affiliate归因窗口、比例、结算期、退款/自荐政策、税务收款流程 | payout关闭，测试归因不显示为真实收入 | 规则批准和Sandbox反冲结果 |
| L04 | 模型账号资格、地区、预算与数据保留说明 | 真AI入口明确不可用；不能fake成功 | 真实最小调用与用量记录 |
| L05 | 字体/照片/图库/Portrait输入授权、域名/商标/隐私条款 | 禁止对应素材公开及正式发布 | 许可清单、替换记录、用户确认 |
| L06 | 超50MiB文件/生产备份要求 | 使用已验证的较小上限 | 套餐额度和上传/恢复压测 |
| L07 | 备份与恢复、删除承诺、生产密钥隔离 | 禁止正式接收重要用户数据 | 可复验恢复报告与删除测试 |

建议商业默认在Sandbox中验证：订阅取消至已付期末仍保留权益；降级不删除项目，只限制新增付费任务；付款失败停止新增付费任务并保留编辑/既有下载；升级须已确认支付才增加权限。正式退款和佣金数值由L02/L03控制，不擅自承诺。

## 3. Git工作流

独立私有仓库`wang162190-ui/orincard`，从干净产品基线开始；原研究目录不动。首次提交仅docs、design reference、项目规范、无secret示例与文档检查脚本。后续创建`codex/bNN`或更细功能分支，显式暂存 → 看cached diff → 测试 → commit（说明中含AC）→ push → PR/Preview → review → main。

不使用`git add .`批量吸入未知文件，不提交.env、用户文件、备份、截图运行产物或node_modules。未配置Git作者时使用当前已认证GitHub身份和其官方noreply格式，只设仓库local配置，不改全局。使用SSH/gh凭据助手，不在remote URL嵌token。

每条提交都应能说明影响和验证。提交只保存代码/迁移/文档，不能代替数据库和素材备份。新的开发分支必须来自已验收main；不强推、不重写用户历史。

## 4. CI与发布顺序

PR：静态检查/单元/契约 → CI临时数据库测试（容器只在CI）→ Vercel Preview + 云端开发worker → 实际E2E。固定预览基地址，认证回调只允许已授权Preview域名，不能开放任意redirect。

开发分支内先由CLI生成向后兼容migration、在CI/开发重放并review，随后把迁移文件与代码一起提交。生产：合并main触发受控工作流，**禁止Vercel在主分支未经校验自动发布**。固定同一commit执行检查 → 应用该commit中已测试的production migration → 部署兼容worker → 构建并部署Vercel → 冒烟 → 人工确认release。生产流水线不得现场生成新migration或修改仓库；schema不在每个serverless请求或Next build时自动迁移。

Supabase CLI在使用前查`--help`；迁移文件由`supabase migration new`生成。开发SQL源与实际迁移在发布review时核对一致，生产只执行已经在CI和开发验证过的migration。

支付webhook先验签、持久化再应答，环境不同的secret不可混用。重试/补偿在job和billing_event层做，不由前端反复点击触发。

失败回滚：网站回滚到上一已知版本；worker保留旧schema兼容并固定run版本；DB优先前向修复，不自动破坏性回滚。若涉及数据恢复，进入维护模式并用户授权后恢复，不冒称Git revert能够恢复数据。

## 5. 监控与恢复

监测：请求失败率、任务阶段耗时/排队、生成和导出成功率、预算预留/实耗、pending_dispatch积压、未结算quota、Storage容量/出网、支付事件积压。每条带requestId/jobId/commit；日志白名单防全文泄漏。界面提供“服务暂不可用/重试/联系支持”，不隐瞒上游故障。

测试数据可丢的开发库使用Free；正式生产至少选择满足备份要求的套餐。Supabase备份只含DB，不含Storage字节。正式上线前选定独立加密备份目标并核验地区；每日保存DB与对象清单、增量对象，保留7日作为初始运维策略。备份恢复先到隔离目标，核对manifest哈希/引用/样本下载，再签署恢复记录；恢复也要重新执行删除tombstone，避免复活已删除内容。备份目标未批准时L07阻断生产，不私自新增收费存储。

生产初始RPO24小时、RTO8小时为`[UNVERIFIED-NUMBER: 待恢复演练确认的运维目标，不对外SLA]`。备份最终清除周期必须写进隐私政策；删除后的文件不得通过应用被继续访问，备份副本只供受控恢复且执行删除记录。

## 6. 本次交付状态

本次完成：仓库/文档/设计快照准备与规划检查。产品源码、真实渲染探针、云端接入、付费、完整视觉/安全测试均在tasks.md且未打勾。下一节点是用户review任务编排，而不是直接购买服务或公开上线。
