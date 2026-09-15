# 全产品发布巡检记录（Phase A 页面健壮性 / T095 全产品冒烟）

状态：**Phase A `PASS`；A5 登录态 404 `PASS`（真实账号实测）；T095 全产品冒烟 `PASS`（匿名 31 + 登录态 27 全绿）；D1 额度链路 `PASS` / 真实出图 `FAIL`（网络出口）；D2 `PASS`（渲染、校验、迁移均已实测）；D3 `PASS`（14 套模板逐条 200，分类导航三引擎绿）；D4 `PASS`（模板选择器灌选项、引导只出现一次，五个既有 spec 无回归）；D5 `PASS`（博客双语 8 条路由 200，未知 slug 真 404）；Phase C 编辑器助手 T096–T099 `PASS`（三条真实浏览器用例全绿），其成本预留结算顺序修复 `UNVERIFIED`（额度耗尽 + 权限受限，见 §12.3）**

记录日期：2026-09-15，D2 / D3 / D4 / D5 四节 2026-09-16 追加，Phase C 一节 2026-09-16 追加。全部在本机 `next dev`（`:3000`）上执行，Supabase 用**开发**项目（`ettuzeunkadkfnawawdy`），未触碰生产项目。

---

## 1. Phase A 做了什么

交接文档 `docs/handoff/product-completion.md` 的结论是「23 条路由匿名 SSR 全部 200」，但全站没有任何 `error.tsx` / `not-found.tsx`，任何一条不存在的 URL 都落在 Next 的原生页上。

新增：

| 文件 | 作用 |
|---|---|
| `src/app/[locale]/not-found.tsx` | 品牌化 404，复用 `PublicHeader` / `PublicFooter` |
| `src/app/[locale]/[...rest]/page.tsx` | 把未匹配的 URL 引进 `[locale]` 段，否则上一条不生效 |
| `src/app/[locale]/error.tsx` | 段内错误边界，带 `reset()`，只显示 `digest` |
| `src/app/global-error.tsx` | 根 layout 自身崩溃时的兜底，自带 `<html>/<body>` |

修改：`src/app/[locale]/editor/[id]/page.tsx` —— 把「匿名」与「项目不存在」从同一个 `catch` 里拆开（A5）。

---

## 2. 实测证据：404 修复前后

修复前的数字取自交接文档与本轮复核（`:3000`）。

| 路由 | 修前 | 修后 | 结果 |
|---|---|---|---|
| `/no-such-page` | 200 → 11,587 B Next 原生页，零品牌标记 | **404**，50,642 B，8 处品牌标记 | **通过** |
| `/zh-Hans/no-such-page` | 同上 | **404**，50,689 B，中文文案（「这个页面不存在」「浏览模板」「回到首页」） | **通过** |
| `/templates/nope` | 404，无站点外壳 | **404**，52,961 B，带外壳 | **通过** |
| `/fr/pricing`（未注册语言） | 404 原生页 | **404**，50,642 B，带外壳 | **通过** |

---

## 3. 一条计划外的发现：`loading.tsx` 会把 404 变成 soft 404

原计划 A4 要加 `[locale]/loading.tsx` 与 `editor/[id]/loading.tsx`。**加上之后实测 `/no-such-page` 与 `/templates/nope` 全部从 404 退化成 200**，页面内容仍是 404 文案——即典型的 soft 404。移走这两个文件后立刻恢复 404。

原因：`loading.tsx` 会在段上建立 Suspense 边界，使响应变成流式，HTTP 状态在 `notFound()` 解析出来之前就已经提交。

**决定：撤销 A4，两个文件已删除，`Loading.*` 词条一并撤回。** 加载提示不值得用全站正确的 404 状态码去换——soft 404 会让搜索引擎收录一批不存在的页面，也会让 T095 的 404 断言失效。将来若要做加载态，必须是不跨越任何会 `notFound()` 的段的局部 Suspense。

---

## 4. 匿名 SSR 全量巡检（2026-09-15，`:3000`）

23/23 通过。

```
200  65750B  /                          200  69490B  /support
200  60912B  /pricing                   200  55181B  /affiliate
200  50212B  /login                     200  55326B  /affiliate/dashboard
200  50242B  /signup                    200  73019B  /help/getting-started
200  50344B  /reset-password            200  61134B  /legal/privacy
200  69482B  /projects                  200  57337B  /templates/clear-idea
200  62154B  /create                    200  68325B  /tools/caption
200  72171B  /templates                 200  88707B  /editor/local-demo
200  71507B  /tools                     200  guides/text-to-carousel
200  68520B  /agent                     200  /help/export-and-restore
200  54638B  /billing                   200  /help/billing-and-cancellation
200  73083B  /brand-kits                200  /legal/affiliate
200  69012B  /exports                   200  /zh-Hans, /zh-Hans/pricing, /zh-Hans/templates
200  69472B  /settings
```

静态检查（`export PATH="/opt/homebrew/opt/node@22/bin:$PATH"` 后）：

```
pnpm typecheck                    → exit 0
pnpm test                         → 51 files / 389 passed | 7 skipped
node scripts/check-planning.mjs   → PASS：102 tasks / 12 ACs / 50 API paths / 15 unchanged design files
```

---

## 5. 一个必须记下来的环境坑

本轮在 `[locale]` 段内增删文件时，`next dev` 的 Turbopack 图两次进入损坏状态，症状是一批路由返回 500 且报文完全相同：

```
Module …/next/dist/client/app-dir/link.react-server.js [app-rsc] was instantiated
because it was required from module src/app/[locale]/<某个页面>/page.tsx [app-rsc],
but the module factory is not available.
```

判定为 **HMR 残留而非代码缺陷**，依据：报错路由集合在代码完全不变的情况下每次文件移动后都换一批；`touch` 共享模块（`public-header.tsx`、`i18n/navigation.ts`、`workspace-shell.tsx`）都无法清除；而 `pnpm typecheck` 与全部 389 个测试始终是绿的。**只有重启 `next dev` 能清掉。** 重启后 23 条路由全部恢复。

注意 `:3000`（dev）与 `:3100`（生产构建）**共用同一个 `.next` 目录**（`.next/cache/turbopack` 334 MB），这也是 `pnpm build` 被禁的原因。本次只重启了 dev 进程，没有删除任何缓存。

---

## 6. Phase B：T095 全产品冒烟（2026-09-15，`:3000`）

第 4 节那条 for 循环现在是断言了。新增 `tests/e2e/full-product.spec.ts`（26 条路由 × 匿名/登录两遍 + 4 条 404 断言）与共享登录 fixture `tests/e2e/fixtures/authenticated.ts`（worker 级登录一次，复用 `storageState`；`playwright.config.ts` 是 `workers: 1`，整轮只发生一次登录）。

按 `tasks.md` T095 写的 Check 命令原样跑，**58 passed（1.4m）**，契约与浏览器两半一次过：

```sh
( set -a; . ./.env.local; set +a; \
  ORINCARD_RUN_FULL_PRODUCT_E2E=1 pnpm exec vitest run tests/contracts/api-coverage.test.ts && \
  ORINCARD_RUN_FULL_PRODUCT_E2E=1 pnpm exec playwright test tests/e2e/full-product.spec.ts )
```

此前分两半跑的数字一并留档：匿名 31 passed / 27 skipped / 10.1s（不带 `ORINCARD_RUN_FULL_PRODUCT_E2E`，登录态自动跳过）；登录态 `--grep "signed in"` 27 passed / 60.0s。合并跑时首条登录态用例含 worker 级登录本身（42.2s），其余每条 0.6–6.7s。

每条路由断言四件事，不只是状态码：HTTP 200 / 正文不含 `Application error`、`Internal Server Error`、`Unhandled Runtime`、`This page could not be rendered` / `h1` 可见 / console 与 `pageerror` 零错误。编辑器没有 `h1`（顶栏是应用外壳不是文章标题），单独断言 `[data-editor-slide-id]` 可见。

**A5 就是在这里验到的**：`signed in › returns 404 for a project that does not exist` —— 用真实账号打开 `/editor/<crypto.randomUUID()>`，拿到 **404 + 品牌外壳 + `This page does not exist`**，而不是修复前那个「看起来像项目被清空了」的 200 空白草稿壳。

404 那组同时守住状态码与外壳（`/no-such-page`、`/templates/nope`、`/fr/pricing` 各断言 404 + `Public navigation` 可见 + h1 文案，`/zh-Hans/no-such-page` 断言中文 h1），第 3 节那个 soft 404 回归从此有测试拦。

静态检查同时复核：`pnpm typecheck` exit 0；`pnpm test` 51 files / 389 passed | 7 skipped（基线未降）；`node scripts/check-planning.mjs` 仍报 15 unchanged design files。

---

## 7. Phase D1：AI 配图额度（G5）

**结论：额度链路 ✅ 修好并实测；真实出图 ❌ 未验到，原因是本机连不上供应商，非代码缺陷。本轮花费 $0.00。**

断点原本在三处，逐处修完：

| 位置 | 改动 |
|---|---|
| `src/domain/entitlements.ts` | `Entitlements` 加**可选** `monthlyImages?: number` |
| `src/server/billing/policy.ts` | 新增 `optionalNonNegativeInteger` 解析。不复用 `positiveInteger`（它拒绝 0，而 0 是合法配置）；缺失返回 `undefined` 且**不把键放进结果**，让「没配」与「配成 0」保持可区分 |
| `src/server/billing/entitlement-grant.ts` | `grantsForPlan` 在策略配了 `monthlyImages` 时追加 `{ resource: "image" }`；原来那段「为什么不发 image」的注释改写成「配了就发、没配就不发」 |
| `src/app/api/v1/assets/generate/route.ts` | **计划外补的一处**：这条路由原本没接发放回调，只读不发。于是只画图、从不生成轮播的用户永远拿不到 image 桶。现在与 `/generation`、`/agent`、`/tools/[tool]` 同一个口径，提交前先发放 |

开发环境 `.env.local` 的 `BILLING_POLICY_JSON` 三个方案补上 free 10 / pro 100 / creator 300（子 shell 内脚本改写，值未进日志或 Git；原文件备份在 `.env.local.bak-image-quota`）。

**数据库层实测** —— 挑一个确定零桶的周期，跑真实的 `ensureEntitlementsForPeriod`：

```
BEFORE (2026-10-01T00:00:00.000Z): (no buckets)
AFTER  (2026-10-01T00:00:00.000Z): [{"resource":"generation","granted":10},{"resource":"image","granted":10}]
```

D1 之前这里只会出现 `generation` 一条。

**路由层实测** —— 真实登录态 POST `/api/v1/assets/generate`（`kind: "ai_image"`），拿到 **202**：

```json
{"data":{"assetId":"4a85b962-9dbc-4917-84de-3d0a8609126c","state":"pending_upload"}}
```

修复前这里必然是 429 `QUOTA_EXCEEDED`。

**没验到的那一半**：Trigger worker 随后出图失败，`assets.state = failed`。原因是供应商不可达，不是代码问题——裸 curl 复现同一现象，本机未配 `HTTPS_PROXY`：

```
[apimart] request failed { step: 'submit', error: 'TypeError', code: 'UND_ERR_CONNECT_TIMEOUT' }
$ curl https://api.apimart.ai/v1/tasks/x   → 000，connect=0s，25s 超时
```

失败路径的账目是对的：`usage_accounts` 的 image 桶事后是 `reserved=0`，`consumed` 未变——预留已释放，没有白扣一张额度。供应商请求从未建立连接，**实际花费 $0.00**。要验完整出图需要给本机配到 apimart 的网络出口。

单测：`tests/unit/entitlement-grant.test.ts` 与 `tests/unit/entitlements.test.ts` 共补 6 条（无字段时只发 1 个桶的向后兼容、有值发 2 个桶、0 也发桶、解析缺省不产生键、0 合法、负数/小数/字符串拒绝）。`pnpm test` 从 389 涨到 **395 passed | 7 skipped**，`pnpm typecheck` exit 0。

---

## 8. Phase D2：1:1 与 16:9 两种真几何（G2）

### 8.1 改了什么

`platformPresets` 补 `square` 1080×1080 与 `presentation` 1920×1080。计划里点名的五处手写平台清单**全部改成从 `platformPresets` 派生**，不再各抄一份：

| 位置 | 改动 |
| --- | --- |
| `src/domain/document.ts` | 新增两个 preset；导出 `platformKeys` / `isPlatformKey`；`z.enum` 从 `platformKeys` 派生 |
| `src/app/api/v1/generation/route.ts` | 硬编码白名单 → `isPlatformKey` |
| `src/server/projects.ts` | 三连比较 → `isPlatformKey` |
| `theme-panel.tsx` / `options.tsx` / `library.tsx` | 三处手写选项 → `platformKeys.map`，标签走新的 `Platform` 词条 |
| `supabase/migrations/20260915010000_…sql` | `platform_preset` 枚举补两个值（**尚未 push**，见 §8.4） |

### 8.2 一条计划外的发现：16:9 会静默裁切文字

计划把横屏排版列为「D2 唯一有真实设计风险的一点」。实测坐实了，而且比预期严重。

在 `:3000` 用 paper 主题二分逼近实际裁切点（量的是 `scrollHeight - clientHeight`，不是估算）：

| role | 基准容量（360/240/260 × paper 1.05） | 实测裁切字数 | 隐含倍数 |
| --- | --- | --- | --- |
| intro | 252 | 119 | 0.47 |
| content | 378 | 146 | 0.39 |
| outro | 273 | 103 | **0.38** |

而当时 `platformCapacityScale.presentation = 1`，意味着要到 378 字才告警——**146 字就已经裁掉末行、序号压在标题上、箭头盖住正文，全程一声不吭**。`tests/visual/export-matrix.spec.ts` 同时独立复现：6 个主题全部 `TEXT_OVERFLOW`（浏览器实测，不是启发式）。

**第一版修法是错的，记下来防止再来一次**：把容量刻度调到 0.37 躲开。那是治标。病根在 `src/render/slide.css` 的全部 78 处尺寸都用 `cqw`——按容器**宽度**定标。竖版宽度是短边，没问题；横屏宽度变成长边，同一个 `cqw` 在竖向上被放大 `(1080/1350) ÷ (1080/1920) ≈ 2.2` 倍。

**真正的修法**（计划里写的「先按短边定标」）：`src/render/slide.tsx` 新增 `densityFor(width, height)` → `--slide-density`，字号与竖向节奏统一乘它。关键性质是**宽 ≤ 高时恒等于 1**，所以 linkedin / instagram / tiktok / square 的计算值一个像素都没变，这条改动对已发货画幅不可能回归；只有 16:9 拿到 0.45。`tests/ui/slide-density.test.tsx` 守住这个边界，并且遍历 `platformKeys`，以后加画幅会自动纳入检查。

修完复测，同一段 225 字正文在 16:9 上排得干净，三种 role 到 443 字（语料上限）都不裁切。于是容量刻度**调回 1** —— 这次的 1 是量出来的，不是沿用的。`square` 实测裁切点 intro 382 / content 425 / outro 345，最紧隐含倍数 1.12，保留 0.8（比实测保守约三成，宁可早报）。

### 8.3 验证

```
pnpm typecheck                                         exit 0
pnpm test                                              52 files / 404 passed | 7 skipped（基线 389）
node scripts/check-planning.mjs                        15 unchanged design files
pnpm exec playwright test tests/visual/export-matrix.spec.ts   8 passed (1.1m)
pnpm exec playwright test tests/e2e/full-product.spec.ts       31 passed / 27 skipped (13.8s)
```

`export-matrix` 新基线 **约 64 秒**（平台 3 → 5，矩阵按计划预计的量级变大）。修复前同一条命令是 6 failed / 2 passed。

本节全部为本地渲染与静态校验，**花费 $0.00**。

### 8.4 迁移已推（2026-09-16，经你授权）

`supabase/migrations/20260915010000_platform_presets_square_presentation.sql` 已 push 到**开发**项目 `ettuzeunkadkfnawawdy`：

```
$ supabase db push --linked
Applying migration 20260915010000_platform_presets_square_presentation.sql...
{"upToDate":false,"migrations":["20260915010000_platform_presets_square_presentation.sql"],"seeds":[],"roles":[]}

$ supabase db push --linked --dry-run
{"upToDate":true,"migrations":[],"seeds":[],"roles":[],"message":"Remote database is up to date."}
```

用 service key 脚本实测枚举（带一个反例做对照，证明这个检查不是恒真）：

```
linkedin                    -> accepted by enum
square                      -> accepted by enum
presentation                -> accepted by enum
definitely-not-a-platform   -> 22P02: invalid input value for enum platform_preset
```

至此新画幅可用于云端项目，不再限于本地草稿。

---

## 9. Phase D3：模板 3 → 14 与分类导航（G3）

### 9.1 供给：`content/templates.json` 3 → 14

7 个分类各 2 套，**5 种画幅与 6 种配色全部覆盖**（由单测断言，不是人工数的）。原有 3 套逐字未动。新增 11 套：`modern-brief` / `modern-metrics` / `minimal-note` / `minimal-quote` / `bold-statement` / `bold-hot-take` / `playful-checklist` / `playful-myths` / `education-breakdown` / `launch-changelog` / `story-lessons`，全部 text 模式、每套 4–5 页。

### 9.2 新增的闸：`tests/unit/templates-content.test.ts`（37 条）

手写 JSON 没有任何类型约束，写错了页面照常构建，只有用户点进去才发现。这组测试断言：每套都能过 `parseCarouselDocument`；每套 `previewAppearance` 的 `conflicts` **为空**（不能把警告当作模板发给用户）；slug 唯一且 url-safe；platform / templateId 在发货常量内且覆盖齐全；category 在 `CATEGORY_ORDER` 内且每个分类都有模板；每个分类都有词条。

**它当场抓到一个真错**：`playful-checklist` 的 bullet 块带了 `emphasisRanges` 字段，而 `bulletBlockSchema` 是 `.strict()` 且没有这个字段——解析直接抛错。这正是加这道闸的理由，已修。

### 9.3 画廊：`src/app/[locale]/templates/page.tsx` + `src/features/templates/template-gallery.tsx`

扁平网格 → 顶部分类筛选 + 按分类分组。`data-testid="template-list"` 保留。服务端只把 6 个展示字段送过客户端边界，14 套完整 `CarouselDocument` 不进首屏 payload。分类名走词条（`categoryModern` 等，两份 catalog 各 7 条）——**刻意用扁平 key 而不是嵌套对象**：`tests/helpers/intl-server.ts` 把 catalog 类型写成 `Record<string, Record<string, string>>`，嵌套会让 `pnpm typecheck` 直接红。

### 9.4 验证

```
pnpm typecheck                     exit 0
pnpm test                          53 files / 441 passed / 7 skipped（较 D2 的 404 增 37 条）
node scripts/check-planning.mjs    PASS，15 unchanged design files
playwright tests/e2e/templates.spec.ts        4 passed（含新增的筛选用例）
playwright tests/e2e/seo|full-product         全绿
playwright tests/e2e/accessibility.spec.ts    17 passed / 1 skipped（三引擎）
```

14 条 `/templates/<slug>` 明细页 + `/templates` 与 `/zh-Hans/templates` 逐条 curl **全部 200**；sitemap 中 `templates/` 条目随之增加；zh-Hans 页面实测渲染出中文分类名。本节 `$0.00`，无模型调用。

### 9.5 顺手修掉的一处**既有**红灯（不是本轮引入的）

`tests/e2e/accessibility.spec.ts` 的两条用例在三个引擎上共 6 个失败：`getByLabel("Language", { exact: true })` 找不到元素。原因是该 `<label>` 包住了 `<select>`，label 的纯文本连着选项文字（`"LanguageEnglishSimplified Chinese"`），精确匹配对不上。**已验证与 D1/D2/D3 无关**：把 `options.tsx` 与 `messages/en.json` 临时 stash 回 HEAD 后失败完全一致。

该 spec 自己的注释（第 102–104 行）早就写明了这个坑，并已把 Platform / Template / Content format 三个下拉改成按可访问名断言——**只是漏了 Language**。按同样的办法补齐两处即可，产品标记本身没有问题（包裹式 label 是合法的可访问名来源）。

### 9.6 本节的已知短板

模板的 `name` 与 `description` 存在 JSON 里，只有英文；`/zh-Hans/templates` 上分类名是中文、模板名和简介仍是英文。原有 3 套也是如此，不是回归，但扩到 14 套之后更显眼。要修就得把 templates.json 做成双语结构，属于内容工程，不在 D3 范围内。

---

## 10. Phase D4：生成前先挑模板 + 首次进编辑器的三步引导（G4）

### 10.1 模板选择器（`src/features/templates/template-picker.tsx`）

`/create` 在「选来源」之前多了一步「先挑一套模板起步」，复用 D3 的分类数据，没有新建第二套目录。

选中一套模板**只做一件事**：把它的配色（`templateId`）与画幅（`platform`）灌进下面的生成选项。刻意不做成「套用整份文档」——生成会把 slides 整体替换掉，套进去的正文一行都留不下，那种交互只会让人误以为自己选的是结果。

选中态是**算出来的，不是记下来的**：当且仅当「当前选项 == 这套模板的配色 + 画幅」时才高亮。用户回头把画幅改掉，高亮自己消失——继续显示一个已经不成立的选择，比不显示更糟。这条有单测（`tests/ui/template-picker.test.tsx`）和 e2e（`tests/e2e/onboarding.spec.ts`）各守一遍。

### 10.2 一处刻意的结构改动：`/create` 从整页 client 拆成服务端外壳 + 客户端工作区

选择器要 14 套模板的元数据，而 `content/templates.json` 里是 14 份**完整的** `CarouselDocument`。整页 `use client` 会把这份 JSON 原样打进客户端包，只为读 6 个字段。

所以新增 `src/features/templates/catalog.ts` 只导出卡片需要的 6 个字段，`/create` 改成服务端组件 + `CreateWorkspace` 客户端子树。`tests/ui/shell.test.tsx` 断言渲染出的 markup 里 **不含** `bodyBlocks` / `layoutId`，把这件事钉住，防止以后有人随手把 `templates.json` 再拖回客户端。

### 10.3 引导（`src/features/editor/onboarding.tsx`）

三步：左侧写字 → 右侧调样式 → 然后导出（最后一步才给 `/exports` 的入口，前两步给它只会把人从编辑器里引走）。

状态只进 localStorage，**不进服务端**：换台机器再看一次引导的代价，远小于为此加一列、加一条迁移、加一次 CAS 往返。初始 `open` 恒为 `false`，读 localStorage 放在 effect 里——既没有 hydration 不一致，也不会「闪一下又消失」。隐私模式下 `localStorage` 取值会抛错，这里吞掉当作「已看过」：引导看不到可以接受，把编辑器整页打崩不行（`tests/ui/onboarding.test.tsx` 第三条守这个）。

### 10.4 验证（2026-09-16）

```
pnpm typecheck                  → exit 0
pnpm test                       → 55 files / 448 passed | 7 skipped（D3 基线 53/441，本节 +2 文件 +7 条）
node scripts/check-planning.mjs → PASS ... 15 unchanged design files
```

`:3000` 逐条（状态码 / 字节数）：

```
200  87343  /create          200  87504  /zh-Hans/create
200  90522  /editor/local-smoke   200  90790  /zh-Hans/editor/local-smoke
200  79199  /templates
```

Playwright：新增 `tests/e2e/onboarding.spec.ts` 2 条（chromium）全绿——挑 Modern Metrics 后 Platform 真的变成 `presentation`、Template 变成 `signal`，手动改回 `linkedin` 后 `aria-pressed` 自己变 `false`；引导走完三步后消失，reload 之后不再出现且画布照常可见。

回归面（引导现在渲染在 `.editor-workbench` **上方**，是本节风险最高的一处）：`editor` / `accessibility` / `full-product` / `text-generation` / `templates` 五个 spec 三引擎共 **54 passed / 30 skipped**，无一条因引导面板改变 tab 顺序或挡住首个断言而失败。

### 10.5 又一处**既有**红灯（不是本轮引入的）

`tests/e2e/text-generation.spec.ts:22` 的 `getByLabel("Language")` 严格模式冲突：同时命中外壳里的「Interface language」与生成选项里那个包住 `<select>` 的 label。`WorkspaceShell` 从 D4 之前就在 `/create` 上（`git show HEAD:src/app/[locale]/create/page.tsx` 可见），与本轮改动无关；且它期望的 `"English"` 也不是 option 的 `value`（应为 `"en"`）。按 §9.5 同一手法改成 `getByRole("combobox", { name, exact: true })` 并修正期望值，现已绿。

---

## 11. Phase D5：博客架构（G1，只做架构不做量）

### 11.1 改了什么

`src/server/content.ts` 的 `ContentKind` 加 `"blog"`，`CATALOG` 加三行。**没有第二套内容系统**：博客与 guide 共用同一套 `parseTrustedMarkdown` / `rejectExecutableMarkup` / 双语镜像目录规则，唯一区别是它多一个列表页、并且会随文章增加而变长。

新增两条页面路由：

- `src/app/[locale]/blog/page.tsx` —— 列表。标题与摘要只存在文章 frontmatter 里，所以逐篇 `readContent`。种子只有 3 篇，等文章多到这里成为瓶颈再抽索引层。
- `src/app/[locale]/blog/[slug]/page.tsx` —— 详情，照 `guides/[slug]` 的写法。缺中文文件时按 404 处理而**不回落英文**（中文站挂着英文正文比 404 更难被发现）。

两页用 `PublicHeader` / `PublicFooter` 而不是 `WorkspaceShell`——它是获客面，读者多半还没登录。`Nav.blog` 进页脚。`src/app/sitemap.ts` 加 `/blog` 与 `listContent("blog")`，两种语言各一行并互相声明 hreflang。

种子 3 篇（英文 + 中文镜像，共 6 个文件）：`carousel-hook-first-slide`、`one-idea-per-slide`、`choosing-a-canvas-size`。

### 11.2 验证（2026-09-16）

```
pnpm typecheck                  → exit 0
pnpm test                       → 55 files / 451 passed | 7 skipped（D4 基线 448，+3 条来自
                                   content-locales 的 it.each 自动吃下三篇新文章）
node scripts/check-planning.mjs → PASS ... 15 unchanged design files
```

**没有为博客新写测试，因为已有的闸自动覆盖了它**：`tests/unit/content-locales.test.ts` 由 `listContentEntries()` 驱动，加进 CATALOG 就自动要求「两种语言都有文件、都解析得过、标题与摘要不能还是英文原文」。这正是它当初设计成数据驱动的意义。

`:3000` 逐条：

```
200  59545  /blog                200  59458  /zh-Hans/blog
200  62117  /blog/one-idea-per-slide          200  62133  /zh-Hans/blog/one-idea-per-slide
200  61749  /blog/choosing-a-canvas-size      200  61521  /zh-Hans/blog/choosing-a-canvas-size
200  61788  /blog/carousel-hook-first-slide   200  61755  /zh-Hans/blog/carousel-hook-first-slide
404  54175  /blog/nope        ← 真 404，且是 A1 的品牌外壳（54 KB），不是 Next 原生页
```

`sitemap.xml` 实测含 `/blog` 与三篇文章，每条都带 en / zh-Hans / x-default 三个 hreflang。

`tests/e2e/full-product.spec.ts` 的路由表加了 `/blog` 与一篇文章；带真实账号重跑（`ORINCARD_RUN_FULL_PRODUCT_E2E=1`，凭据只在子 shell 里加载）：**62 passed**（匿名 33 + 登录态 29，D4 时的基线是 31 + 27）。

### 11.3 本节的边界

按已确认的 G1 口径「只做架构不做量」：本轮只放 3 篇种子证明链路通。批量写作（40+ 工具页、SEO 文章矩阵）单独排期，架构已经一次到位——之后只需往 `content/blog/` 与 `content/zh-Hans/blog/` 丢文件并在 `CATALOG` 加一行。本轮**不加** blog 的 API，`tests/contracts/api-coverage.test.ts` 的 50 不动。

---

## 12. Phase C：编辑器助手（T096–T099，AC-012）

完整记录在 **`docs/acceptance/assistant.md`**（实测花费、逐条用例、两个真缺陷、一条未收口的记账缺口）。这里只留发布巡检需要知道的四件事。

**1. 四个任务的结论**：T096 两屏原型已人工过图；T097 对话轮 + 计费 9 个单测全绿并有真实 RPC 实测；T098 面板 5 个 UI 单测全绿并在浏览器里走通；T099 三条真实浏览器用例全绿（提问→diff→确认→revision 2；过期 `expectedRevision` → 409 且项目行逐列未变；额度耗尽 → 429 且无 revision、无对话轮、无悬空预留）。

**2. 一条只有真跑才能发现的存量缺陷**：`private.b04_begin_ai_candidate_job` 里局部变量与 `private.cost_budgets.period` 同名，`42702 column reference "period" is ambiguous`，导致**所有走这条函数的同步 AI 预留每一次都异常**——rewrite 候选、regenerate 候选、copilot 对话轮，统统表现为 503。修在 `supabase/migrations/20260916000300_b04_begin_period_ambiguity.sql`（变量改名 `period_key`，账目语义未动），已推到开发项目。这意味着**本轮之前，rewrite 与 regenerate 这两条早就"验收过"的链路在真实环境里其实是坏的**；它们的单测用的是假 store，SQL 从没在测试里执行过。

**3. 一条未收口的记账缺口**：25,000 µUSD 的保守预留以 `unknown` 挂账不释放，实测的几百 µUSD 进不了预算表。根因是结算与收尾的调用顺序，修已提交（`settleUsage` 钩子 + 两条顺序单测），❌ **端到端未复验**——开发测试账号当期 generation 额度已耗尽，加额度的写操作被权限拦下。详见 `assistant.md` §5。

**4. 路由计数**：新增 `GET/POST /api/v1/copilot`，`tests/contracts/api-coverage.test.ts` 的硬编码计数从 50 抬到 51（这是 Phase C 唯一动这个数字的地方，D1–D5 全程不动）。

`:3000` 上助手面板只在**云端项目**的编辑器里出现；本地草稿（`local-generated-*`）不挂它，因为提议要落成一条真实的 rewrite 候选，没有项目行就无处可落。

---

## 13. 本轮仍未验的

- **D1 的真实出图**：❌ 见 §7，卡在本机到 `api.apimart.ai` 的网络出口。
- **助手的成本预留结算顺序修复**：❌ 见 §12.3，缺额度与权限。
- **横屏的专属排版**：`--slide-density` 让 16:9 能用且不裁切，但 17 个 layout 仍是按竖版设计的（横屏只是整体缩小）。多栏／横向构图是设计任务，不在本轮范围。
- **模板文案的中文镜像**：见 §9.6。引导与选择器自身的文案是双语的，模板名仍是英文。
- **P2 运维发布**（T073、T084–T089）本轮明确不碰。
