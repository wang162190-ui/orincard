# 交接：Phase A/B/D/C 已完成，下一棒从哪接

交接日期：2026-09-16。上一棒是 `docs/handoff/product-completion.md`（2026-09-15），本文接在它后面。
提交：`1dfff26 页面健壮性 + 全产品冒烟 + 转化补差 + 编辑器助手（Phase A/B/D/C）`，分支 `codex/walking-skeleton`，87 个文件。

本文里凡是写「实测」的，都是当天在**开发**环境真跑出来的；凡是没跑过的，写「未验证」或 ❌，不写「应该没问题」。

---

## 0. 不可协商的约束（先读这一节，违反了后面全白做）

- **不操作生产项目，只用开发项目**（Supabase `ettuzeunkadkfnawawdy`）。
- **不要用 Supabase MCP 操作本项目**——它指向的不是这个项目的数据库。要查库用 Supabase CLI 或 service key 脚本（脚本要放在仓库根目录下跑，`/tmp` 里 `node` 找不到 `@supabase/supabase-js`）。
- `.env.local` 可以读，但**只在子 shell 里加载**（`( set -a; . ./.env.local; set +a; … )`），**绝不打印值**。值不得进入聊天、日志、trace、截图或 Git。
- 花钱默认已批准，但 `AI_MONTHLY_BUDGET_USD=10` 的月度硬顶仍在。**实际花费必须如实上报，超支必须主动说。**
- **不要用 mock 假装某个功能能用。跑不通就说跑不通。**
- 所有命令先 `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`。
- 本机**没有 `timeout` 命令**，长命令用后台 + 看门狗。
- **把服务器留给用户，不要关**（2026-09-16 复核仍全部在跑）：`:3000` next dev 200、`:3100` 生产构建 200、`:8080` 原型静态服务 200、9 个 `supabase_*_orincard` 容器、`trigger dev` worker。
- **不要跑 `pnpm build`**（会覆盖 `:3100` 正在读的 `.next`）；`pnpm lint` 不存在。
- 不要改 `docs/design/reference/`（SHA-256 锁定，`check-planning.mjs` 必须一直报 15 unchanged design files）。
- 不改 `generateStructured` 签名，不去掉 `store:false`；不要把对话历史塞进 Trigger 载荷。
- **回滚不要用 `git checkout`**：本仓库长期有大量未提交产出，`checkout` 会把同一文件里别的活一起删掉（上一轮撤销 `Loading.*` 词条时真的发生过）。用 Edit 精确反向改。
- 路线图只在**真的跑通并验证过之后**才打 ✅，跑不通打 ❌ 并写一行原因。

---

## 1. 这一轮交付了什么

计划在 `~/.claude/plans/polymorphic-greeting-hearth.md`，按 A → B → D → C 执行，全部落地。

| 段 | 内容 | 验收记录 |
|---|---|---|
| A | 品牌化 404 + catch-all + `error.tsx` / `global-error.tsx` + 编辑器 404 | `docs/acceptance/release.md` §1–§5 |
| B | T095 全产品冒烟：共享登录 fixture + 匿名/登录态双遍路由表 | 同上 §6 |
| D | G5 配图额度、G2 两种真几何、G3 模板 3→14 + 分类、G4 模板选择 + 三步引导、G1 博客架构 | 同上 §7–§11 |
| C | T096–T099 编辑器助手（AC-012） | `docs/acceptance/assistant.md` |

`docs/sdd/orincard/tasks.md` 里 T096–T099 已勾 ✅ 并各写了 Result 行。102 个任务现在只剩 7 个未勾，全是 P2 运维（见 §5）。

### 助手这条链路的形状（接手前必须知道）

一轮对话 = **两个任务，一次模型调用**：

| 任务 | kind | 预留 | attempt key |
|---|---|---|---|
| 对话轮 | `copilot`（新枚举值） | 1 generation 单位 + 25,000 µUSD | `job:<id>:copilot:1` |
| 提议候选（仅当这一轮带改动） | `rewrite` | 1 generation 单位 + 25,000 µUSD | `job:<id>:candidate:1` |

候选复用 `rewrite` 是刻意的：`server_apply_rewrite_proposal` 硬性要求 `jobs.kind = 'rewrite'`，而 AC-012 要求确认动作打到**既有**的 `/api/v1/projects/[id]/apply-proposal`。候选那侧用 `precomputedAfter`，不再调第二次模型。代价是一轮带改动扣 2 个 generation 单位。

---

## 2. 当前绿灯基线（2026-09-16 实跑）

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
pnpm typecheck                    # exit 0
pnpm test                         # 56 files / 456 passed | 7 skipped
node scripts/check-planning.mjs   # 102 tasks / 51 API paths / 15 unchanged design files
pnpm exec vitest run tests/cloud/copilot.test.ts tests/ui/assistant.test.tsx   # 9 + 5 passed
```

注意：`pnpm test` **排除了 `tests/cloud/` 整个目录**（见 `package.json` 里的 `--exclude`），cloud 套件要单独跑，别以为 456 里包含它们。

花钱的 e2e 各有自己的开关，默认全跳过：`ORINCARD_RUN_ASSISTANT_E2E`、`ORINCARD_RUN_FULL_PRODUCT_E2E`、`ORINCARD_RUN_ASSETS_E2E`、`ORINCARD_RUN_B07_E2E`、`ORINCARD_RUN_BROWSERS_E2E`。

---

## 3. 第一优先级：一条已修但**未复验**的记账缺陷

这是本次交接里唯一需要你**立刻接手**的事。

**症状**：每轮助手对话预留 25,000 µUSD，实测只花 663–2,111 µUSD，但预算表里 `spent` 一分不动、`reserved` 一直涨。`server_sample_cost_reservations` 里对应行是 `{state:"unknown", settled_micro_usd:0, released_micro_usd:0, reserved_micro_usd:25000}`。方向是安全的（预算显得比实际紧，不会超支），但照这个速率一次完整验收吃掉预算 $0.10、真实花费 $0.005，差 20 倍。

**根因**：调用顺序。`server_finalize_copilot_turn` 是「精确结算优先」形状——先试 `private.finalize_job_reservation`，那条只在尝试行已结算时才能精确核销，否则退回 `private.b04_finish_job_with_unknown_cost`。而路由原先把 `settleKeyedJobUsage` 放在 `finally` 里，`store.finalize` 在 `runCopilotTurn` **内部**早就跑完了。

**已做的修复**（已提交）：`src/server/copilot.ts` 加 `settleUsage` 钩子，在两个 `finalize` 之前各跑一次；`src/app/api/v1/copilot/route.ts` 传入并保留 `finally` 兜底 + 只结算一次的开关；`tests/cloud/copilot.test.ts` 加两条顺序用例。

**❌ 没复验，怎么复验**：

1. 开发测试账号当期（2026-09）generation 桶是 `granted 20 / reserved 7 / consumed 13`，可用为 0。**需要产品所有者授权**把 `usage_accounts.granted` 上调（+6 足够：一轮带改动的对话吃 2 个单位）。我这边这条写操作被权限策略拦下了。
2. 记下 `server_read_cost_budget({p_period:"2026-09", p_environment:"development"})` 的 before。
3. 跑 `docs/acceptance/assistant.md` §2 的第一条用例。
4. 断言该任务的 reservation 变成 `state='settled'`、`released_micro_usd = 25000 - actual_micro_usd`，且预算表的 `spent` 真的涨了几百 µUSD 而不是 `reserved` 涨 25,000。
5. 结果回填 `docs/acceptance/assistant.md` §5 与 `docs/acceptance/release.md` §12.3、§13。

**顺带**：同一张表上那 7 个 `reserved` 单位是历史遗留的悬空预留，不是这一轮产生的。核销是一次显式的花钱决定，按计划没顺手做。

---

## 4. 两个真缺陷，和它们对你的含义

### 4.1 `b04_begin_ai_candidate_job` 的 42702（已修）

`20260907002243_b04.sql:358` 把局部变量取名 `period`，而 `private.cost_budgets` 正好有一列也叫 `period`，`where private.cost_budgets.period = period` 抛 `42702 column reference "period" is ambiguous`。**凡是走这条函数的同步 AI 预留，每一次都异常**——rewrite 候选、regenerate 候选、copilot 对话轮，统统表现为 503。

修在 `supabase/migrations/20260916000300_b04_begin_period_ambiguity.sql`（变量改名 `period_key`，函数体其余逐字相同），已 `supabase db push --linked` 推到开发项目。

**对你的含义，比这个 bug 本身重要**：这说明 **`rewrite` 与 `regenerate` 这两条早就「验收过」的链路，在真实环境里其实一直是坏的**。它们的单测用假 store，真正的 SQL 从没在测试里执行过。接手后如果要动这两条链路，先真跑一次再信任它们的历史验收记录。

### 4.2 上下文键名 `slideTitle`（已修）

`projectContext()` 把卡片标题的键名写成 `slideTitle`，模型如实照抄回 `field: "slideTitle"`，`validField()` 认不出、抛错、被 catch 降级成 `proposal = null`——用户看到助手答了话却没有任何可应用的改动。

已把上下文键名对齐 `RewriteField` 的取值（`title` / `eyebrow` / `cta` / `body:N`，文档标题单独叫 `carouselTitle`），并加了守键名的回归用例。**教训**：模型只会照抄它在上下文里看到的键名，凡是要模型回填的字段名，上下文里就得用同一个字面量。

---

## 5. 还剩什么：7 个 P2 运维任务

| 任务 | 内容 | 现状 |
|---|---|---|
| T073 | 支付生命周期集成验收 | 未验证 |
| T084 | 增长闭环集成验收 | 未验证 |
| T085 | 分环境 CI 与受控生产发布 | 未验证 |
| T086 | 预算/到期清理与监控 | `src/server/observability.ts`、`src/trigger/retention.ts` **已存在但从未验证**。接手先跑验证，别重写 |
| T087 | 备份与隔离恢复工具 | 未验证 |
| T088 | 许可与安全发布检查 | 未验证 |
| T089 | 发布/回滚运维演练 | 未验证 |

另外两条产品侧的已知缺口（不在任务清单里）：

- **D1 的真实出图 ❌**：额度链路已打通并有单测，但真发一次 portrait 卡在本机到 `api.apimart.ai` 的网络出口。见 `docs/acceptance/release.md` §7。
- **横屏的专属排版**：`--slide-density` 让 16:9 能用且不裁切，但 17 个 layout 仍按竖版设计（横屏只是整体缩小）。多栏／横向构图是设计任务。

---

## 6. 雷区速查（每一条都是这两轮真踩过的）

- **`loading.tsx` 会把 404 变成 soft 404。** 加上它之后 `/no-such-page` 与 `/templates/nope` 全部从 404 退化成 200。已删，**不要再加回来**，`Loading.*` 词条也不要恢复。将来要加载态，必须做成不跨越会 `notFound()` 的段的局部 Suspense。
- **Playwright 的 baseURL 默认是 `127.0.0.1:3000`，但应用配置的 origin 是 `localhost:3000`。** 写入路由按字面量比对 `Origin`，不一致就一律 `INVALID_REQUEST`。跑任何写路径的验收都要 `PLAYWRIGHT_BASE_URL="http://localhost:3000"`。
- **`private` schema 不经 PostgREST 暴露**，本机也没有 `psql`、没有 `pg`/`postgres` npm 客户端、没有 `pnpm exec tsx`。查成本只能走 `server_read_cost_budget` / `server_sample_cost_attempts` / `server_sample_cost_reservations` 这三个 RPC。
- **vitest 5 没有 `--reporter=basic`**（模块加载就报错），且 `console.log` 被吞。要看某个值，故意写一条会失败的断言把它逼出来。
- **删测试项目做不到**：`jobs.project_id` 是 `on delete restrict`，账目行又 restrict 在 jobs 上。测试里不要尝试清理项目。
- **`<label>` 包着 `<select>` 会让 `getByLabel` 失效**，助手面板的定位用 `panel.locator("textarea")` 与 `getByRole("button", {name, exact:true})`。
- **绝不写裸 `update jobs set state='succeeded'`**：只动 jobs 会让 `usage_accounts.reserved` 永不归还。走 `private.finalize_job_reservation`（精确）或 `private.b04_finish_job_with_unknown_cost`（保守兜底）。
- zsh 下别用裸 `===` 当分隔符（会报 `(eval):1: == not found` 并截断整条复合命令）；`grep` 不要带 `--include=*.ts`（glob 报错）。
- `supabase db push --linked` 要接 `</dev/null`，不要 `echo "y" |`（那是盲目 apply）。

---

## 7. 明确不做（沿用上一轮的决定，别自作主张翻案）

- **Threads 平台标签**：尺寸与 Instagram 完全相同，只多一个标签不多一种几何，不值得多养一组渲染与视觉矩阵组合。
- **G1 的内容批量生产**（40+ 工具页、SEO 文章矩阵）：架构已一次到位，之后只需往 `content/blog/` 与 `content/zh-Hans/blog/` 丢文件并在 `CATALOG` 加一行。写作单独排期。
- **扩 `TOOL_REGISTRY`（7 → 20+）**：每个新工具都要真能跑 + 逐个验收 + 额外模型成本，不塞空壳 SEO 页。
- **存量 11 条陈旧未结算预留**的核销：是一次显式的花钱决定。
- **`.env.local` 里 `BILLING_POLICY_JSON` 的正式数字**：`monthlyImages` 的 10/100/300 只是**开发环境**的值，上线数字仍是待决商业事项，不替产品定。
