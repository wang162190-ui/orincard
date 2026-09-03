# 技术复用与研究记录

> source: docs/sdd/orincard/spec.md

2026-09-04，通过 GitHub API 实查以下仓库元数据；价格/平台功能使用本轮2026-09-03/04官方文档调研。不把star当作安全或质量保证。未逐个issue审计响应速度，供应链/关键未修漏洞仍须安装时复核。

## 1. 开源项目证据

| 项目 | Stars 快照 | 最近push（UTC） | License | 用途 |
|---|---:|---|---|---|
| [vercel/next.js](https://github.com/vercel/next.js) | 142067 | 2026-09-03T16:12:09Z | MIT | 网站/SEO/SSR |
| [supabase/supabase](https://github.com/supabase/supabase) | 108794 | 2026-09-03T15:49:27Z | Apache-2.0 | 账号/数据库/Storage |
| [triggerdotdev/trigger.dev](https://github.com/triggerdotdev/trigger.dev) | 16206 | 2026-09-03T16:02:33Z | Apache-2.0 | 持久后台任务 |
| [microsoft/playwright](https://github.com/microsoft/playwright) | 95578 | 2026-09-03T16:02:51Z | Apache-2.0 | 浏览器渲染/视觉测试 |
| [gitbrent/PptxGenJS](https://github.com/gitbrent/PptxGenJS) | 6112 | 2025-11-28T20:17:14Z | MIT | 可编辑PPTX |
| [qpdf/qpdf](https://github.com/qpdf/qpdf) | 5373 | 2026-08-30T14:50:50Z | Apache-2.0 | PDF附件恢复 |
| [mozilla/pdf.js](https://github.com/mozilla/pdf.js) | 53818 | 2026-09-03T00:11:09Z | Apache-2.0 | PDF提取/预览 |
| [mozilla/readability](https://github.com/mozilla/readability) | 11424 | 2026-08-04T00:16:05Z | Apache-2.0 | 公开URL正文 |
| [lovell/sharp](https://github.com/lovell/sharp) | 32627 | 2026-08-30T10:43:41Z | Apache-2.0 | 图片处理 |
| [101arrowz/fflate](https://github.com/101arrowz/fflate) | 3000 | 2026-05-16T03:02:11Z | MIT | 受限ZIP处理 |
| [clauderic/dnd-kit](https://github.com/clauderic/dnd-kit) | 17597 | 2026-07-13T02:58:58Z | MIT | 拖拽排序 |
| [naptha/tesseract.js](https://github.com/naptha/tesseract.js) | 38687 | 2026-05-17T04:19:12Z | Apache-2.0 | 扫描页OCR |
| [stripe/stripe-node](https://github.com/stripe/stripe-node) | 4501 | 2026-09-03T14:55:45Z | MIT | 托管支付SDK |
| [resend/resend-node](https://github.com/resend/resend-node) | 949 | 2026-09-03T15:27:15Z | MIT | 邮件SDK |
| [colinhacks/zod](https://github.com/colinhacks/zod) | 43803 | 2026-09-03T06:55:16Z | MIT | 结构化数据校验 |
| [vitest-dev/vitest](https://github.com/vitest-dev/vitest) | 17045 | 2026-09-03T13:15:28Z | MIT | 单元/契约测试 |

PptxGenJS最近push较其他主库早（2025-11），尚未超过12个月；列为高风险探针，检查可编辑性和实际兼容性再继续。FFmpeg构建许可证取决于编译组件，不能一概标MIT；任务镜像固定构建并保留许可。pdf-lib维护快照较旧，不作为新PDF恢复主依赖。字体与照片不是代码许可证的一部分，另审。

## 2. 全模块复用映射

| 功能 | 开源基座/官方服务 | 结论与成本口径 |
|---|---|---|
| 官网/SEO/帮助/案例/模板页 | Next.js + 受信MDX；[Vercel](https://vercel.com/pricing) | 静态化、代码审核内容；商业部署Pro $20起，不先买CMS |
| 匿名/认证/找回/账户删除 | supabase-js/Auth；[SSR](https://supabase.com/docs/guides/auth/server-side/creating-a-client) | 现成认证，匿名正文只临时处理；Free额度内$0 |
| 项目/自动保存/版本/偏好 | Postgres/RPC；[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security) | JSONB+CAS+快照，业务差异化自研；包含在Supabase费用 |
| 六类来源 | Readability/PDF.js/Tesseract/FFmpeg/ZIP XML；[Trigger extensions](https://trigger.dev/docs/config/extensions/overview) | 原生解析优先，不额外买Unstructured；任务按秒计费 |
| 生成/改写/文本工具 | Zod+云模型；[模型目录](https://developers.openai.com/api/docs/models/all) | 统一结构化契约，不引入agent工作流框架；按token计费 |
| 模板/品牌/逐页编辑 | React/dnd-kit/用户设计 | 自研文档操作和原创模板是产品核心，不引入自由画布；无额外SaaS费用 |
| 图库/上传/Emoji/截图 | sharp/Playwright；[Pexels](https://www.pexels.com/api/documentation/)、[Storage](https://supabase.com/docs/guides/storage) | 用户授权和private bucket，截图独立沙箱；图库额度内$0、文件按用量 |
| AI图片/Portrait | 云端Images；[OpenAI图像](https://developers.openai.com/api/docs/guides/image-generation) | 用户先确认再引用；按图像token/质量计费 |
| PNG/JPG/PDF/PPTX/MP4 | Playwright/sharp/PptxGenJS/FFmpeg；[机器配置](https://trigger.dev/docs/machines) | HTML渲染共用，PPTX单独保证可编辑；内存1/2/4GiB起步 |
| ZIP/PDF恢复 | fflate/qpdf；[qpdf选项](https://qpdf.readthedocs.io/en/stable/qpdf-options.html) | 明确恢复附件，普通PDF不能假装可逆；计算成本计入worker |
| 订阅/额度/账单/取消/退款 | stripe-node + [Stripe Billing](https://stripe.com/billing/pricing) | Checkout/Portal托管；Billing按量0.7%另加支付处理费，地区不同费率不同 |
| 七工具与主编辑器互通 | 共用domain/render/jobs | 不复制七套管线；上下文选择与显式回写自研，费用按同任务单位 |
| Affiliate | Postgres + Stripe事件 | 推荐码、同意、归因、佣金流水自研；不新增营销SaaS，真实payout需政策 |
| 邮件/支持 | resend-node；[Resend](https://resend.com/pricing) | Free 100封/日、3000封/月；Pro $20/50000封，支持入口不接任意发信API |
| 运维/测试 | Vitest/Playwright/Postgres；[备份](https://supabase.com/docs/guides/platform/backups) | CI隔离，DB和对象分开恢复；不额外部署分析数据库 |

## 3. 平台约束（官方证据）

- [Vercel函数限制](https://vercel.com/docs/functions/limitations)：普通请求/响应4.5MB；Fluid标准内存2GB，Pro可4GB；长时长/大包有beta能力，不把beta当产品必需地基。
- [Supabase价格](https://supabase.com/pricing)：Free 500MB数据库、1GB Storage、50MB文件上限、闲置暂停、无自动备份；Pro $25起。数据库备份不包含Storage对象。
- [Trigger.dev价格](https://trigger.dev/pricing)：Free每月$5 credits，耗尽需升级；计算按机器秒+run计费；Medium1x 2GB为$0.000085/秒，Medium2x 4GB为$0.000170/秒。
- [OpenAI价格](https://developers.openai.com/api/docs/pricing)：本次文本基线gpt-5.6-luna $0.20输入/$1.20输出每百万token；mini转录估算$0.003/分钟；图片按实际token，不保证统一每张价。
- [签名下载](https://supabase.com/docs/guides/storage/serving/downloads)：签名URL不能通过轮换Auth key立即撤销；因此不用于严格删除后的访问路径。
- [Supabase changelog](https://supabase.com/changelog)：本轮核对2026-08备份修复、7月恢复凭据修复、Management API logs.all迁移（2026-09-23移除）、realtime schema禁止修改；本计划不写内部realtime表、不使用旧日志API。正式依赖安装前再次核对。

## 4. 研究与验证的区别

这些证据支持技术选择，不证明Orincard实现已跑通。B01探针、20份授权语料、真实云端集成、许可检查和完整AC验收仍必须执行。计划费用是假设场景推算，不能用截图里的竞品价格/流量推算Orincard收入。
