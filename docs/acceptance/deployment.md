# T085 分环境 CI 与受控发布

## 2026-09-12 · 实测验收 — ⚠️ 未通过，**不勾选**（路线图 S5）

`tasks.md:573` 的 Check 只是 `pnpm exec vitest run tests/unit/deployment.test.ts`，而这条命令做的全部事情是**把两份 YAML 当字符串做文本断言**。它绿，只能证明 YAML 里写着那些字；不能证明流水线真能跑。Expect 那一行要的是「Preview 不接生产；发布同一已测试 commit……失败不晋升」——那是运行时行为。

所以这次没有照着 Check 命令跑一遍就打勾，而是去问 GitHub：**这两条流水线到底跑过没有，跑成什么样。**

### 一、真实 CI 历史

`gh run list` 的全部记录：

| 项 | 实测 |
|---|---|
| 历史运行总数 | 6 |
| 结论 | **6/6 `failure`** |
| 工作流 | 全部是 `Check and Preview`，分支 `codex/walking-skeleton` |
| `Controlled Production Release` 出现次数 | **0 —— 从未运行过** |

取一次具体的（`gh run view 34491465657`）：

```
✓ test     in 1m0s
X preview  in 7s
  X Reject production resources in Preview
    Process completed with exit code 1
```

`test` 作业**真绿**：install / typecheck / test / test:planning / git diff --check 全过。`preview` 作业在**第一个步骤**就挂，挂在守卫上。

### 二、preview 为什么挂 —— 这是失败安全，不是缺陷

`gh api .../environments`：

| 项 | 实测 |
|---|---|
| 存在的 environment | 只有 `preview` |
| `preview` 的 variables | **空** |
| `preview` 的 secrets | **空** |
| `production` environment | **404 Not Found，不存在** |

`check.yml:47-51` 的守卫头一句就是 `test -n "$SUPABASE_PROJECT_REF"`。变量没配 → 空串 → 非零退出 → `preview` 作业停住，`vercel deploy` 那三步一步都没跑到。

**这正是它该有的行为。** 配置缺失的时候，流水线选择停下，而不是拿着空变量往下走。6 次红是守卫在干活的证据，不是流水线坏了的证据。

### 三、守卫的真实执行验证

只读 YAML 判断不了 shell 语义，所以把两处守卫的脚本原样抽出来，在本机用 GitHub 自己的解释器标志（`bash --noprofile --norc -eo pipefail`）实跑六种情形：

| 守卫 | 情形 | 退出码 | 判定 |
|---|---|---|---|
| Preview（`check.yml:47-51`） | 变量未配置（今天 CI 的真实处境） | 1 | ✅ 拦住 |
| Preview | 误指向生产库 | 1 | ✅ 拦住 |
| Preview | 正确配置（指向非生产） | 0 | ✅ 放行 |
| 生产（`release.yml:66`、`release.yml:122`） | 变量未配置 | 1 | ✅ 拦住 |
| 生产 | 误指向非生产库 | 1 | ✅ 拦住 |
| 生产 | 正确指向生产 | 0 | ✅ 放行 |

六种全部正确。生产那条写成 `test -n "$A" && test "$A" = "$B"`，在 `-e` 下 `&&` 左侧失败会让整条命令返回非零 —— 实跑确认了这一点，没有靠推断。

### 四、「失败不晋升」的依赖链

逐个作业查了 `needs`、`if:`、`always()`、`continue-on-error`：

```
release.yml:  test → migrate → worker → website     （后三个都带 environment: production）
check.yml:    test → preview                        （preview 带 environment: preview）
```

全仓这两份文件里 **`always()` / `continue-on-error` / `if:` 一个都没有**。是一条没有旁路的严格链：前一环红，后一环不会启动。「失败不晋升」在结构上成立。

### 五、途中发现并修复的一个真缺陷

`package.json` 的 test 脚本是：

```
vitest run --exclude 'tests/cloud/**'
```

而**发布阻断器 `tests/cloud/release-guards.test.ts` 恰好住在 `tests/cloud` 里**。也就是说，受控发布流水线跑 `pnpm test` 的时候，**跑不到自己的发布守卫**——法律文本未审定、头像未登记这些本该拦住发布的红灯，在发布路径上根本不会亮。

这些守卫现在是 14 通过 / 5 失败。修复前，那 5 条红的可以一路绿灯直奔生产。

**已修**（`.github/workflows/release.yml:46-49`），在 `test` 作业里、所有 `environment: production` 作业之前显式加一步：

```yaml
- run: pnpm exec vitest run tests/cloud/release-guards.test.ts
```

并在 `tests/unit/deployment.test.ts` 加了第 5 条用例锁住它，含顺序断言（这一步必须出现在第一个 `environment: production` 之前）。把该行删掉，用例立刻转红——变异验证过，不是空断言。

### 六、为什么 T085 不能勾

Expect 有两半。**Preview 那半站得住**：真跑过 6 次，守卫真拦住过，`test` 作业真绿过。**发布那半一次都没验证过**，而且现在**没法验证**：

| 障碍 | 实测 |
|---|---|
| `release.yml` 在 GitHub 上注册了吗 | **没有。** `gh api .../actions/workflows` 只返回 `Check and Preview`（`check.yml`，state=active） |
| 为什么 | 默认分支是 `main`；`git cat-file -e origin/main:.github/workflows/release.yml` → **不存在**（check.yml 也不在）。`workflow_dispatch` 要求文件在默认分支上才登记 |
| 能手动触发吗 | **不能**，未注册的工作流无法 dispatch |
| 有 production environment 吗 | **没有**，404 |

而两条出路都被本次会话的硬约束挡住：把工作流放上 `main` 需要动分支（禁止），真跑一次发布要碰生产（禁止）。

> **2026-09-18 复核（上表前三行已过期）**：`main` 合并推送之后，`gh workflow list --all` 返回两条——`Check and Preview`（354933076）和 **`Controlled Production Release`（360627317，active）**。`release.yml` 已注册，dispatch 的前提具备了。第四行不变：`gh api .../environments` 仍只有 `preview`，`production` 不存在。
>
> 又查出一条上表没覆盖的障碍：`release.yml` 的 `test` 作业跑 `release-guards.test.ts`，但**从没把 guard 3 读的六个 Stripe 变量映射进作业环境**，所以它在 CI 里恒红，且红的原因分不出「发布该被拦」还是「闸门坏了」。已补 `env:` 映射（见 `docs/roadmap.md` 的 B-4 第 4 条）。本地实测：`release-drill` 9 条全绿，`release-guards` 只剩 2 条红，都指向 B-2。
>
> **T085 仍然保持未勾**：发布那半依旧一次都没真跑过，`production` 环境也还没建。注册成功只是让它变得**可能**被验证，不是已被验证。

还有一层：`tasks.md:572` 写 `Depends: T084`，T084 卡在 B-2（Stripe 测试密钥）上未完成。**依赖未满足的任务本来也不该先勾。**

结论：**T085 保持未勾选**。这和 `docs/handoff/b06-b11-codex.md:46` 的既有判断一致——「不要因为『测试绿了』就补勾」。

### 七、要勾上 T085，需要你做的配置

这些我做不了（要动 `main`、要碰生产、要生产凭据）：

1. **把两份工作流合入默认分支 `main`** —— `release.yml` 才会被 GitHub 注册，才可能 dispatch。
2. **建 `production` GitHub environment**，并挂上保护规则（required reviewers / wait timer）。现在它压根不存在，意味着 `release.yml` 里那三个 `environment: production` 目前是**空门**——真跑起来会自动创建一个**无保护**的同名 environment，门形同虚设。
3. **配变量与密钥**：

   | 作用域 | Variables | Secrets |
   |---|---|---|
   | `preview`（现有，全空） | `SUPABASE_PROJECT_REF`、`SUPABASE_PRODUCTION_PROJECT_REF`、`VERCEL_ORG_ID`、`VERCEL_PROJECT_ID` | `VERCEL_TOKEN` |
   | `production`（待建） | 同上四项，且 `SUPABASE_PROJECT_REF` 必须**等于** `SUPABASE_PRODUCTION_PROJECT_REF` | `VERCEL_TOKEN`、`SUPABASE_ACCESS_TOKEN`、`SUPABASE_DB_PASSWORD`、`TRIGGER_ACCESS_TOKEN` |

   注意两个环境对 `SUPABASE_PROJECT_REF` 的要求是**相反**的：preview 守卫要求它 ≠ 生产 ref，production 守卫要求它 = 生产 ref。配反了两边都会被自己的守卫拦住。

4. 配完后，`preview` 会先转绿；`release.yml` 的一次真实 dispatch 跑通，T085 才有资格勾。

### 八、本步花费

**$0.00。** 全部是只读的 `gh api` 查询和本机 bash 执行，没有调用任何 AI 供应商，没有触碰生产，没有部署任何东西。

---

## 九、2026-09-20 通行性排查：还差什么才能正常访问

用户报「打不开」。查实后要把两件事分开，它们缺的东西完全不同。

### 9.1 只是要「能打开」——缺 1 件，且不在代码里

`*.vercel.app` 在本网络被域名级封锁，证据链见 `docs/roadmap.md` 2026-09-20 两行。简述：同一个名字在四个解析器下返回四个互不相同的假 IP（Facebook 网段 / Twitter 网段 ×2 / 香港 HKT），真 anycast `76.76.21.21` 一个都没对上；强行 `--resolve` 到真 IP 后 TLS 被重置（curl exit 35），所以还叠了一层 SNI 阻断。对照组：`nextjs.org` 同样托管在 Vercel、走自定义域名，本机 **200**。

**结论：改部署配置、补变量、关部署保护，一个都救不了这个 URL。唯一的解是绑自定义域名。**

绑域名的连带项（容易漏，漏了会变成「首页能开，一登录/一付款就跳回打不开的地址」）：

- Production 的 `NEXT_PUBLIC_APP_URL` 现在是 `https://orincard.vercel.app`，被 `src/server/billing/stripe.ts:37-44` 当作 checkout 回跳 origin。
- Supabase Auth 的 Redirect URLs 白名单也要加新域名。

### 9.2 要「功能正常」——缺 4 类

方法：把 `src/` 里所有 `process.env.*` 读取点拉出来，与 `vercel env ls` 的 21 条做差集。**这些全是懒加载的**（都在路由处理函数内部读），所以缺失不会让站点 500，只会让对应功能降级。

| 缺什么 | 后果 | 谁能补 |
|---|---|---|
| `BILLING_POLICY_JSON` | 定价页三张卡全显示「权益暂不可用」 | 值在 `.env.local` 里现成，命令见 9.4 |
| `STRIPE_LIVE_SECRET_KEY` / `STRIPE_LIVE_MONTHLY_PRICES_JSON` / `STRIPE_LIVE_YEARLY_PRICES_JSON` | checkout 抛 `BILLING_NOT_CONFIGURED` | 只有用户，且**现阶段不该补**，见下 |
| `RESEND_API_KEY` / `SUPPORT_EMAIL_FROM` / `SUPPORT_EMAIL_TO` | 支持表单发不出邮件 | 只有用户（本机没有） |
| 生产库缺 4 个迁移 | 等候名单接口 503 | 需用户明确授权 |

Stripe 那组有个必须写下来的机关：`src/server/billing/stripe.ts:34` 按 `VERCEL_ENV === "production"` 切 live/test，**生产环境只认 `sk_live_`**；而 `release-guards` 的 guard 3 要求 `STRIPE_LIVE_SECRET_KEY` 在验收期间**必须为空**。两者不矛盾——现阶段生产站的付款本来就该是关的，要开得先走完验收。

缺的 4 个迁移：`20260916000100_copilot_job_kind`、`20260916000200_copilot_turn`、`20260916000300_b04_begin_period_ambiguity`、`20260917000100_waitlist`（本地 36 个）。**「生产是 27 个」是上一轮推算的，本轮没有重新核实**——读生产库的权限被拦过，没有绕行。

### 9.3 不影响打开、但堵着自动化的

- `preview` 环境 0 个变量（`vercel env ls` 的 21 条全部只挂 Production）→ 预览部署连不上 Supabase。
- GitHub `production` 环境不存在 → 三处 `environment: production` 是空门（详见第七节第 2 条）。
- `VERCEL_TOKEN` 本机没有 → CI 部署不了，只能本机手动发。
- B-2：`sk_test_` 开头的测试密钥全机器都没有 → 发布闸门剩的 2 条红全是它。这条卡在密钥不存在，不是权限问题。
- Trigger worker 从没带着 `public/media/curated/*.webp` 的修复重新部署过 → 那条修复仍未实机验证。

### 9.4 BILLING_POLICY_JSON：待用户执行

本轮尝试代为添加，`vercel env add` 连续两次被权限分类器拦下，**没有绕行**。值已验证：514 字节、3 个套餐、不含任何 Stripe 价格 id 或密钥、单行、与环境无关，放生产是安全的。

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/www.macpe.cn/Documents/ChatGPT/Orincard-walking-skeleton
set -a; . ./.env.local; set +a
printf '%s' "$BILLING_POLICY_JSON" | pnpm dlx vercel@59.15.1 env add BILLING_POLICY_JSON production
```

核对：`pnpm dlx vercel@59.15.1 env ls | grep BILLING_POLICY_JSON`，`environments` 列应为 `Production`。

**Vercel 环境变量只在构建时注入，改完不会自动生效，要等下一次部署。** 所以这条是为将来绑域名那一刻预先就位，不是立刻改变什么。

### 9.5 本机服务现状（本轮实测）

`:3000` 的 `/zh-Hans`、`/zh-Hans/pricing`、`/zh-Hans/templates` 全 200，标题正确，定价页**没有**出现「权益暂不可用」；`POST /api/v1/waitlist` 带 `Origin` 头返回 **201** `{"recorded":true}`，不带 `Origin` 返回 400 `The request origin is not allowed`（这是 CSRF 来源校验在正常工作，不是故障）。

**`:3100` 是过期构建**，`/zh-Hans` 三条路径全 404，它服务的 `.next` 早于 `[locale]` 路由改造。不要拿它当参照。今天全部工作只有 `http://localhost:3000/zh-Hans` 一处能看到。
