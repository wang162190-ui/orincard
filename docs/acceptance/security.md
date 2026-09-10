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
