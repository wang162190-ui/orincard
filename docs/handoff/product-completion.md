# 交接：先把产品做完，确保每个页面都正常

交接日期：2026-09-15。写给下一个接手的人。
本文里凡是写「实测」的，都是当天在**开发**环境真跑出来的；凡是没跑过的，写「未验证」，不写「应该没问题」。

---

## 0. 不可协商的约束（先读这一节，违反了后面全白做）

- **不操作生产项目，只用开发项目**（Supabase `ettuzeunkadkfnawawdy`）。
- **不要用 Supabase MCP 操作本项目**——它指向的不是这个项目的数据库。要查库用 Supabase CLI 或 service key 脚本。
- `.env.local` 可以读，但**只在子 shell 里加载**（`( set -a; . ./.env.local; set +a; … )`），**绝不打印值**。值不得进入聊天、日志、trace、截图或 Git。
- 花钱默认已批准，但 `AI_MONTHLY_BUDGET_USD=10` 的月度硬顶仍在。**实际花费必须如实上报，超支必须主动说。**
- **不要用 mock 假装某个功能能用。跑不通就说跑不通。**
- 所有命令先 `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`。
- 本机**没有 `timeout` 命令**，长命令用后台 + 看门狗。
- **把服务器留给用户，不要关**：`:3100`（生产构建）、`:3000`（next dev）、`:8080`（http.server）、9 个 `supabase_*_orincard` 容器、以及 `trigger dev` worker。
- **不要跑 `pnpm build`**（会覆盖 `:3100` 正在读的 `.next`）；`pnpm lint` 不存在。
- 不要改 `docs/design/reference/`（SHA-256 锁定，`check-planning.mjs` 必须一直报 15 unchanged design files）。
- 不改 `generateStructured` 签名，不去掉 `store:false`；不要把对话历史塞进 Trigger 载荷。
- 路线图只在**真的跑通并验证过之后**才打 ✅，跑不通打 ❌ 并写一行原因。

---

## 1. 今天实测到的页面状态

`next dev` 在 `:3000`。逐条 `curl -L` 实测（匿名，未登录），23 个 `page.tsx` 对应的路由全部有响应：

| 路由 | 状态 | 响应体 |
|---|---|---|
| `/` `/pricing` `/login` `/signup` `/reset-password` | 200 | 43–60 KB |
| `/projects` `/create` `/templates` `/tools` `/agent` | 200 | 55–66 KB |
| `/billing` `/brand-kits` `/exports` `/settings` `/support` | 200 | 48–67 KB |
| `/affiliate` `/affiliate/dashboard` | 200 | 48 KB |
| `/tools/caption` `/tools/post-ideas` | 200 | 62 KB |
| `/legal/privacy` | 200 | 55 KB |
| `/editor/<uuid>` | 200 | 84 KB |
| `/templates/<不存在>` `/guides/<不存在>` `/help/<不存在>` | **404** | 45–46 KB（带站点外壳） |
| `/no-such-page` | **404** | 11.5 KB（**Next 原生 404，没有站点外壳**） |

没有任何一页出现 `Application error` / `Internal Server Error` / `Unhandled Runtime`。

配套的绿灯（当天实跑）：

```
pnpm typecheck                    exit 0
pnpm test                         51 files / 389 passed | 7 skipped
node scripts/check-planning.mjs   102 tasks / 50 API paths / 15 unchanged design files
```

## 1.1 但「每个页面都正常」目前**只证到匿名 SSR 这一层**

这是本交接最重要的一句话，别被上面那张全绿的表骗了。

- 受保护页面（`/projects` `/billing` `/settings` `/editor/<id>`）匿名访问**不是重定向到登录**，而是渲染一个带 "Sign in" 提示的外壳并返回 200。这是**刻意的**设计（SSR 外壳 + 客户端鉴权），不是 bug。
- 后果：上面那张表**完全没有触及登录态**。一个页面在登录后崩不崩、数据取不取得到、空态长什么样，这轮一概**未验证**。
- `/editor/<不存在的 uuid>` 返回 200，也只是因为匿名时根本没走到项目查询。登录态下它该 404 还是该报错，**未验证**。

---

## 2. 建议的做事顺序（产品优先，运维靠后）

`docs/sdd/orincard/tasks.md` 里 102 个任务还剩 12 个未打勾。按「先把产品做完」重排如下——**这是建议的顺序，不是新的需求**：

### P0 — 产品功能补完（编辑器助手，四个任务是一条链）

| 任务 | 内容 |
|---|---|
| T096 | 出助手四态与冲突态原型，交产品所有者过图 → AC-012 |
| T097 | `src/app/api/v1/copilot/route.ts` + `src/server/copilot.ts`，自托管对话 runtime，每轮先预留预算后按实测结算 → AC-009, AC-012 |
| T098 | 接入编辑器（`src/features/editor/assistant.tsx`），**只读上下文 + 人工确认后才写** → AC-005, AC-012 |
| T099 | `tests/e2e/assistant.spec.ts` 端到端与并发冲突验收 → AC-005, AC-012 |

T097 的计费必须照抄现成的那一套：**先 `server_submit_job` 预留，收尾精确结算**。不要再写一条新的收尾路径，见 §4。

### P1 — 页面健壮性（这一档最贴合「确保每个页面都正常」）

这一档**不在 tasks.md 里**，是今天实测暴露出来的，需要补：

1. **全站没有任何 `error.tsx` / `global-error.tsx` / `not-found.tsx` / `loading.tsx`**。`find src/app -name "error.tsx" -o -name "not-found.tsx" -o -name "loading.tsx"` 返回空。意味着任何一个未捕获的渲染期异常，用户看到的是 Next 的原生错误页，不是产品的。
2. **`/no-such-page` 落在 locale 段之外，吃的是 Next 原生 404**（11.5 KB，无导航、无品牌）。locale 段内的 404 有外壳（45 KB），两者不一致。
3. **登录态巡检不存在**。这是 T095 该覆盖的，见下。

### P1.5 — T095 全产品冒烟（`tests/e2e/full-product.spec.ts`）

这是把「每个页面都正常」从一句话变成**每次提交都自动守住的断言**的任务，优先级建议提到运维任务之前。

现状：`tests/e2e/` 已有 19 个 spec，但**没有共享的登录 fixture**——每个 spec 自己 `account.auth.signInWithPassword` 一遍（见 `tests/e2e/walking-skeleton.spec.ts:103-114` 的写法：先 UI 登录，再用 supabase client 拿 session/ownerId）。

建议 T095 这么做：
- 抽一个共享的已登录 `storageState` fixture，别让第 20 个 spec 再抄一遍登录流程。
- 用它把 23 条路由**在登录态下**各过一遍，断言：HTTP 200、无 console error、`h1` 存在、无 `Application error` 文案。
- 匿名态同样过一遍（今天是手 curl 的，应该固化成断言）。
- 把 `/editor/<不存在的 uuid>` 在登录态下的**期望行为先定下来**再写断言——现在没人定过。

### P2 — 运维与发布（产品跑通之前不必碰）

T073（支付生命周期验收）、T084（增长闭环验收）、T085（CI 与受控发布）、T086（预算/清理/监控）、T087（备份与恢复）、T088（许可与安全发布检查）、T089（发布/回滚演练）。

T086 的文件（`src/server/observability.ts`、`src/trigger/retention.ts`）**已经存在**——它未打勾是因为**没验证过**，不是因为没写。接手时先跑验证，别重写。

---

## 3. 上线前的硬前提（别漏，会漏账）

**Trigger 的 prod 环境目前那个部署是 2026-09-14 之前的构建，工具任务在它那里不记账。** 上线前必须重新 `deploy`，否则生产的文本工具花费会全部漏账。详见 `docs/acceptance/agent.md` §3.1。

另外 `.env.local` 里的 `BILLING_POLICY_JSON` 带 `testOnly: true`，在 production 下 `loadEntitlementPolicy` 会抛 `BILLING_NOT_CONFIGURED`。**这是刻意的**：免费额度的具体数字仍是待决的商业事项，不该被默默定下来。

---

## 4. 计费：新增任何一条 job 链路都必须照抄的形状

本轮刚把工具链路补成这个形状，新代码请照抄，别自创：

- **提交侧**：走 `public.server_submit_job`，它原子地建 job + 预留额度 + 预留环境成本。绕开它（比如 `admin.from("jobs").upsert()`）必然在 worker 端 `22023 open cost reservation not found`。
- **收尾侧**：**有实测数据就精确结算，审计不过才退回 `unknown` 兜底**。参考 `public.server_finalize_tool_job`（`supabase/migrations/20260915003000_tool_job_precise_settlement.sql`）：先 `private.finalize_job_reservation(p_job_id)`，再 `private.b04_finish_job_with_unknown_cost`。后者的成本段只动 `state='open'` 的预留，所以结算完它自动成为 no-op，用量与 jobs 终态仍由它一手完成。
- **裸 `update jobs set state='succeeded'` 是错的**：只动 `jobs`，`usage_accounts.reserved` 永远不还，免费额度跑满就锁死。

### 已知的同类缺口（先于本轮，**没动**）

`server_finalize_generation_job`、`server_complete_rewrite_proposal`、`server_complete_regeneration_candidate` 仍是无条件兜底 `unknown`。本轮只修了工具链路，因为一起改会把爆炸半径扩到没验证过的三条链路上。留给它们各自的验收。

`src/trigger/visual-tool.ts` 从不登记 `cost_attempts`，所以视觉工具照旧走兜底——行为与改动前一致，没变坏也没变好。

### 存量脏数据（**故意没清**）

开发项目当前有 **11 条** 陈旧未结算预留（`server_count_unsettled_reservations`）。核销要走 `public.server_write_off_stale_reservation`，那是一次显式的花钱决定，不该顺手做掉。
开发测试账号 `c28c9a9a-bd69-4cb3-8586-6f0d3ba6c706` 的 `usage_accounts` 是 `granted 10 / consumed 4 / reserved 1`，那个 `reserved 1` 是修复前的遗留，**故意没手工改库**。

---

## 5. 怎么复跑验证

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"

pnpm typecheck                    # exit 0
pnpm test                         # 注意：默认套件 --exclude 'tests/cloud/**'
pnpm test:cloud                   # 有 11 条先于本轮的既有失败，mp4.test.ts 在满载下不稳
node scripts/check-planning.mjs   # 必须一直是 15 unchanged design files
```

页面巡检（今天用的就是这条，`:3000` 已在跑，别重启）：

```sh
for p in / /pricing /login /projects /create /templates /tools /agent \
         /billing /brand-kits /exports /settings /support /affiliate; do
  echo "$(curl -sL -o /tmp/p.html -w '%{http_code}' --max-time 120 "http://127.0.0.1:3000$p")  $p"
done
```

要真跑工具链路（**会花钱**，一次约 1,100 µUSD ≈ $0.0011），需要 `trigger dev` worker 在跑、且 app 的 `TRIGGER_SECRET_KEY` 与 worker 同一个 Trigger 环境：

```sh
( set -a; . ./.env.local; set +a; \
  ORINCARD_RUN_TOOL_CLOUD=1 \
  ORINCARD_TOOL_CLOUD_OWNER_ID=c28c9a9a-bd69-4cb3-8586-6f0d3ba6c706 \
  pnpm exec vitest run tests/cloud/tool-route-live.test.ts )
```

---

## 6. 最近一轮改了什么（背景）

| 缺陷 | 状态 |
|---|---|
| `/api/v1/tools/[tool]` 绕开 `server_submit_job` | ✅ 已修并真跑验证 |
| 工具 worker 裸 UPDATE 收尾、`reserved` 只增不减 | ✅ 已修（新增 `server_finalize_tool_job`） |
| 收尾无条件兜底 `unknown`，预留堆积 | ✅ 已修（精确结算优先），实测 `unsettled 11 → 11` |
| 计划步骤入参 `count`/`instructions` 被静默截断 | ✅ 已修，实测 `count:3` 回正好 3 条 |
| `resource = 'image'` 从不发放 | ❌ 未修——需要 `Entitlements` 加字段，是商业决策 |
| 步骤之间不传产物 | ❌ 未修——设计边界，不是缺陷 |

细节与真实 job ID 见 `docs/acceptance/agent.md`。

本轮真实供应商花费约 **$0.006**，月度硬顶 `$10` 远未触顶。
