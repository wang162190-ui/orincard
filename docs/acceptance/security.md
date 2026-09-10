# T088 许可与安全发布检查

## 已实现行为

`tests/cloud/release-guards.test.ts` 把发布前的许可与安全条件写成四组阻塞式断言。它读仓库当前状态与运行环境变量的**存在性**，不连接任何云服务，不读取也不打印任何凭据值——唯一两处触碰变量内容的地方是 `STRIPE_TEST_SECRET_KEY` 的 `sk_test_` 前缀判定与 `STRIPE_TEST_MONTHLY_PRICES_JSON` 是否含 `price_`，两者都只把布尔结果写进断言消息。

该文件位于 `tests/cloud/` 下，而 `pnpm test` 使用 `vitest run --exclude 'tests/cloud/**'`，因此它**不计入本地回归的用例数**，必须按下一节的命令单独运行。

| 守卫 | 断言的已实现行为 |
|---|---|
| 1 未知许可 | 用 `git ls-files` 枚举随仓库分发的素材：字体/图片/音视频/PDF/PPTX/压缩包等二进制扩展名，加上 `content/templates.json`、`tests/fixtures/*.json`、`docs/design/reference/**` 的 html/css/js/json。每个文件必须在 `docs/licenses/assets.md` 第 1 节有一行；缺行失败，许可列或证据列写着未知（含空、`-`、`TBD`、`未知`）失败，清单里列了已不存在的文件也失败。第 2 节与 `src/render/font-manifest.json` 的字体 `id` 集合双向比对。第 3 节与 `tests/fixtures/rights.json` 做双向集合比较并逐条比对 `license` 与 `redistribution`，任一不一致失败；第 1 节引用的 rightsId 必须在 `rights.json` 里定义；`tests/fixtures/corpus.json` 每条样本的 `rightsId` 也必须在 `rights.json` 里定义 |
| 2 模型资格 | 从 `src/**/*.ts` 抽取实际写死的模型标识——`model:` / `resourceId:` 字面量、`AI_*_MODEL` 常量、`process.env.AI_*_MODEL ?? "…"` 的兜底值——与 `docs/licenses/assets.md` 第 4 节双向比对。出现未登记模型失败；登记了代码已不再调用的模型失败；登记行缺用途、商用资格或数据留存说明失败。另有一条防空转断言：抽取结果为空即失败，避免正则失效后守卫 2 空跑通过 |
| 3 支付姿态 | 见下节。守卫按环境实际配置在两种姿态间切换，两条分支都断言，没有 skip |
| 4 待发布内容扫描 | 除 `.env.example` 外不得有任何 `.env*` 被 Git 跟踪；文本类文件不得命中凭据形状（`sk_live_`/`sk_test_` 后接 16 位以上、`eyJhbGciOi` 开头的 JWT、PEM 私钥块、已命名密钥变量的非空赋值），命中时只报文件名与形状类别，不回显匹配文本；`tests/fixtures/corpus.json` 里长度 ≥24 的内联正文不得出现在 `tests/fixtures/` 之外的任何跟踪文件里；第 1 节中许可或证据为未知的素材不得存在于仓库 |

### 支付姿态

发布姿态：no-payment

本次发布不接入 Stripe，付费入口以 joinlist（waitlist）形态呈现。守卫 3 读取环境变量的存在性来判定姿态：`STRIPE_TEST_SECRET_KEY`、`STRIPE_LIVE_SECRET_KEY`、`STRIPE_SECRET_KEY` 任一非空，或 `RUN_STRIPE_SANDBOX_LIFECYCLE=1`，即为 `payment-enabled`，否则为 `no-payment`。**上面这行「发布姿态：」必须与环境判定一致，不一致即失败**——有人配上 Stripe 却没改本文档，或改了本文档却没配，都会被拦住。

`no-payment` 姿态下断言的是「收费路径确实不可达、且没有对外承诺」：

- `readStripeBillingConfig(process.env)` 必须抛 `BILLING_NOT_CONFIGURED`；
- 直接调用真实的 `createCheckoutHandler`（空环境、认证回调设为「一旦被调用就报错」）必须返回 `503` 且错误码为 `BILLING_NOT_CONFIGURED`，即在认证之前就拒绝；
- `STRIPE_WEBHOOK_SECRET` 与三个 Price/Promotion 映射、`STRIPE_TEST_ACCEPTANCE_PLAN_KEY` 必须全部未配置——只报变量名，不读值；
- `content/legal/` 三份政策必须仍是 `draft`（此姿态下 draft 才是正确状态，被冒然改成 `approved` 反而失败）；
- `src/app/pricing/page.tsx` 不得出现任何金额字面量（`$12`、`12/mo`、`12 USD` 之类）；
- `src/features/billing/upgrade-dialog.tsx` 的文案必须与其行为一致：它当前不发起任何网络请求，因此必须明说邮箱未被提交或存储；一旦它开始提交，`content/legal/privacy.mdx` 必须先覆盖 waitlist 邮箱的处理。

`payment-enabled` 姿态下自动重新武装原来的严格集合：六个变量齐备、密钥为 `sk_test_` 前缀、`STRIPE_LIVE_SECRET_KEY` 不存在、Price 映射含 `price_`、`src/**` 读到的每个 `STRIPE_*` 都在 `.env.example` 有条目、三份政策为 `approved` 且 terms 覆盖 subscription / cancellation / refund。**接 Stripe 时不需要改守卫，配上变量它自己就变严。**

已知未闭合项，留给接 Stripe 的那一轮：`.env.example` 文档化的是 `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET`，而 `readStripeBillingConfig` 实际读 `STRIPE_TEST_SECRET_KEY`、`STRIPE_TEST_MONTHLY_PRICES_JSON`、`STRIPE_TEST_YEARLY_PRICES_JSON`、`STRIPE_TEST_PROMOTION_CODES_JSON`，这四个变量在 `.env.example` 里没有条目；`src/trigger/reconcile-billing.ts` 读的仍是不带 `TEST` 前缀的 `STRIPE_SECRET_KEY`，与 checkout 路径不一致。另有 `.env.example` 里的 `BILLING_LIVE_ENABLED` 与 `AFFILIATE_PAYOUTS_ENABLED` 全仓库无任何代码读取，是两个失效的开关，不构成保险。本批次未修，因为这些文件不在 T088 允许改动的清单内。

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

`no-payment` 姿态不需要任何 Stripe 变量，上面这条命令直接跑即可。将来接 Stripe 时，在同一 shell 里配好下列变量（值由运行者自己持有，不粘贴、不入库、不写进本文件），并把本文档的「发布姿态：」改为 `payment-enabled`：

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
