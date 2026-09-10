# T088 许可与安全发布检查

## 已实现行为

`tests/cloud/release-guards.test.ts` 把发布前的许可与安全条件写成四组阻塞式断言。它读仓库当前状态与运行环境变量的**存在性**，不连接任何云服务，不读取也不打印任何凭据值——唯一两处触碰变量内容的地方是 `STRIPE_TEST_SECRET_KEY` 的 `sk_test_` 前缀判定与 `STRIPE_TEST_MONTHLY_PRICES_JSON` 是否含 `price_`，两者都只把布尔结果写进断言消息。

该文件位于 `tests/cloud/` 下，而 `pnpm test` 使用 `vitest run --exclude 'tests/cloud/**'`，因此它**不计入本地回归的用例数**，必须按下一节的命令单独运行。

| 守卫 | 断言的已实现行为 |
|---|---|
| 1 未知许可 | 用 `git ls-files` 枚举随仓库分发的素材：字体/图片/音视频/PDF/PPTX/压缩包等二进制扩展名，加上 `content/templates.json`、`tests/fixtures/*.json`、`docs/design/reference/**` 的 html/css/js/json。每个文件必须在 `docs/licenses/assets.md` 第 1 节有一行；缺行失败，许可列或证据列写着未知（含空、`-`、`TBD`、`未知`）失败，清单里列了已不存在的文件也失败。第 2 节与 `src/render/font-manifest.json` 的字体 `id` 集合双向比对。第 3 节与 `tests/fixtures/rights.json` 做双向集合比较并逐条比对 `license` 与 `redistribution`，任一不一致失败；第 1 节引用的 rightsId 必须在 `rights.json` 里定义；`tests/fixtures/corpus.json` 每条样本的 `rightsId` 也必须在 `rights.json` 里定义 |
| 2 模型资格 | 从 `src/**/*.ts` 抽取实际写死的模型标识——`model:` / `resourceId:` 字面量、`AI_*_MODEL` 常量、`process.env.AI_*_MODEL ?? "…"` 的兜底值——与 `docs/licenses/assets.md` 第 4 节双向比对。出现未登记模型失败；登记了代码已不再调用的模型失败；登记行缺用途、商用资格或数据留存说明失败。另有一条防空转断言：抽取结果为空即失败，避免正则失效后守卫 2 空跑通过 |
| 3 支付政策 | `src/**` 里读到的每个 `STRIPE_*` 变量（含 `readStripeBillingConfig` 按 `${prefix}_` 拼出的那批）必须在 `.env.example` 有文档条目；`STRIPE_TEST_SECRET_KEY`、`STRIPE_TEST_MONTHLY_PRICES_JSON`、`STRIPE_TEST_ACCEPTANCE_PLAN_KEY`、`STRIPE_WEBHOOK_SECRET`、`NEXT_PUBLIC_APP_URL`、`RUN_STRIPE_SANDBOX_LIFECYCLE` 必须已配置；密钥必须是 `sk_test_` 前缀且 `STRIPE_LIVE_SECRET_KEY` 必须不存在；`content/legal/` 三份政策的 `publicationStatus` 必须为 `approved`，且 terms 需覆盖 subscription / cancellation / refund |
| 4 待发布内容扫描 | 除 `.env.example` 外不得有任何 `.env*` 被 Git 跟踪；文本类文件不得命中凭据形状（`sk_live_`/`sk_test_` 后接 16 位以上、`eyJhbGciOi` 开头的 JWT、PEM 私钥块、已命名密钥变量的非空赋值），命中时只报文件名与形状类别，不回显匹配文本；`tests/fixtures/corpus.json` 里长度 ≥24 的内联正文不得出现在 `tests/fixtures/` 之外的任何跟踪文件里；第 1 节中许可或证据为未知的素材不得存在于仓库 |

守卫 3 需要的变量由运行者在自己的终端配置。缺变量时用例**显式失败并点名缺哪一个**，不会 skip 后当作通过；本文件与测试都不读取 `.env.local`。

守卫 2 读的是代码，读不到运行环境：`AI_TEXT_MODEL` 与 `AI_TRANSCRIBE_MODEL` 若在部署环境里被覆盖成未登记的模型，本守卫拦不住。发布前需人工核对部署环境的这两个变量与 `docs/licenses/assets.md` 第 4 节一致。

Supabase Auth 的**泄露密码保护仍未开启，项目 advisor 存在 1 项 WARN**。本批次没有改动该项，验收记录保留这 1 项 WARN，不写成 0 项。

**T087（备份与隔离恢复）未闭合前，T088 不勾选。** T087 的 `Expect` 要求一次真实的隔离恢复演练，目前只有本地断言，因此 T088 即便自身守卫全绿也不具备勾选条件。

## 验收命令

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/www.macpe.cn/Documents/ChatGPT/Orincard-walking-skeleton
pnpm exec vitest run tests/cloud/release-guards.test.ts
```

守卫 3 需要在同一 shell 里先行配置（值由运行者自己持有，不粘贴、不入库、不写进本文件）：

```sh
export STRIPE_TEST_SECRET_KEY=…          # 必须 sk_test_ 前缀
export STRIPE_TEST_MONTHLY_PRICES_JSON=… # 必须含 price_ id
export STRIPE_TEST_ACCEPTANCE_PLAN_KEY=…
export STRIPE_WEBHOOK_SECRET=…
export NEXT_PUBLIC_APP_URL=…
export RUN_STRIPE_SANDBOX_LIFECYCLE=1
```

本地回归门禁（不含本文件，`--exclude 'tests/cloud/**'`）：

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
pnpm typecheck && pnpm test
```

## 验收结论（协调线，2026-09-11）— Blocked

```
pnpm exec vitest run tests/cloud/release-guards.test.ts
Tests  6 failed | 13 passed (19)
```

**这 6 条失败全部是设计内的发布阻断，不是代码缺陷。** 它们需要运维/账号侧动作才能解除，因此 **T088 保持未勾选**，不因为"本地测试绿了"而补勾。

### 守卫 1 — 未知许可（1 条阻断）

```
docs/design/reference/assets/img/avatar-elena.jpg → 许可「未知」/ 证据「无」
```

守卫 4 的「无许可素材不得随发布提交」同一根因再报一次（合计 2 条失败，1 个根因）。两条闭合路径已写在 `docs/licenses/assets.md`：补齐可核对的许可与来源证据，或从仓库移除该文件并撤下清单行。**未擅自删除该文件**——它属于设计参考资产，去留由你决定。

其余许可检查全绿：`src/render/font-manifest.json` 声明的字体逐一登记；清单与 `tests/fixtures/rights.json` 双向一致；语料只引用 `rights.json` 真实定义的 rights id；无陈旧清单行。

### 守卫 2 — 模型资格（全绿）

源码真实调用的模型逐一登记了用途与商用资格，无未登记模型，也无代码已停用却仍留在清单里的行。

### 守卫 3 — 支付配置与政策（4 条阻断）

| 失败 | 内容 |
|---|---|
| `.env.example` 未记录 | `src/` 读取但 `.env.example` 未记录的 4 个变量：`STRIPE_TEST_SECRET_KEY`、`STRIPE_TEST_MONTHLY_PRICES_JSON`、`STRIPE_TEST_YEARLY_PRICES_JSON`、`STRIPE_TEST_PROMOTION_CODES_JSON` |
| 测试环境未配置 | 同上 4 个变量在运行者 shell 中缺失 |
| 非测试态密钥 | `STRIPE_TEST_SECRET_KEY` 缺失或非 `sk_test_` 前缀（**值全程未打印**） |
| 政策文案未审定 | `content/legal/terms.mdx` 的 `publicationStatus` 仍为 `draft`，审定态是发布前置条件 |

前三条与 T073 / T084 的阻塞同源：Stripe 测试环境按你的决定暂不配置。**这就是正确结果，不放宽这条守卫。** 第 4 条只需把条款文案改为 `approved`，属于内容审定动作。

`.env.example` 那条是唯一一条可以立刻闭合的：补 4 行变量说明即可（只写变量名与用途，不写值）。本轮未改，如实记录。

订阅、取消、退款三项条款覆盖检查本身通过。

### 守卫 4 — 发布内容扫描（1 条阻断，与守卫 1 同源）

未跟踪除 `.env.example` 以外的环境文件；未提交任何形似密钥的字面量；`tests/fixtures` 之外未提交语料正文。唯一失败是上面那张头像。

### 依赖阻塞

`Depends: T087` 仍未闭合（备份与隔离恢复演练需另建隔离 Supabase 项目）。**即使上述 6 条全部解除，T087 闭合前 T088 仍不勾选。**

### 环境安全现状（如实保留）

Supabase Auth 的泄露密码保护**仍未开启**，开发项目存在 **1 项 WARN**。不写成 0 项。

### 结论

T088 的三条阻断检查真实生效并真实拦下了当前发布，**T088 记为 Blocked，保持未勾选。**
