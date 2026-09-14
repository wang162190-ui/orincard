# Orincard 发布路线图

**目标**：`docs/sdd/orincard/tasks.md` 的 `- [ ]` 计数归零 + 界面与生成内容支持中英双语 + 编辑器对话助手，达到可发布状态。

这份文件是持续开发的**唯一事实来源**。它不依赖任何会话是否还活着：随时打开就能知道做到哪一步、下一步是什么、在等谁。

**节奏**：每次推进一个完整步骤（S0–S22），跑完验证再更新本文件。
**规则**：只在**真的跑通并验证过**之后才打 ✅。跑不通打 ❌ 并写一行原因，不粉饰、不用 mock 凑绿。

---

## 当前状态

| 指标 | 数值 | 取数时间 |
|---|---|---|
| `tasks.md` 完成 / 未完成 | 87 / **8**（T094 于 S4 勾选） | 2026-09-12 |
| `release-guards.test.ts` | 14 通过 / **5 失败** | 2026-09-11 |
| `check-planning.mjs` | PASS，`15 unchanged design files` | 2026-09-12 |
| 本轮开发累计 AI 花费 | **$0.0051**（全部来自 S4；预估总额 < $2.50） | 2026-09-12 |
| 开发项目 2026-09 账面已花 | **$1.2544**（S6 结清；含历史 $0.0085 + S4 实测 $0.004910 + 18 条核销 $1.241） | 2026-09-12 |
| 卡死预留 | **0 条 / $0.00**（S6 清空，原 19 条 / $1.243） | 2026-09-12 |
| 开发项目 2026-09 **可用余量** | **$8.7456**（上限 $10 − 已花 $1.2544 − 预留 $0） | 2026-09-12 |

> S6 之后账面第一次是可信的。可用余量数字和之前的 $8.75 几乎一样，但含义完全不同：以前是「$1.243 悬在预留里、谁也不知道那钱花没花」，现在是「$1.2544 确认已花、预留为 0」。**核销不释放任何额度**，它只是把「悬着」变成「记为已花」，让 80% 告警比例重新有意义。
>
> 其中 $1.241 标记为 `unmeasured_reserved` —— 供应商调用已发出但用量从未回报，按预留额保守全额入账（详见 [`docs/acceptance/operations.md`](acceptance/operations.md) 第四节）。后续每步的花费预估按 **$8.74** 算。

---

## 进度

### 阶段一 · 补齐 9 项任务

| 步骤 | 状态 | 内容 | 判据 |
|---|---|---|---|
| **S0** | ✅ 2026-09-11 | 建本文件 | 文件存在，`check-planning.mjs` 仍 PASS |
| **S1** | ✅ 2026-09-12 | 成本结算迁移 + `ai.ts` 用量透传 + `cost.ts` 费率表 | 迁移已 apply 到 `orincard-dev` 并**经 Data API 实测调通**；`pnpm typecheck` 通过；`check-planning.mjs` 仍 PASS |
| **S2** | ✅ 2026-09-12 | 五个 DeepSeek 调用点接线结算 | 五处全部接线；迁移 `20260912010000` 已 apply 到 `orincard-dev` 并经 Data API 实测调通；typecheck 通过，单测 237 通过 / 7 跳过，`check-planning.mjs` 仍 PASS |
| **S3** | ✅ 2026-09-12 | 图像与转写接线 + `costs.md` 如实记账 | 四类花钱操作逐类定性：文本=有口径未通电、图片=有口径已在跑、**转写=具名「无口径」不结算**、Pexels=不产生成本；迁移 `20260912020000` 已 apply 到 `orincard-dev` 并实测；typecheck 通过，单测 **240 通过 / 7 跳过**，`check-planning.mjs` 仍 PASS |
| **S4** | ✅ 2026-09-12 | 跑 T094 实测验收（实际花 **$0.0051**，远低于估的 $0.25–0.50） | `performance.test.ts` **7/7 真实云端通过**，`T094` 已勾；首条实测文本成本 $0.004910 落库；机器上限由账单反推为 small-1x 0.5 GB |
| **S5** | ⚠️ 2026-09-12 | T085 分环境 CI 与受控发布（花 **$0.00**）—— 验收已跑完，**T085 不勾** | Preview 半边成立：真实 CI 跑过 6 次，`test` 作业真绿，守卫真拦住（6 种情形本机实跑全部正确），依赖链无旁路。**发布半边无法验证**：`release.yml` 不在默认分支 `main` 上，GitHub **从未注册**它，无法 dispatch；`production` environment **不存在**（404）。**顺带修掉一个真缺陷**：`pnpm test` 排除 `tests/cloud/**`，发布流水线跑不到自己的发布阻断器。详见 [`docs/acceptance/deployment.md`](acceptance/deployment.md) |
| **S6** | ⚠️ 2026-09-12 | T086 预算/到期清理与监控（花 **$0.00**）—— 四条 Expect **全部实测通过**，但 `Depends: T085` 未满足，**暂不勾**（等你定） | 修掉两个真缺陷：①`retention.ts:58` 走 `client.schema("private")`，Data API 一律回 PGRST106 —— **对账巡检从上线第一天起一次都没成功执行过**；②80% 告警是**死代码**（`assertProviderBudget` 全仓零调用点），已接进每小时巡检。新增迁移 `20260912030000` 补访客预留结算入口 + 陈旧预留核销入口。19 条 / $1.243 卡死预留**已清零**。到期清理在真实夹具上验过，Storage 对象真的没了。详见 [`docs/acceptance/operations.md`](acceptance/operations.md) |
| **S7** | ⚠️ 2026-09-13 | T087 备份与隔离恢复（花 **$0.00**）—— 四项检查**全部真实通过**，但 `Depends: T086` 未满足，**暂不勾**（等你定） | 「代码已在」这次又不成立：原 3 条用例全是内存替身，CLI 入口 `main()` 一次没执行过。按 runbook 做了真实演练——真 `pg_dump`（670 KB / 29 表 / 86 函数）+ 真下载 19 个对象 / 5.8 MB，恢复进一次性 Postgres 容器与临时私有桶，`verifyRestore` 真适配器返回 `{hash:true, refs:26, tombstones:12, objects:19}`，三个真实反例全部被拦。**修掉两个真缺陷**：①只 dump `public`+`private` 会静默丢 **18/23 条 RLS 策略、21/52 条外键**而看起来一切正常（加 `auth` 后重跑，23/29/52/38 与源库逐项相等）；②唯一的生产闸门是大小写敏感黑名单，`Production`/`PRODUCTION`/`prod` 全放行，已改白名单。用例 3 → **9**。详见 [`docs/acceptance/backup.md`](acceptance/backup.md) |
| **S8** | ⚠️ 2026-09-14 | 补 T089 / T095 的三个缺失文件（花 **$0.00**）—— 三个文件都在且通过，**T089 / T095 都不勾** | `api-coverage` **4 通过**、`release-drill` **9 通过**，单测 241 → **245**。查出并修掉一个真功能缺口：契约声明的 `PUT /brand-kits/:id` **从未实现**，Brand Kit 建完就再也改不了（编辑器里那句 "until the revision-aware save route is available" 就是它）；服务层 `update` 早已写好，只缺路由，已补齐并接上 UI。另有 3 个真实入口从未写进契约（`GET /settings`、`GET /tools/:tool`、`GET /brand-kits/:id`），已补录。**T089 自身有缺口**：网站回滚一环无法验证（`release.yml` 从未运行，B-4），不属于「仅差前置」那一类。详见 [`release-drill.md`](acceptance/release-drill.md) |
| **S11** | ✅ 2026-09-14 | 改 `spec.md:143` 的语言决策（阶段二第一步，花 **$0.00**） | 表格行已改为「en 与 zh-Hans 都完整本地化」并标 `已确认（2026-09-14 变更）`；§14 补了变更日期、理由与影响面。`check-planning.mjs` 仍 PASS（`15 unchanged design files`），单测 **245/7**，守卫 14/5 基线未动 |
| **S12–S14** | ✅ 2026-09-14 | next-intl 基础设施 + proxy 组合 + SEO + 路由迁移（花 **$0.00**） | **判据真实通过**：真账号登录后切到 `/zh-Hans/projects`，私有 API 两侧都 200，会话没掉。生产构建通过，61 个静态页两种语言各一份。单测 245 → **286**。详见 [`i18n.md`](acceptance/i18n.md) |
| **S15** | ✅ 2026-09-14 | 界面字符串抽取（上半）（花 **$0.00**） | **判据真实通过**：真实浏览器里切语言，URL / `lang` / 标题文字三项同时变；英文串逐字节不变，5 份英文 e2e 全绿。详见 [`i18n.md`](acceptance/i18n.md) §四 |
| **S16** | ✅ 2026-09-14 | 界面字符串抽取（下半）+ key 对齐断言（花 **$0.00**） | **判据真实通过**：两份 JSON 各 36 个命名空间 / 568 个 key，由 `tests/unit/i18n-messages.test.ts` 断言逐条对齐（已做变异验证）；`src` 下再无用户可见的硬编码英文；中文页实测渲染中文。详见 [`i18n.md`](acceptance/i18n.md) §五 |
| **S17** | ✅ 2026-09-14 | 内容文件双语 + 工具名收口（花 **$0.00**） | **判据真实通过**：7 份 `.mdx` 两语言各一份，`tests/unit/content-locales.test.ts` 10 passed（已做变异验证）；法律审定守卫从查 3 个文件扩到查 6 个；中文页实测渲染中文正文。**边界**：`content/templates.json` 仍是全英文，已在验收文档 §八 点名。详见 [`i18n.md`](acceptance/i18n.md) §六 |
| **S18** | ✅ 2026-09-14 | 生成语言枚举 + 修 PPTX 中文字体（实际花 **约 $0.03**，预算 $0.10） | **判据大部分真实通过，一处没做**：语言从自由文本收成 `en` / `zh-Hans` 枚举（两条变异验证）；真调一次 DeepSeek 确认 `zh-Hans` 输出六页中文；PPTX 的 `fontFace()` 加 CJK 分支（三条变异验证），`font-manifest.json` 补 Noto Sans SC 700，两份 OFL 归属同步。中文六页 carousel 五格式全部产出，PNG/JPG/PDF/MP4 逐张肉眼确认；**PPTX 没有用真 PowerPoint 打开过**（本机没装 Noto Sans SC 系统字体，打开也必然是回退字体）。中文溢出用例被 preflight 阻断全部五种格式，断言精确到 slideId。单测 **314 passed / 7 skipped（44 文件）**，守卫回到 14/5 基线，构建 EXIT=0。详见 [`i18n.md`](acceptance/i18n.md) §七 |
| **S19** | ✅ 2026-09-14 | 新增 AC-012 + 补两屏助手原型（实际花 **$0.00**） | spec 加 AC-012、tasks 加 B13（T096–T099，共 99 项 / 13 批）、plan 加 B13 行；`assistant.html` 六态、`assistant-conflict.html` 逐列证据表，两页零 console 错误，`check-planning` 仍报 `15 unchanged design files`。见阶段三 |
| **S9** | 🔒 等 **B-2** | T073 → T084 支付与增长闭环 | T073、T084 可勾 |
| **S10** | 🔒 等 **B-1** | T088 + T095 收尾 💰 ~$0.50–1.50（B-3 已于 2026-09-12 解锁） | 见下方阶段一完成判据 |

**阶段一完成判据**（全部为真，缺一不可）：

1. `tasks.md` 的 `- [ ]` 计数 = **0**
2. `release-guards.test.ts` **19/19** 全绿
3. `docs/acceptance/` 下 `release.md`、`release-drill.md` 存在，且 `costs.md` / `billing.md` / `growth.md` / `security.md` 的验收结论不再是 `Blocked`
4. `docs/design/reference/` 仍然 `15 unchanged design files`

### 阶段二 · 中英双语（en + zh-Hans）

| 步骤 | 状态 | 内容 | 判据 |
|---|---|---|---|
| **S11** | ✅ 2026-09-14 | 改 `spec.md:143`（**第一步，不是最后一步**） | spec 不再写「不承诺完整本地化」，并记录变更日期与理由 |
| **S12** | ✅ 2026-09-14 | next-intl 基础设施 + `proxy.ts` 组合 ⚠️ 最易写错 | **登录后切换语言，会话不掉** —— 真账号实测通过 |
| **S13** | ✅ 2026-09-14 | 私有路由剥 locale + hreflang | `/zh-Hans/billing` 实测带 `x-robots-tag: noindex, nofollow`；sitemap 20 条 URL 带三种 hreflang；robots 26 条 disallow |
| **S14** | ✅ 2026-09-14 | 路由迁到 `src/app/[locale]/`（`api/**` 不动） | 英文 URL 无前缀不变，中文走 `/zh-Hans/`；`/api/v1/projects` 实测 401 而非 404，未被改写 |
| **S15** | ✅ 2026-09-14 | 界面字符串抽取（上半） | 15 个命名空间，18 个文件改用 `useTranslations`；`marketing.spec.ts` 的语言切换用例在真实浏览器 2 passed；单测仍 286 passed；构建 EXIT=0 |
| **S16** | ✅ 2026-09-14 | 界面字符串抽取（下半）+ key 对齐断言 | 21 个文件改用 `useTranslations` / `getTranslations`；单测 289 passed / 7 skipped（42 文件）；chromium 下 marketing + accessibility + templates + editor **13 passed**；构建 EXIT=0（61 静态页 / 73 条路由）|
| **S17** | ✅ 2026-09-14 | 内容文件双语（7 份） | 两语言各一份 `.mdx`，审定守卫按 locale 查 6 个文件 |
| **S18** | ✅ 2026-09-14 | 生成语言枚举 + **修 PPTX 中文字体** | 见下方阶段二完成判据 |

**阶段二完成判据**：一份中文六页 carousel，**五种格式**（PNG / JPG / PDF / PPTX / MP4）逐个肉眼确认中文不是豆腐块、不是回退字体，PPTX 用 PowerPoint 真实打开；一条中文溢出用例被 preflight 按规则**阻断全部五种格式**。

**阶段二结果（2026-09-14）：⚠️ 判据未百分之百满足。** 五种格式全部产出（`tests/cloud/chinese-export.test.ts` 可复跑，产物在 `/tmp/orincard-s18`），PNG / JPG / PDF / MP4 四种逐张肉眼确认无豆腐块、标题真 700；溢出用例被阻断全部五种格式且精确到 slideId。**差的一条**：PPTX 没有用真 PowerPoint 打开过——这台机器没装 Noto Sans SC 系统字体，打开也只会是回退字体，因为 **PPTX 这个格式本身不嵌字体**。用 LibreOffice 做了修前/修后对比，证明字体名写对了、粗体不再丢。要不要为此改写一个系统自带的中文家族，是产品取舍，列在验收文档 §九 第 5 条等你定。

### 阶段三 · CopilotKit 编辑器助手

| 步骤 | 状态 | 内容 | 判据 |
|---|---|---|---|
| **S19** | ✅ 2026-09-14 | 新增 AC-012 + 补两屏原型（不花钱） | `assistant.html` 走完六态（计划要求四态，另加 apply 失败与预算打满两态）+ `assistant-conflict.html`；全景图与 README 同步 |
| **S20** | 🛑 **当前停在这里** | **你过图 —— 图没过不往下走** | 产品所有者确认。图在 `http://127.0.0.1:8080/prototype/assistant.html` 与 `…/assistant-conflict.html` |
| **S21** | ⬜ | 自托管 runtime 💰 ~$0.30–0.80 | 每轮对话走 `server_submit_job` 预留 + `settle_cost_attempt` 结算 |
| **S22** | ⬜ | 编辑器接线（不新开写入口） | 见下方阶段三完成判据 |

**阶段三完成判据**：`grep -rn 'server_submit_job' src` 在 copilot route 里有命中；连发 N 轮后 `reserved + spent ≤ limit` 恒成立，且预算打满后第 N+1 轮被**拒绝**而不是照跑；制造 `expectedRevision` 冲突时 apply 返回 409 且源 revision 逐列不变。

---

## 阻塞清单（等产品所有者）

**B-3 已于 2026-09-12 由产品所有者答复解锁**，剩下 B-1 / B-2 两项挂着不空等 —— 它们只卡住 S9 / S10，其余 20 步照常推进。

### B-1 · 法律文本 12 项商业决策 🔒 卡 T088 → T095

守卫只要求 `content/legal/{terms,privacy,affiliate}.mdx` 的 `publicationStatus: draft → approved`，**改 4 个字符就能变绿**。但三份文件正文明写着自己无效：

- `terms.mdx:10` — "It is not a legally reviewed agreement and **must not be used as production terms**."
- `terms.mdx:30` — "**No refund promise is approved in this draft.**"
- `affiliate.mdx:26` — "No commission rate, currency, threshold, schedule, or payment promise is approved here."

只改状态会让产品带着一份自称无效的条款上线，而 T095 的发布清单会把它当作已审定的发布物。真正要定的是 12 项：

| # | 文件 | 待定事项 |
|---|---|---|
| 1 | terms | 签约主体与适用法域 |
| 2 | terms | 续费时点 / 扣款失败处理 / 降档规则 |
| 3 | terms | **退款规则**（资格、时限、部分周期、已消耗额度） |
| 4 | terms | 保证免责、责任上限、争议解决 |
| 5 | privacy | 各类数据的**具体保留期** + 各地区合法性基础 |
| 6 | privacy | 已批准的供应商名单与处理地点 |
| 7 | privacy | 跨境传输条款与子处理者 |
| 8 | privacy | 控制者身份、联系人、年龄下限、投诉权 |
| 9 | affiliate | 佣金率 / 币种 / 结算门槛 / 周期 |
| 10 | affiliate | 归因窗口 |
| 11 | affiliate | 退款冲正规则 |
| 12 | affiliate | 打款服务商与税务核验 |

定完由我改写正文，签字（改 `publicationStatus`）是产品所有者的动作，**不代改**。

### B-2 · Stripe 测试密钥 🔒 卡 T073 → T084

需要一把 `sk_test_` 前缀的密钥。拿到后建 `pro` / `creator` 两个占位 Price（键必须是 `public.billing_plan_key` 枚举的真实值）。密钥只在子 shell 里 `set -a` 加载，值不进聊天 / 日志 / Git。占位价格**不是定价决策**，会在 `docs/acceptance/billing.md` 里用整段写明。

### B-3 · `avatar-elena.jpg` 出处 ✅ 2026-09-12 已解锁

已核实的事实：

- `credits.json` 记 6 条，目录里 7 张 jpg，少的就是它
- 240×240 人像，EXIF 只有 Photoshop 痕迹，**无任何来源信息**
- 被 5 个 `reference/` 页 + 3 个 `prototype/` 页引用
- 在 `manifest.json` 里有 SHA-256 锁

因此 `docs/licenses/assets.md:36` 给的「删除该文件」**实际不可行**（会同时破锁和破 8 个页面）。只剩一问：

> 它是不是和 `orincard.css` / 5 个 HTML 一样来自 Open Design 项目 `9d82ca96-…` 的导出，且人像是 AI 生成或持有肖像授权？

**产品所有者 2026-09-12 答复：是。** 该文件来自同一批 Open Design 项目导出，人像为 AI 生成或持有授权。

因此：**不换图、不重算 manifest**。登记动作放在 S10 执行 —— 在 `docs/licenses/credits.json` 补第 7 条，来源记为 `client-supplied-internal`，证据指向 `README.md` 的 2026-09-04 复制记录；同时改掉 `docs/licenses/assets.md:36` 那条不可行的「删除该文件」处置建议。guard 1 与 guard 4 届时一起转绿。

### B-4 · GitHub 发布环境配置 🔒 卡 T085（2026-09-12 由 S5 查出）

`release.yml` **从未运行过，且现在跑不了**：GitHub 只注册了 `Check and Preview`，因为默认分支 `main` 上这两份工作流文件都不存在，而 `workflow_dispatch` 要求文件在默认分支上。`production` environment 也不存在（404）。这两件事都超出本次会话的授权（不动分支、不碰生产），需要你来做：

1. **把两份工作流合入 `main`** —— `release.yml` 才会被注册，才可能 dispatch。
2. **建 `production` environment 并挂保护规则**（required reviewers / wait timer）。现在它不存在意味着 `release.yml` 里三个 `environment: production` 是**空门**：真跑起来 GitHub 会自动创建一个**无保护**的同名 environment，审批门形同虚设。
3. **配变量与密钥**（`preview` 现在 variables 与 secrets 全空，这就是 6 次 CI 全红的直接原因）：

   | 作用域 | Variables | Secrets |
   |---|---|---|
   | `preview` | `SUPABASE_PROJECT_REF`、`SUPABASE_PRODUCTION_PROJECT_REF`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID` | `VERCEL_TOKEN` |
   | `production` | 同上四项 | `VERCEL_TOKEN`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_PASSWORD`、`TRIGGER_ACCESS_TOKEN` |

   两个环境对 `SUPABASE_PROJECT_REF` 的要求**相反**：preview 守卫要求它 **≠** 生产 ref，production 守卫要求它 **=** 生产 ref。配反了两边都会被自己的守卫拦住。

另外 `tasks.md:572` 写 `Depends: T084`，而 T084 卡在 B-2 上 —— 即便 B-4 解开，T085 也应等 T084 落地后再勾。详见 [`docs/acceptance/deployment.md`](acceptance/deployment.md)。

---

## 硬约束（贯穿全程）

- 不碰生产 Supabase、不接生产 Stripe、不用 `sk_live_`
- 不动 `docs/design/reference/`（SHA-256 锁），不重算 manifest
- 不用 mock 让任何验收变绿；跑不通就如实写，并在本文件打 ❌
- DB 迁移只对**开发项目** apply
- 转写（视频来源）整轮跳过 —— `docs/acceptance/sources.md` 的 ~$1.00/次 标着 `[UNVERIFIED-NUMBER]` 不可靠，且 T038–T044 已是 PASS
- 不做繁中 / 日文 / 阿拉伯语，**不引入 RTL**
- 阶段一期间不动任何 UI 字符串（会和 S15/S16 的抽取打架）

---

## 变更记录

| 日期 | 变更 |
|---|---|
| 2026-09-11 | 建立本路线图（S0）。此前已完成：`.env.example` 补齐 6 个 Stripe 条目，守卫的 `.env.example` 文档化断言转绿 |
| 2026-09-12 | **S1 完成**。新增迁移 `20260912000000_cost_settlement_rpc.sql`（6 个 `server_*` 函数）并 apply 到 `orincard-dev`；`ai.ts` 补 `usage` 透传与 `onMeasurement` 回调；新增 `src/server/cost.ts` 费率表 |
| 2026-09-12 | **修正计划错误**：原计划把 S6（T086）列为「代码已在，只差跑验收」，实测证明 `retention.ts:58` 是**未修的生产缺陷**，S6 改为「先修代码再验收」 |
| 2026-09-12 | **修正计划错误**：原 S2 判据写「register/settle 配对」，但实测确认 `cost_attempts` 的行是既有 SQL 函数自己插的，S2 应**只结算不重复登记**（详见 `docs/acceptance/costs.md` 的 attempt_key 语义表） |
| 2026-09-12 | 首次读到真实预算数字：卡死预留 $1.241 / 18 条，当月实际余量 $8.75 而非 $10 |
| 2026-09-12 | **B-3 解锁**：产品所有者确认 `avatar-elena.jpg` 来自 Open Design 导出、人像 AI 生成或持有授权。不换图、不重算 manifest，登记动作并入 S10。S10 现在只等 B-1 |
| 2026-09-12 | **S2 完成**。新增迁移 `20260912010000_settlement_entrypoints.sql`（生成任务结算入口 + 访客四件套）并 apply 到 `orincard-dev`；新增 `src/server/cost-settlement.ts`；五个调用点全部接线；`tests/db/jobs-usage.test.ts` 补一条断言强制访客结算函数与 `private.settle_cost_attempt` 逐字同步 |
| 2026-09-12 | **发现并修掉一处编数字的记账**：`generate-image.ts` / `visual-tool.ts` 在 APIMart 不回报成本时补常数 `$0.025` 写进 `actual_micro_usd`，落库后与实测成本无从分辨；而唯一一条真实结算行是 **$0.0085**，即这个常数还高估约 **3 倍** |
| 2026-09-12 | **S3 完成**。新增迁移 `20260912020000_asset_cost_source.sql`：`ai_asset_reservations` 加 `cost_source`（`measured` / `unmeasured_reserved` / `null`），`p_actual_micro_usd` 允许传 `null` 表示「供应商没报」并按预留全额保守入账；新增只读入口 `server_sample_asset_cost_sources`。**转写定性为具名「无口径」**：秒数已实测落库（`durationSeconds`），缺的只是火山引擎实际计费单价，因此不结算、不估算、不补零 |
| 2026-09-12 | **修正我自己的一个错误判断**：曾以为 `supabase/definitions/*.sql` 是迁移的镜像并同步改了它，导致 `migration-smoke` 变红。真实关系是它们是**基线迁移的生成源**（`prepare-migrations.mjs`），改它等于篡改已 apply 的迁移。已回退，改动只留在新迁移里 |
| 2026-09-12 | **$1.241 泄漏拆到条**：18 条预留 = 1 条视频转写 $1.00 + 9 条图片/人像 $0.225 + 8 条访客 $0.016。**81% 是一次视频转写**——因为转写从来没有任何结算路径。回收动作在 S6 |
| 2026-09-12 | **S4 完成，T094 已勾**。`performance.test.ts` 7/7 真实云端通过。同时修掉该文件三个用例的一处硬伤：它们用 `admin.schema("private")` 直读私有表，而 Data API 只暴露 `public` / `graphql_public`，一律回 PGRST106 —— 改走 S1–S3 建的 `public.server_*` 只读入口，与生产代码同一条路径 |
| 2026-09-12 | **链路确认通电**：首条实测文本成本落库，`guest:…:generation:1` → 466 输入（384 缓存命中）/ 2448 输出 token，`actual_micro_usd = 4910`。费率与用量一起落库，手工复算 4,909.608 与记账值分文不差 |
| 2026-09-12 | **修正预算估计**：访客生成预留 $0.002 vs 实测 $0.004910 —— **少预留 2.46 倍**，且 4 页已是最小档。预留是花钱前的闸门，开小了等于 `AI_MONTHLY_BUDGET_USD=10` 实际能放出去的钱超过 $10。图片方向相反（预留 $0.025 vs 实测 $0.0085，多预留 2.94 倍，只是保守） |
| 2026-09-12 | **新缺陷（S4 验收中查出，非 S2 引入）**：访客路径只结算了**尝试层**，**预留层**没人结算。推「预留→已花」的是 `private.finalize_job`，它按 `job_id` 找预留，而访客没有 job 行；`server_finish_guest_generation` 又无条件把预留翻 `unknown`。后果双向：$0.002 卡死回不来，真实的 $0.004910 也进不了 `spent`。泄漏因此从 18 条/$1.241 涨到 **19 条/$1.243**。修法并入 S6 |
| 2026-09-12 | **S5 完成，但 T085 不勾**。`tasks.md` 给的 Check 命令只对 YAML 做文本断言，绿了不代表流水线能跑，所以改为去问 GitHub 真实历史。结论：Preview 半边成立（6 次真实 CI，`test` 作业真绿，`preview` 在守卫处失败安全地停住），发布半边**从未验证过也无法验证**。结论文档 `docs/acceptance/deployment.md` |
| 2026-09-12 | **发现并修掉一处「发布守卫绕过自己」**：`pnpm test` 是 `vitest run --exclude 'tests/cloud/**'`，而发布阻断器 `tests/cloud/release-guards.test.ts` 正好住在被排除的目录里 —— 受控发布流水线跑不到自己的发布守卫，现在红着的 5 条（法律文本未审定等）本可一路绿灯直奔生产。已在 `release.yml` 的 `test` 作业显式加跑该文件，并在 `deployment.test.ts` 加第 5 条用例锁住它（含「必须在任何 `environment: production` 之前」的顺序断言，删行即转红，已变异验证） |
| 2026-09-12 | **新阻塞 B-4**：`release.yml` 未被 GitHub 注册（两份工作流都不在默认分支 `main` 上，`workflow_dispatch` 要求在默认分支），`production` environment 不存在（404），`preview` environment 的 variables 与 secrets 全空。这就是 6 次 CI 全红的直接原因，也是 T085 无法勾选的根因 |
| 2026-09-12 | **机器内存上限改为账单反推**：Trigger 的 API/SDK 都不回报 machine preset，`trigger.config.ts` 未 pin。由 `baseCostInCents` 与每次运行费完全相等、且 $0.00003375/s 与 small-1x 的 $0.0000338/s 吻合到四位，定为 **small-1x = 0.5 GB**。峰值 RSS 134.0 MiB 占 26.2% |
| 2026-09-12 | **S6 完成，但 T086 暂不勾**。四条 Expect（到期清理 / 80% 告警 + 100% 熔断 / 复验 reconciler / 日志无正文）全部拿开发项目实测通过；唯一挡着的是 `tasks.md:580` 的 `Depends: T085`，而 T085 卡在 B-4。与 T085 不同的是，T086 **自身没有缺证据**——是否按「实质通过、仅形式依赖未满足」先勾，等你一句话。结论文档 `docs/acceptance/operations.md` |
| 2026-09-12 | **新缺陷（S6 查出）**：`retention.ts:58` 用 `client.schema("private")` 读 `cost_reservations`。Data API 只暴露 `public` / `graphql_public`，这条读法**永远**回 PGRST106，何况该表连 `service_role` 都 `revoke all`。也就是说每小时的对账巡检**从上线第一天起一次都没成功执行过**——`reconciler.verified` 从未发出。已改走 `server_count_unsettled_reservations`，变异验证过 |
| 2026-09-12 | **新缺陷（S6 查出）**：80% 预算告警是死代码。`assertProviderBudget` 实现完整、单测齐全，但**全仓零调用点**——「快到上限了」这件事从来没有任何地方会说出来。已接进每小时 `runRetentionMaintenance`（清理后、巡检前），不给用户请求加往返。三档实测：12.5% open / 85.0% `budget.warning` / 100% 抛 `BudgetCircuitOpenError` |
| 2026-09-12 | **访客预留结算缺口已补**（S4 发现的洞）。新增 `private.finalize_guest_reservation`，`server_finish_guest_generation` 审计通过才结算、不过仍保守翻 `unknown`。实测：reserved 1,243,000 → 1,241,000，spent 8,500 → **13,410** —— S4 真实花掉的 $0.004910 第一次落进账本，比预留额 $0.002 高 **2.46 倍**（预留开小了，代价如实收紧预算）。二次调用幂等 |
| 2026-09-12 | **18 条陈旧预留核销完毕**。逐条查过：全部是「供应商调用已发出、用量从没回报」，`settledMicroUsd` 全为 0，没有任何可结算的实测数字。**没有 release**（那等于宣称调用免费，是最危险的方向），**没有编数字**（S3 已因 $0.025 常数否过一次），按 S3 的同一条 policy 全额保守入账并标 `unmeasured_reserved`。结果：reserved 1,241,000 → **0**，spent 13,410 → **1,254,410**，未结算预留 → **0**。核销刻意不进定时任务，`p_min_age` 下限 1 小时实测能拦住新鲜预留 |
| 2026-09-12 | **100% 熔断在 SQL 侧实测过**：把可用额度压到 1,000 μ$ 后发起 2,000 μ$ 访客预留 → `{"outcome":"budget_exceeded"}`，且**没建 guard、没建预留**。失败方向是关闭的 |
| 2026-09-12 | **到期清理的第一次「成功」其实什么也没证明** —— 库里所有 `expires_at` 都在未来，`removed` 是 `{source:0, export:0}`。造了真实夹具重跑：source `ready→deleted`、export `ready→expired`、2 条 asset → `deleted`、**Storage 对象真的被删掉了** |
| 2026-09-12 | **修复迁移历史缺口**：S2 的 `20260912010000` 与 S3 的 `20260912020000` 都已 apply 但没登记进 `supabase_migrations.schema_migrations`，`supabase db push --include-all` 会试图重跑。已补录三条 |
| 2026-09-13 | **S7 完成，但 T087 暂不勾**。Expect 四项（DB+Storage 共同恢复、哈希、引用、tombstone 未复活）在真实数据上全部通过，且是在两个真缺陷修掉之后通过的。挡着的只有 `tasks.md:584` 的 `Depends: T086`。这是同一条依赖链上第三个「自身证据齐全、只差前置」的任务，链条底部是 B-4 —— T086 与 T087 是否一并勾上，等你一句话。结论文档 [`docs/acceptance/backup.md`](acceptance/backup.md) |
| 2026-09-13 | **重缺陷（S7 查出）**：`docs/runbooks/recovery.md` 第 2 步只写「produce a read-only database dump」，没规定范围。按最自然的读法 dump `public`+`private`，恢复出来的库**表齐、函数齐、38 行数据一行不少**，却静默丢掉 **18/23 条 RLS 策略和 21/52 条外键**（凡是调用 `auth.uid()` 或引用 `auth.users` 的全部 apply 失败）。RLS 在 29 张表上仍是**开着**的，于是表变成「拒绝一切」而不报错，最可能的后续动作是有人把 RLS 关掉「修好」它 —— 等于恢复出一个既不是原库、又把安全边界拆了的数据库。已在 runbook 明确要求带 `auth` schema 并给出恢复后必比的策略/外键数 SQL |
| 2026-09-13 | **并且验证了修法有效**：带 `--schema=auth` 重新 dump（755,891 字节）恢复进第二个隔离库，错误从 40 条降到 **1 条**（无害的 schema 已存在），`policies 23 / rls_tables 29 / fkeys 52 / assets 38` 与源库**逐项相等**，隔离库读出的 references=26 / tombstones=12 与 manifest 一致 |
| 2026-09-13 | **缺陷（S7 查出）**：`assertIsolatedTarget` 的生产闸门写的是 `environment === "production"` —— 大小写敏感的黑名单。实跑确认 `Production` / `PRODUCTION` / `prod` 三种写法**全部放行、备份照常写出**。而这是**唯一**的生产闸门：脚本拿到的是外部注入的适配器，看不到 project ref，没法像 S5 的 CI 守卫那样比对 ref。已改为白名单（只放行 `development` / `preview`），加 5 条参数化用例；变异验证：改回黑名单立刻红 4 条 |
| 2026-09-13 | **更正我自己的一个中间判断**：曾用内存替身探到「同一 key 同时进 references 和 tombstones 时 `verifyRestore` 全绿」并当成缺陷。真实数据造不出那个状态 —— 两份清单都由 `public.assets.state` 单列枚举导出，天然互斥，真实反例正常被拦。残留的只是这条前提从未写进适配器契约，已加两行断言 + 一条用例，没有为不存在的问题改实现 |
| 2026-09-13 | **写进 runbook 的三条诚实边界**：`databaseHashVerified` 只证明**归档没有静默损坏**，不证明恢复出来的库等于 dump；`objectsVerified` 是货真价实的字节级证明；**仓库里没有 `verifyRestore` 的执行器**，它是个库，runbook 第 5 步假设操作者自写 harness |
| 2026-09-13 | **顺带量到的开发库真实状态**：26 条活引用里 **7 条是悬空的**（asset 行非 deleted，但 `storage.objects` 里没有对象），备份因此只装得下 19 个；另一侧干净 —— 12 条 tombstone 没有一条还留在 Storage 里。不是备份工具的缺陷，但恢复演练校验不到那 7 条 |
| 2026-09-13 | **环境问题，未解决也未写进 runbook**：`supabase db dump --linked` 连试三次全挂住（IPv6 不可达后降级到 IPv4 pooler，辅助容器一直 `unhealthy`，5 分钟无输出、dump 0 字节）。绕法是直接在本机已运行的容器里调 `pg_dump` 连云端 pooler，口令经 stdin 传入不进 argv。这是本机权宜之计，不是推荐做法 |
| 2026-09-14 | **节奏改变**：产品所有者要求「继续完成，直到所有开发任务结束」。不再一次一步，改为连续推进；卡在产品所有者身上的（B-1 / B-2 / S20 过图）跳过并在最后汇总 |
| 2026-09-14 | **S8 完成，T089 与 T095 都不勾**。新增 `tests/contracts/api-coverage.test.ts`（4 条）、`tests/cloud/release-drill.test.ts`（9 条）、`docs/acceptance/release-drill.md`。单测 241 → **245**（api-coverage 住在 `tests/contracts/`，被 `pnpm test` 收进去，不像 cloud 那样被排除） |
| 2026-09-14 | **真功能缺口（S8 查出）**：`contracts/api.md` 声明的 `PUT /brand-kits/:id` **从未实现**——服务层 `brandService.update` 早已写好（expectedRevision、409 冲突、素材归属校验齐全），`store.update` 也在，单测也在，唯独缺 HTTP 路由。后果是 **Brand Kit 一旦建好就永远改不了**，只能建/看/复制/应用/删。编辑器里那句 "Changes remain in this editor until the revision-aware save route is available." 就是这个洞的自述。已补 `PUT` 路由并接上「Save Brand Kit」按钮（契约输入只有 expectedRevision + settings，因此 `name` 可省略，省略时保留原名） |
| 2026-09-14 | **三个实现了但契约里没有的入口**（S8 查出）：`GET /settings`、`GET /tools/:tool`、`GET /brand-kits/:id`。三个都是真实、owner 限定、有调用方的路由，只是从没写进 `contracts/api.md`。`check-planning.mjs` 看不见它们——它只从契约走到任务清单，**从不从文件系统走回去**。已补录契约，并在 api-coverage 里加了「每个实现的路由都必须被任务认领」的反向断言 |
| 2026-09-14 | **api-coverage 做到逐方法逐路径**，不只比路径：路径对上不代表方法对上，上面两条缺陷正好一边一个。**变异验证**：把 `PUT` 改名后用例立刻转红 |
| 2026-09-14 | **回滚安全性只有两条前提，现已钉死**（S8 查出）：所有 worker 载荷校验器都是 `z.literal(1)` + `.strict()` 精确匹配，多一个字段就整条拒——`operations.md:49` 那句「worker 保留旧 schema 兼容」**在代码里并不成立**。今天不出事全靠「27 个迁移零破坏性 DDL」和「release.yml 的 website 最后部署」两条。两条都加了断言（破坏性迁移扫描已变异验证），并把 `release-drill.test.ts` 显式接进 `release.yml` 的 `test` 作业——它是闸门不是报告 |
| 2026-09-14 | **网站回滚一环无法验证**：`release.yml` 从未运行过也跑不了（B-4），所以「回滚到上一已知版本」这个动作本次一次都没做。只验证了它的前提（部署顺序、零破坏性命令、不现场生成迁移）。因此 T089 **自身就有缺口**，与 T086/T087 的「仅差前置」性质不同 |
| 2026-09-13 | **S7 演练痕迹全部清理**：临时桶 `s7-drill-restore` 与 19 个上传对象已删（桶列表回到 `assets/exports/sources`），两个隔离容器已删，你的 9 个本地 Supabase 容器全程未触碰、只以只读方式借用其 `pg_dump`；开发库数据未变（assets 25/12/1，预算行 `10000000 / 0 / 1254410`）。备份产物只落在 `/tmp/s7/`，未入仓 |
| 2026-09-14 | **S11 完成，阶段二开工（花 $0.00）**：`spec.md` 第 12 节「语言」那条**已确认**的决策被推翻并改写——原文「英文界面/输出优先；模型可支持其他语言但不承诺完整本地化」，现为「界面与生成内容支持 en 与 zh-Hans 两种语言，**两者都完整本地化**；不做繁中/日文/阿拉伯语，因此不引入 RTL」。§14 补了一条变更登记（日期 + 理由 + 影响面），**不是悄悄改表格**：推翻一条已拍板决策必须留痕 |
| 2026-09-14 | **S11 顺带确定两件后续约束**：①此前所有验收文档都按单语（英文）写，从本日起须按 en + zh-Hans 两种语言重读——中文法律文本同样要走 `approved` 审定，不能靠英文版签字覆盖（S17 会把 `release-guards` 的检查按 locale 展开）；②`src/render/pptx.ts` 的 `fontFace()` 从不返回 CJK 字体这个缺陷，因此从「无关紧要」升级为**发布阻断项**（S18 修） |
| 2026-09-14 | **S12–S14 完成，阶段二的路由层打通（花 $0.00）**：装 next-intl 4.14.5（peer 明确支持 Next 16），建 `src/i18n/{routing,request,navigation}.ts`，18 个页面目录 `git mv` 进 `src/app/[locale]/`，`src/app/api/**` 一行没动。生产构建通过，61 个静态页两种语言各一份。单测 245 → **286**。详见 [`docs/acceptance/i18n.md`](acceptance/i18n.md) |
| 2026-09-14 | **S12 判据真实通过**：真账号登录 `:3000`，英文侧 `/api/v1/projects` 200 → 切到 `/zh-Hans/projects`（未跳登录页，`html lang="zh-Hans"`）→ 中文侧同一会话仍 200。**变异验证**：把刷新出来的 cookie 写到另起的 response 上（网上最常见的写法），redirect 与 rewrite 两条用例立刻转红 —— 那正是「一切语言就掉登录」的故障 |
| 2026-09-14 | **查出并挡住一个会让整套 API 消失的坑**：next-intl 的 middleware 会把它看到的一切改写成带 locale 的路径，`/api/v1/projects` 一旦变成 `/en/api/v1/projects`，**48 条 API 路由一次性 404**。已加 `NON_LOCALIZED_PREFIXES`（`/api`、`/auth`、`/robots.txt`、`/sitemap.xml`）把它们排除在语言协商外，但**仍然走会话刷新**。实测 `/api/v1/projects` 返回 401 而非 404；变异验证去掉判断后 5 条用例转红 |
| 2026-09-14 | **修掉计划里点名的静默失效**：`isPrivateRoute` 按前缀精确匹配，`/zh-Hans/billing` 匹配不上 `/billing`，中文账单页会**无声地变成可索引**（不报错、页面照常渲染）。已改为先剥 locale 段再匹配。同一类问题还有两处：`robots.txt` 只 disallow 英文路径（已按语言各写一遍，13×2=26 条）、`sitemap.xml` 只列英文 URL（已改为 10 条路径×2 语言=20 条，每条带 en / zh-Hans / x-default 三个 hreflang）|
| 2026-09-14 | **canonical 改为跟随当前语言**：若两个语言版本互相指认对方是正本，hreflang 与 canonical 自相矛盾，搜索引擎会忽略整组声明。另：`/fr/pricing` 实测 **404** 而不是静默渲染英文页——否则会凭空多出一批与 hreflang 对不上的可索引 URL |
| 2026-09-14 | **一条实测更正**：我最初断言「切回无前缀 `/projects` 应回到英文」，实测是 **307 → `/zh-Hans/projects`**。next-intl 用 `NEXT_LOCALE` cookie 记住语言选择，这是刻意行为，不是回退失败——对已选中文的用户，无前缀 URL 不再是英文入口；搜索引擎没有这个 cookie，仍然看到英文版。验收断言已按实际行为改正 |
| 2026-09-14 | **两处工具链配置，都写明了原因**：①`vitest.config.ts` 加 `server.deps.inline: ["next-intl"]`——next-intl 的 ESM 产物写 `import from "next/server"`（无扩展名），Node 原生 ESM 在 pnpm 嵌套 store 里解析不到；②`next.config.mjs` 支持 `NEXT_DIST_DIR`——验证性构建换产物目录，**免得覆盖正在被 `next start` 服务的 `.next`**。你的 :3100 全程未受影响，三台服务器（3000/3100/8080）验收前后都是 200 |
| 2026-09-14 | **界面文案尚未翻译，这一点写在验收文档最前面**：现在能证明的是「双语路由、会话、SEO、`lang` 属性是对的」，**不是「产品已经会说中文」**。49 个 `.tsx` 的硬编码英文要到 S15–S16 才抽取，8 份内容文件要到 S17，生成语言枚举与 PPTX 中文字体要到 S18 |
| 2026-09-14 | **S15：抽取过程中撞出一个真实的 a11y 缺陷并修掉**。语言切换器最初叫 `Language`，和创作页的**生成语言**字段撞名，`accessibility.spec.ts` 在三个浏览器上各报一次 strict mode violation。这不是测试挑剔——同页两个同名控件，屏幕阅读器用户分不清「界面语言」和「生成内容的语言」。改名 **Interface language / 界面语言**，生成语言字段保持原名。顺带把 `marketing.spec.ts` 的选择器改成 `exact: true`：Playwright 的 `name` 默认子串匹配，`"Language"` 照样命中 `"Interface language"`，**正是这种宽松匹配让缺陷从那条用例底下溜了过去** |
| 2026-09-14 | **S15：英文逐字节不变是这一步唯一的纪律**。`marketing/growth/support/billing/accessibility` 五份 e2e 断言的是精确英文串，所以 `messages/en.json` 里每个英文值都是从被替换的字符串**原样拷来**，不是重写。实测 `/` 上 href 集合仍是 `['/', '/create', '/login', '/pricing', '/pricing#waitlist', '/tools']`，一个没变 |
| 2026-09-14 | **S15：一处刻意不走 next-intl `Link`**。定价页的页内锚点 `href="#waitlist"` 用普通 `<a>`——next-intl 的 `Link` 会给它加语言前缀，把同页跳转变成跨页导航。跨页的 `/pricing#waitlist` 仍走 `Link`，中文站实测渲染成 `/zh-Hans/pricing#waitlist` |
| 2026-09-14 | **S15：不拿 mock 当证据**。jsdom 没有挂载的 app router，单测里 `useRouter` 只能短路；所以另写了一条真实浏览器用例，选两次、断言 URL + `lang` + 中文标题 + 「同一路径的中英两版落在同一页面」（切语言把人丢回首页是这类实现最常见的错法）。切换器能不能用，只以那条为准 |
| 2026-09-14 | **S15：测试改用真实词条渲染**。`tests/ui/{shell,editor}.test.tsx` 包进 `NextIntlClientProvider` + 真实 `messages/en.json`，这样 key 打错或漏翻会**直接让用例失败**，而不是悄悄渲染出占位符 |
| 2026-09-14 | **S15 的诚实边界**：**营销与账号侧会说中文了，真正干活的编辑器还不会**。28 个 `.tsx` 仍是硬编码英文（`editor.tsx` 798 行、`source-input.tsx` 567 行为大头），S16 才抽。另有 `templates/`、`tools/`、`help/[slug]`、`guides/[slug]`、`legal/[slug]` 五类页面**刻意推迟到 S17**——正文来自 `content/*.json` 与 MDX，只翻外壳会做出半中半英的页面，比全英文更糟。两份 JSON 的 key 一致目前也只靠人工核对，S16 加断言 |
| 2026-09-14 | **S15 顺带澄清一条既有失败**：`support.spec.ts` T082 断言法律页出现 `"This directory is a review workspace."`，而这句话只在 `content/legal/README.md` 里、README 从不被渲染。把同一条用例打到未受影响的 `:3100`（9-11 旧构建）上**同样失败**——**不是本次抽取的回归**，属于 B-1 法律文本阻塞区域 |
| 2026-09-14 | **S16：key 对齐从此是断言，不是人工核对**。`tests/unit/i18n-messages.test.ts` 断言两份 JSON 的 key 集合完全一致、无空值、ICU 占位符对齐。做过变异验证：塞一个只有英文有的 key、把一条中文置空、删掉 `Billing.openingPortal` 中文里的 `{action}` 占位符，**三次注入各自变红**，还原后回到 3 passed。漏翻在 next-intl 下不会报错，只会让中文站悄悄渲染出英文——所以它必须是断言 |
| 2026-09-14 | **S16：一处「不是组件也要翻译」的处理**。`source-input.tsx` 的轮询与上传跑在模块级函数里，拿不到 `useTranslations`。给 `SourceFailure` 加了 `messageKey`，由表单的 catch 处统一翻译；**服务端回传的 message 仍原样透传**（那是服务端文案，属于另一层，本步不碰）。`editor-media.tsx` 的 `asMedia` 同理，翻译函数从调用处传入 |
| 2026-09-14 | **S16：起始文档也翻了**。空白编辑器里那六页示例内容（`createStarterDocument`）是中文用户第一眼看到的东西。它是内容不是界面 chrome，但留着英文就等于中文站开箱即英文，所以一并跟着语言走 |
| 2026-09-14 | **S16：测试补 Provider 时守住「断言仍读真实词条」**。6 份 UI 测试改用 RTL 的 `wrapper` 选项而不是手动套一层——`rerender` 会沿用 `wrapper`，手套的那层不会。`getTranslations` 在 vitest 里会解析到抛错的 react-client 桩，于是写了 `tests/helpers/intl-server.ts`：**只补请求上下文，词条仍从真实的 `messages/*.json` 读**，key 打错照样红 |
| 2026-09-14 | **S16 把 S15 推迟的五类页面提前做了外壳**。`templates/`、`tools/`、`help/[slug]`、`guides/[slug]`、`legal/[slug]` 的标题、眉题、按钮、元数据标题现已双语；**正文仍来自 `content/*`，那是 S17**。所以这五类页面现在是「中文外壳 + 英文正文」——S15 说过这比全英文更糟，这里是有意为之的中间态，S17 收口，不是完成态 |
| 2026-09-14 | **S16 的诚实边界**：`src` 下只剩品牌名（Orincard / LinkedIn / Pexels）和刻意不翻的主题名（Ink / Paper / Signal / Blush / Butter / Sky）与平台名。**但服务端错误文案、`content/*` 正文、工具注册表的 label 仍是英文**——中文用户触发一个服务端错误，看到的仍然是英文句子。这不在 S16 范围内，也没有假装已经做完 |
| 2026-09-14 | **S17：中文正文缺失时不回落英文**。`readContent` 读不到对应语言的文件就抛 `ContentNotFoundError`。回落看着更稳，实际是把漏翻藏起来——页面照样 200，只是中文用户读到一整页英文且没有任何信号。漏翻由 `tests/unit/content-locales.test.ts` 在构建前拦下，10 passed，变异验证：删一份中文 `.mdx`（2 条红）、把中文 `title` 改回英文原文（红）、让中文 `terms.mdx` 的 `policyVersion` 比英文多一天（红），还原后回到 10 passed |
| 2026-09-14 | **S17：法律审定守卫从 3 个文件扩到 6 个**。`release-guards.test.ts` 的 `ships approved payment policy copy` 现在两种语言各查三份；`covers subscription/cancellation/refund` 另加中文关键词分支——照搬英文正则只会因为一个中文字都不匹配而**误报通过**。这两条现在仍是红的（六份全是 `draft`），是 B-1 该红的红 |
| 2026-09-14 | **S17 的诚实边界：翻译没有替你做任何商业决策**。三份中文法律文本逐条对应英文草稿的立场——同样写明未经审定、同样不承诺退款、同样不定佣金比例、同样列出待审定问题。12 项决策仍然是 B-1，仍然等你拍板 |
| 2026-09-14 | **S17 有意没做 `content/templates.json`**。它在 `release-guards.test.ts` 眼里是「发行物」（`EXTRA_ASSET_PATHS` 明确算作素材），加一份中文模板库就要同步补权利登记，而那块正卡在 B-3。所以模板库现在是**中文外壳 + 英文模板**，已在验收文档 §八 点名，没有当作做完 |
| 2026-09-14 | **S18 完成，阶段二收口（实际花约 $0.03，预算 $0.10）**：生成语言从 `maxLength=80` 自由文本收成 `en` / `zh-Hans` 枚举，`isGenerationLanguage()` 同时把住 `validateOptions` 与 `POST /api/v1/generation`；`src/render/pptx.ts` 的 `fontFace()` 加 CJK 分支；`font-manifest.json` 补 Noto Sans SC 700。单测 300 → **314 passed / 7 skipped（44 文件）**，守卫回到 14/5 基线，构建 EXIT=0，`:3000` / `:3100` / `:8080` 改动前后均 200 |
| 2026-09-14 | **S18：prompt 里传的不是 `zh-Hans` 而是整句英文指令**。模型见过的 "Simplified Chinese" 远多于 "zh-Hans"，后者有时会被当成一个无意义的标签而整份输出英文。`tests/unit/generation-language.test.ts` 直接断言替换后的指令文本；变异验证：放宽 `isGenerationLanguage` 成「任意非空字符串」（7 条红）、prompt 改回传裸代码（1 条红）|
| 2026-09-14 | **S18：PPTX 的中文判定按整份文档，不按页**。一份英文稿里混进一个中文词（品牌名、引文）就足以让阅读器回退，所以 `deckHasCjk()` 扫全部标题、eyebrow、CTA 与正文块。三条变异各自跑红：去掉 CJK 分支（2 条红）、只看第一页（1 条红）、标题不传 cjk（1 条红）|
| 2026-09-14 | **S18：漏更字体归属会真的挂**。补 Noto Sans SC 700 后、改 `docs/licenses/assets.md` 前，`release-guards.test.ts` 从基线 5 条失败涨到 **6** 条，多出来的正是「字体清单与 manifest 对不上」。两份归属文档（`assets.md` + `fonts.md`）都补了 700 一行后回到 14/5 |
| 2026-09-14 | **S18：补 700 引出的 preflight 去重是改产品代码，不是放宽测试**。同一家族两个字重在 manifest 里是两条记录，`selectedFontFamilies()` 会把 "Noto Sans SC" 向浏览器问两遍；用 `new Set()` 去重解决。当时 6 条测试转红（5 条 preflight + 1 条 fonts），没有一条是靠改断言糊过去的 |
| 2026-09-14 | **S18 的诚实边界：PPTX 没有用真 PowerPoint 打开过**。本机 `system_profiler` 查过，没有 Noto Sans SC 系统字体，所以现在打开必然是回退字体——这不是改错了，是 **PPTX 不嵌字体**这个格式限制。LibreOffice 对比证明修前写 `Inter`（中文细体、粗体属性丢失）、修后写 `Noto Sans SC`（真粗体）。`deck.pptx` 在 `/tmp/orincard-s18`，你双击即可确认 |
| 2026-09-14 | **S18 留给你一个产品取舍**：PPTX 写 `Noto Sans SC` 与预览逐字形一致，但 Windows / macOS 都不预装，收件人多半看到回退字体；换成 `PingFang SC` / `Microsoft YaHei` 则大多数机器都认，但永远和预览对不上，且两个系统不是同一个。当前按计划选了前者，**没有替你改** |
| 2026-09-14 | **S18 的花费如实记账：三次 DeepSeek 调用，约 $0.03**。前两次失败是我自己的 source fixture 用了不合法 ID（域模型要求 UUID 或 `local-` 前缀），第二次是为了把 zod 报错打出来才重跑的。**token 照烧，失败的两次一样算钱**，不摊平不隐去 |
| 2026-09-14 | **S19 完成（$0.00）**：spec 补 AC-012（编辑器对话助手），tasks 另起 B13 加 T096–T099（不动 B01–B12 已冻结的编号与依赖），plan 补 B13 行并把关键路径延到 B13。`docs/design/prototype/` 新增 `assistant.html` 与 `assistant-conflict.html`，`index.html` 从八屏改十屏、README 加入口与决策说明。`pnpm typecheck` EXIT=0，守卫仍 14/5 基线，`check-planning` PASS 且冻结快照仍 `15 unchanged design files` |
| 2026-09-14 | **S19：助手原型画了六态，不是计划里的四态**。计划要求「思考中 / 提出改动 diff / 确认拒绝 / apply 失败」，实际拆成六个：确认与拒绝是两条不同的结局（一条写出 v6、一条逐列不变），必须分开看；另外补了「预算打满整轮被拒」一态——AC-012 明写预算耗尽必须**拒绝**该轮而不是照跑，图上没有这一态就没法过图 |
| 2026-09-14 | **S19：三条在图上拍死、实现时不得放宽的规则**：①提议不预览，画布始终显示已保存那一版——让画布先变成提议后的样子等于用「看起来已经改了」换用户确认；②冲突页没有「仍然应用」，三条出路没有一条是拿旧提议盖掉新 revision；③预算不够时模型根本不被调用，页面上连思考动画都没有 |
| 2026-09-14 | **S19：助手占右栏是布局层改动，这正是 S20 要过的图**。画布从 400 px 缩到 340 px、缩略图从 140 px 缩到 116 px，原单页检查器退到同栏 *Slide* 标签后。代价写在 `assistant.html` 顶部的 notice 里，不藏在 README 里 |
| 2026-09-14 | **S19：没碰 `docs/design/reference/`**。两屏引用 `../reference/assets/orincard.css` 与 `ori.js`，没有新增任何全局 class（页面私有布局写在页内 `<style>`），没有新增图片。`check-planning` 的 `15 unchanged design files` 是这条的证据 |
| 2026-09-14 | **T096 就地停住，不进 T097**。tasks.md 里 T096 的 Expect 行写着「产品所有者过图前不进入 T097」，S20 是计划里的 🛑。助手的 runtime（S21）与编辑器接线（S22）都等这道门 |
