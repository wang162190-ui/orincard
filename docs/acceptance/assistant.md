# 编辑器助手验收记录（AC-012 / T096–T099）

状态：**T096 `PASS`（人工过图）；T097 `PASS`（9 个单测 + 真实 RPC 实测）；T098 `PASS`（5 个 UI 单测 + 浏览器实测）；T099 `PASS`（三条真实浏览器用例全绿）。成本记账 `PARTIAL`：每轮实测花费已精确记进 `private.cost_attempts`，但 25,000 µUSD 的预算预留在修复前一直以 `unknown` 挂账不释放——修已提交，见 §5，❌ 未能端到端复验（开发账号当期 generation 额度已耗尽，加额度被权限拦下）。**

记录日期：2026-09-16。全部在本机 `next dev`（`:3000`）上执行，Supabase 用**开发**项目（`ettuzeunkadkfnawawdy`），未触碰生产项目。

---

## 1. 这条链路是什么形状

一轮对话 = **两个任务**，不是两次模型调用：

| 任务 | kind | 预留 | attempt key |
|---|---|---|---|
| 对话轮 | `copilot`（新枚举值） | 1 generation 单位 + 25,000 µUSD | `job:<id>:copilot:1` |
| 提议候选（仅当这一轮真的带改动） | `rewrite` | 1 generation 单位 + 25,000 µUSD | `job:<id>:candidate:1` |

候选复用 rewrite 是刻意的：`server_apply_rewrite_proposal` 硬性要求 `jobs.kind = 'rewrite'`，而 AC-012 要求确认动作打到**既有**的 `/api/v1/projects/[id]/apply-proposal`，不新开写入口。代价是**一轮带改动的对话扣 2 个 generation 单位**；换来的是 apply 与 CAS 冲突路径一行没动。候选那一侧不发生第二次模型调用（`precomputedAfter` 直接用助手已经生成的文本）。

---

## 2. T099：三条真实用例

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
( set -a; . ./.env.local; set +a;
  ORINCARD_RUN_ASSISTANT_E2E=1 PLAYWRIGHT_BASE_URL="http://localhost:3000" \
  pnpm exec playwright test tests/e2e/assistant.spec.ts )
```

`PLAYWRIGHT_BASE_URL` 必须是 **`localhost`** 而不是配置里默认的 `127.0.0.1`：写入路由按 `APP_URL` 校验 `Origin`，两者字面量不同就一律 `INVALID_REQUEST — This write request did not come from the configured application origin.`。第一次跑就撞在这里。

| 用例 | 断言 | 结果 |
|---|---|---|
| 提问 → 看 diff → 确认 → 新 revision | 面板初始无任何「应用」入口；提问后进 `data-phase="proposal"`，diff 的 before 侧必须是项目里真实的那句话；Accept 后 `data-phase="applied"`，**数据库里 revision 从 1 变 2**，且 Accept 按钮消失（同一条提议不能点第二次） | **通过** |
| 过期 `expectedRevision` → 409 | 带 `revision + 5` 去 apply，返回 409 `VERSION_CONFLICT`，且 `public.projects` 那一行**逐列**（含 `updated_at`）与冲突前完全相同 | **通过** |
| 额度耗尽 → 429 | 把当期 generation 桶的 `granted` 压到 `reserved + consumed`，这一轮返回 429 `QUOTA_EXCEEDED`、不产生 revision、`copilot_turns` 里一条都没有、`usage_accounts.reserved` 一动不动（无悬空预留）；`finally` 里把额度还回去 | **通过** |

耗时：前两条在同一次全量运行里 **1.6 分钟**；第三条单独重跑 **46.9 秒**（重写成「断言 reserved 增量」之后）。

第三条为什么不是「再问一轮看看还能不能问」：那取决于这个共享开发账号当月还剩多少额度，跑到月底就会以一个与本用例无关的理由变红。断言账上的数字才是稳的。

选桶的条件与 `private.b04_begin_ai_candidate_job` 逐字同义（`period_start <= now < period_end`，再 `order by period_start desc`）。第一版只写了 `period_end > now` 并按 `period_end desc` 排序，选中了另一只桶，于是「额度已按到零」是假的，用例拿到 200 而不是 429。

---

## 3. 实测花费

`server_sample_cost_attempts` 里 7 条 `job:<id>:copilot:1`，全部 `state='settled'`、`actual_micro_usd` 有真实数字：

| totalTokens（input / output / cached） | actual_micro_usd | ≈ USD |
|---|---|---|
| 820（604 / 216 / 256） | 663 | $0.00066 |
| 907 | 1,025 | $0.00103 |
| 1,147（603 / 544 / 256） | 1,312 | $0.00131 |
| 1,268 | 1,698 | $0.00170 |
| 1,371（612 / 759 / 0） | 1,907 | $0.00191 |
| 1,598（616 / 982 / 512） | 2,025 | $0.00203 |
| 1,639（612 / 1027 / 512） | 2,111 | $0.00211 |

即**每轮 $0.0007–$0.0021**。计划里参照工具链路估的是约 1,100 µUSD，上下文长的那几轮接近两倍——原因看得很清楚：输入稳定在 600 出头 token（整份文档的上下文），**变量在输出**（216 → 1,027 token），而输出费率是缓存命中输入的 90 倍。主动上报：这个量级仍远低于月度硬顶，7 轮合计约 $0.011。

`job:<id>:candidate:1`（提议候选）一律 `state='unknown'`、`actual_micro_usd=null`。这是**预期**的：`precomputedAfter` 意味着这一侧根本没有模型调用，没有用量可测，只能按保守口径收尾。

---

## 4. 两个真缺陷，只有真跑才能看见

### 4.1 `b04_begin_ai_candidate_job` 的 42702：所有同步 AI 预留一直在异常

第一次跑 T099 时助手一律 503，且**没有 job 行、没有 turn 行**——预留连插入都没走到。根因在 `20260907002243_b04.sql:358`：局部变量取名 `period`，而 `private.cost_budgets` 正好有一列也叫 `period`，`where private.cost_budgets.period = period` 右边那个 `period` 无法判定是变量还是列，PostgreSQL 抛 `42702 column reference "period" is ambiguous`。

影响范围不止助手：**rewrite 候选、regenerate 候选、copilot 对话轮，凡是走这条函数的同步 AI 预留，每一次都异常**，调用方统一当成服务不可用，于是表现为 503——不是「额度不足」也不是「预算不足」，账目本身没问题，是这一行根本执行不到。

单元测试看不见它：那一层用的是假 store，真正的 SQL 从来没有在测试里被执行过。**T099 是第一条真的把这条 RPC 跑起来的测试。**

修复：`supabase/migrations/20260916000300_b04_begin_period_ambiguity.sql`，变量改名 `period_key`（与同库其它函数一致），函数体其余部分与原迁移逐字相同，账目语义一个字没动。已 `supabase db push --linked` 推到开发项目。

### 4.2 上下文键名 `slideTitle` 让每一条改动都被静默丢掉

修完 4.1 之后，对话能答了，但界面上永远是「这一轮没有提议」。根因：`projectContext()` 把卡片标题的键名写成 `slideTitle`，模型如实照抄回 `field: "slideTitle"`，而 `createRewriteProposal` 的 `validField()` 只认 `title` / `eyebrow` / `cta` / `body:N`，抛错后被 `catch` 降级成 `proposal = null`——**用户看到助手答了「这是更精炼的标题」却没有任何可应用的改动**。

模型只会照抄它在上下文里看到的键名。修复是把上下文键名对齐 `RewriteField` 的取值（文档标题单独叫 `carouselTitle`，免得和卡片的 title 混名），并在指令里明说 `edit.field` 必须逐字抄自那张卡片。`tests/cloud/copilot.test.ts` 加了一条守键名的回归用例：解析真正交给 `generateStructured` 的 JSON，断言卡片里有 `title`、没有 `slideTitle`，且每个 body 块的 `field` 匹配 `^body:\d+$`。

---

## 5. 成本记账的缺口：预留结算成 `unknown` 而不是精确核销

这是本文件里唯一一条**没有完全收口**的事。

实测：跑完最后一轮验收，`server_read_cost_budget`（2026-09 / development）从 `{limit 10,000,000, spent 1,255,844, reserved 310,000}` 变成 `{… spent 1,255,844, reserved 410,000}`——**`spent` 一分没动，`reserved` 涨了 100,000 µUSD（4 个任务 × 25,000）**。`server_sample_cost_reservations` 里对应的行全是 `{state:"unknown", settled_micro_usd:0, released_micro_usd:0, reserved_micro_usd:25000}`。

也就是说：尝试行里躺着 663–2,111 µUSD 的真实数字（§3），预算表却按 25,000 µUSD 的保守口径把钱一直占着不放。方向是安全的（预算显得比实际更紧，不会超支），但它让预算表越用越假——照这个速率，每次完整验收吃掉预算 $0.10，而真实花费是 $0.005，差 20 倍。

**根因是调用顺序，不是 SQL。** `server_finalize_copilot_turn` 是「精确结算优先」的形状：先试 `private.finalize_job_reservation`，那条只在尝试行已经结算时才能精确核销，否则退回 `private.b04_finish_job_with_unknown_cost`。而路由把 `settleKeyedJobUsage` 放在 `runCopilotTurn` 的 `finally` 里——`store.finalize` 在 `runCopilotTurn` **内部**就已经跑完了。于是每一轮都是「先收尾、后记账」，精确核销永远拿不到数字。

修复（本文件记录时已提交）：

- `src/server/copilot.ts` 增加 `settleUsage` 钩子，在**两个** `finalize` 调用之前各跑一次（成功路径与供应商失败路径）。结算失败吞掉继续 finalize——预留没收尾比记账少一笔严重得多。
- `src/app/api/v1/copilot/route.ts` 把 `settle` 传进去，`finally` 里的那次保留为兜底并加了「只结算一次」的开关（同一个 attempt_key 结第二遍会撞唯一约束，虽然被吞掉，但每轮都会在日志里留一条假的 `[cost] settlement failed`）。
- `tests/cloud/copilot.test.ts` 加两条用例：断言调用顺序恒为 `settle → finalize`（成功与失败两条路径各一次），以及结算抛错时 finalize 照跑。

❌ **这个修复没有端到端复验。** 复验需要再跑一轮真实对话，而开发测试账号当期（2026-09）的 generation 桶已经是 `granted 20 / reserved 7 / consumed 13`，可用为 0；给它加额度的写操作被权限策略拦下了。要复验，请授权一次 `usage_accounts.granted` 的小幅上调（+6 足够：一轮带改动的对话吃 2 个单位），然后重跑 §2 的第一条用例，并确认该任务的 reservation 变成 `state='settled'`、`released_micro_usd = 25000 - actual`。

顺带记一笔**同一张表上的另一个现象**：那只桶的 `reserved` 是 7，而 `usage_ledger` 里每个任务既有 `reserve` 也有 `…:b04-final` 的 `settle` 行。这 7 个单位是历史遗留的悬空预留（交接 §4 已记为已知缺口，核销是一次显式的花钱决定，本轮按计划不顺手做），不是本轮新产生的。

---

## 6. 单测与其它闸

```sh
pnpm exec vitest run tests/cloud/copilot.test.ts tests/ui/assistant.test.tsx
```

- `tests/cloud/copilot.test.ts` **9 passed**：多轮 `reserved + spent ≤ limit` 恒成立且模型调用发生时预留已在账上；预算打满后下一轮被拒**且一个 token 都没烧**；重复 `Idempotency-Key` 重放不重复计费也不重复调模型；带改动的一轮是 1 次模型调用 + 2 个任务；上下文键名守卫（§4.2）；结算先于收尾（§5）；结算抛错时 finalize 照跑；候选建不出来时回答仍然保留；供应商失败也结算 + 超长问题在预留之前就被挡下。
- `tests/ui/assistant.test.tsx` **5 passed**：没问之前界面上不出现任何「应用」入口；面板明说「只读、不会替你写」；提议渲染成 before/after 且 Reject 排在 Accept 前面；两份词条 key 集合一致；冲突与失败文案都必须明说「什么都没有写入」，额度用尽的文案必须明说「模型没有被调用」（不能写「稍后重试」——模型根本没被调用，也没扣费）。
- `docs/design/prototype/assistant.html` 与 `assistant-conflict.html` 两屏已由你在 `:8080` 过图确认（2026-09-16）；`node scripts/check-planning.mjs` 仍报 15 unchanged design files。

---

## 7. 这条链路仍未验的

- §5 的结算顺序修复，端到端未复验（额度 + 权限）。
- 助手对 **Brand Kit 摘要**的利用只走了上下文，没有专门的验收用例。
- 一轮里模型提出**多处**改动的情况：schema 限定最多一处，未验证模型在被要求改多处时的退让行为。
- `GET /api/v1/copilot`（对话历史）只有契约测试覆盖，没有浏览器侧的多轮连续对话用例。
