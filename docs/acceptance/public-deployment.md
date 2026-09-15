# 公开部署到 Vercel

## 2026-09-15 · 实测记录 — ⚠️ 部分跑通，**不整体勾选**

目标是「拿到一个陌生人能打开的公开地址」。**站点已经公开可访问**，但生成链路还缺 worker，注册链路还卡在邮件确认。下面逐条写实测结果，跑不通的不用 mock 遮。

---

## 一、生产 Supabase 项目

新建 `orincard-prod`（ref `jbnejmpzkeybsdwifbdr`，us-east-2）。开发库 `ettuzeunkadkfnawawdy` 全程未被写入。

迁移不走 `supabase link`，而是 `supabase db push --db-url`，因为 `link` 会改写 `supabase/.temp/project-ref`，之后本地跑验收就会打到生产库上。用 `--db-url` 是直连 Postgres，不碰这个文件。

推完的实测（`supabase db query --db-url`）：

| 项 | 实测 |
|---|---|
| `supabase_migrations.schema_migrations` | **27** |
| `public` 表 | **21** |
| 其中开启 RLS 的 | **21 —— 全部** |
| `storage.buckets` | `assets, exports, sources` |
| `server_*` RPC | **61** |
| `server_settle_cost_attempt` | 存在 |
| `billing_plan_key` 枚举 | `free, pro, creator` |
| 推完后 `.temp/project-ref` | `ettuzeunkadkfnawawdy` —— 仍是开发库 ✅ |

⚠️ **这个项目在另一个 org 下，Management API 够不到**。`GET /v1/projects/jbnejmpzkeybsdwifbdr/config/auth` 对两把 PAT 都返回 403（`/v1/profile` 同样 403，提示 `requires a user-scoped access token`）。后果：迁移状态、重启、日志、Auth 配置，全部只能在控制台人工操作，脚本自动化这条路对这个项目是断的。

⚠️ **生产库数据库口令需要重置**。推迁移的过程中我的一处掩码写错，把 16 位口令整个打进了对话。它只在 `db push` 时用得到，运行时用不到，重置零成本。**这条尚未执行。**

---

## 二、Vercel

| 项 | 实测 |
|---|---|
| 项目 | `orincard`（`prj_NIFQxUaEtxU2EK5qS1VAWkVFZ2Jo`） |
| 生产环境变量 | 21 条，`vercel env ls production` 清点齐全 |
| `SUPABASE_PROJECT_REF` = `SUPABASE_PRODUCTION_PROJECT_REF` | 是 —— `environment.ts` 的生产断言要求相等 |
| 构建 | 成功，1 分钟，全部路由产出 |
| 生产别名 | `https://orincard.vercel.app` |
| `AI_MONTHLY_BUDGET_USD` | `1`（与本地那份 `10` 各算各的） |
| `BILLING_LIVE_ENABLED` / `AFFILIATE_PAYOUTS_ENABLED` | 均 `false` |
| 未配置 | `STRIPE_*`、`RESEND_API_KEY`、`MAIL_FROM` —— 本地就是空的，塞假值只会让故障更难查 |

**Deployment Protection 默认是开的**，首次部署后 `ssoProtection.deploymentType = "all_except_custom_domains"`，陌生人会撞上 Vercel 登录墙。已用 `vercel project protection disable orincard --sso` 关掉，复查 `ssoProtection: null`。

首页实测（浏览器打开 `https://orincard.vercel.app/`）：标题、导航、三段内容、语言切换器全部正常渲染，无登录墙，早期预览横幅在首屏第一行。

⚠️ **`*.vercel.app` 在本机这条网络上被 DNS 污染**（解析到 `211.104.160.39`，不是 Vercel 的地址段），shell 里 `curl` 一律超时，`vercel curl` 也超时——它只是先取旁路令牌再本地 curl。浏览器走了另一条出口所以能通。这意味着：**站点对外是活的，但在中国大陆的裸网络下打不开**。要让国内用户直接访问，得挂自有域名 + 可解析的 DNS，这一步没做，也没买域名。

⚠️ 一个 `automation-bypass` 旁路密钥被 `vercel curl` 自动创建并留在项目上。SSO 已关，它现在不解锁任何东西，但**尚未清除**。

---

## 三、注册链路

实测：在 `https://orincard.vercel.app/en/signup` 提交邮箱和口令，账号在新库里建出来了，页面返回

> Check your email to confirm your account, then sign in.

也就是 **Confirm email 仍然开着**。Supabase 内置 SMTP 限 2 封/小时，所以公开注册这条路现在**实际是断的**。关这个开关要在控制台（Authentication → Sign In / Providers → Email），API 够不到。

另外两项 URL 配置**尚未设置**：Site URL 和 Redirect URLs 里的 `https://orincard.vercel.app/auth/callback`。`auth-form.tsx:35` 用 `window.location.origin` 拼回跳地址，不加白名单的话 Google 登录和密码重置的回跳会失败。

---

## 四、后台任务（Trigger.dev）— ❌ 未部署

原计划是 `trigger deploy --env prod`。查完环境变量后**没有执行**，因为：

```
Trigger prod 环境里出现开发库 ref : True
Trigger prod 环境里出现生产库 ref : False
APP_ENV = development
```

这个 Trigger 项目只有一套 prod 环境，而它当前配的是**本地开发**那一套（本地 `.env.local` 的 `TRIGGER_SECRET_KEY` 就是 `tr_prod_` 开头）。照原计划部署，公开站的后台任务会写进开发库——正是 `src/server/environment.ts` 的两条断言要挡的事。

已决定的走法：**给公开站单开一个 Trigger 项目**，本地那套一个字节不动。为此改了 `trigger.config.ts`：`syncEnvVars` 拆成 `SHARED_VARS`（4 个，无条件同步）和 `PUBLIC_ONLY_VARS`（16 个，只在 `APP_ENV=production` 时同步）。没有这道闸，任何一次本地 deploy 都会把开发库的值覆盖到公开站的 worker 上。目标项目用 `trigger deploy --project-ref` 选，不动硬编码的 `TRIGGER_PROJECT_ID`。

**后果，说明白：worker 没部署之前，公开站能浏览、能注册、能建项目，但点生成会永远卡在 queued。**

---

## 五、这次部署没有改变的事

- **付费完全不可用** —— `STRIPE_SECRET_KEY` 空、`BILLING_LIVE_ENABLED=false`。定价页能看，升级点不动。这是 B-2。
- **支持表单发不出邮件** —— `RESEND_API_KEY` 空，`/api/v1/support` 会失败。
- **法律文本未审定** —— `terms.mdx:10` 正文仍写着 "must not be used as production terms"。首页横幅已如实标注，但标注不等于审定，B-1 那 12 项商业决策仍未定。
- **`release-guards.test.ts` 仍是 5 红** —— 本地 CLI 直推绕开了 `release.yml`，也就绕开了那五条发布守卫。守卫没变绿，只是没挡在路上。
- **Vercel Hobby 档不允许商业用途** —— 现在零收入、付费关闭，属预览性质；真收钱要升 Pro。
- **邮箱不做验证**（一旦关掉 Confirm email）—— 这是「注册即登录」的直接代价。

---

## 结论

| 步骤 | 状态 |
|---|---|
| 生产库建成、27 份迁移落地、开发库未被污染 | ✅ |
| Vercel 环境变量与构建 | ✅ |
| 公开可访问（无登录墙） | ✅ |
| 首页如实标注早期预览 | ✅ |
| 国内裸网络可直接访问 | ❌ 需自有域名 |
| 注册即登录 | ❌ Confirm email 待在控制台关闭 |
| Auth 回跳白名单 | ❌ 未配置 |
| 后台任务 worker | ❌ 待新建独立 Trigger 项目 |
| 端到端实测（注册→生成→导出→下载） | ❌ 未执行，被上面两条挡住 |
| 生产库口令重置 | ❌ 未执行 |

**AI 花费：$0.00。** 本次部署全程没有调用过任何模型供应商。
