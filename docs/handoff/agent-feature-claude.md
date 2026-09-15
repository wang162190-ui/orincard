# 交接文档：给 Orincard 加「AI Agent」功能

写于 2026-09-15。上一份交接是 [b06-b11-codex.md](b06-b11-codex.md)（截至 T087）。

这份文档的用途：**你在一个全新会话里接手，目标是给产品加一个 AI Agent 功能。** 下面的仓库状态、门禁结果、架构结论全部是我在 2026-09-15 当场从仓库里读出来或本地跑出来的，凡是我没亲自验证的一律标注「未证实」，不做推断性结论。

---

## 0. 先读这一节：你要加的东西和现在的架构是冲突的

一句话结论：**这个仓库的 AI 调用层是「单轮、结构化输出、无工具调用」的，从设计上就不支持 agent 循环。** 加 agent 不是写个 prompt，是要在 `src/server/ai.ts` 之外新开一条调用路径，并且回答清楚成本结算和会话状态存哪这两个问题。

证据在第 5 节。**先读第 5 节再动手**，否则你会在 `generateStructured()` 上浪费半天。

---

## 1. 不可变边界（用户原话，逐字保留，全程适用）

- **不操作生产项目**，只用开发项目。
- `.env.local` 可以读，但只在子 shell 里加载（`( set -a; . ./.env.local; set +a; … )`），**绝不打印值，值不得进入聊天、日志、trace、截图或 Git**。截图前确认画面里没有口令和密钥。
- **花钱默认已批准**（2026-09-11 用户明确放宽，不必逐步问），但 `AI_MONTHLY_BUDGET_USD=10` 的月度硬顶仍在，**实际花费必须如实上报，超支必须主动说**。
- **不要用 mock 假装某个功能能用。跑不通就说跑不通。**
- 本会话如果挂着 Supabase MCP，**不要用它**——它指向的不是这个项目的数据库。要查库用 Supabase CLI 或 Management API。
- 所有命令先执行：`export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`
- 本机**没有 `timeout` 命令**，长命令用后台 + 看门狗。
- **把服务器留给我，不要关**——用户原话「这次最重要的一条」。必须一直活着：
  - `:3100` 生产构建（`next start`）—— **因此不要跑 `pnpm build`**，它会覆盖正在被这个进程读的 `.next`
  - `:3000` `next dev`
  - `:8080` `python3 -m http.server`，服务 `docs/design`
  - 本地 Docker 里 **9 个** `supabase_*_orincard` 容器
- 路线图规则：「只在**真的跑通并验证过**之后才打 ✅。跑不通打 ❌ 并写一行原因，不粉饰、不用 mock 凑绿。」
- **不要改 `docs/design/reference/`**（SHA-256 逐字节锁定）。`node scripts/check-planning.mjs` 必须一直报 `15 unchanged design files`。

---

## 2. 仓库真实状态（2026-09-15 复核）

```
分支    codex/walking-skeleton
HEAD    b88e022  S1–S19：成本结算链路、中英双语、AC-012 助手原型
状态    工作区脏：30 个文件（28 改 + 2 新增），全部未提交
```

**未提交的 30 个改动是什么**：上一轮的界面修复（用户原话「有很多功能没有显示，然后界面有挺多bug」）。已本地验证完毕，`pnpm typecheck` 干净、`pnpm test` 314 passed / 0 failed。清单：

| 文件 | 改了什么 |
|---|---|
| `src/components/workspace-shell.tsx` | 侧栏从硬编码 2 个链接改成数据驱动的三组导航（主区 / 素材库 / 账户）+ 页脚 4 个次级链接。导出了新类型 `WorkspaceSection` |
| 15 个 `src/app/[locale]/*/page.tsx` | `current="workspace"` 改成各自所属的 section |
| `src/components/ui.css` | 补了 5 个无定义的 class（`.card` `.stack-lg` `.card-grid` `.marketing` 等）+ 一套 `:where()` 包裹的表单控件兜底（特异度 (0,0,0)，只压浏览器默认样式） |
| `src/components/public-header.tsx`（新增） | `PublicHeader` / `PublicFooter`，首页和定价页共用 |
| `messages/{en,zh-Hans}.json` | `Nav` 各加 11 个键 |
| `tests/ui/shell.test.tsx` | 「不链接到未实现路由」的守卫改了断言、没改用意 |
| `trigger.config.ts` | `syncEnvVars` 拆成 `SHARED_VARS` + 仅 `APP_ENV=production` 才同步的 `PUBLIC_ONLY_VARS` |
| `.gitignore` | 加 `.vercel` |
| `docs/acceptance/public-deployment.md`（新增）、`docs/roadmap.md` | 部署记录 |

**接手第一件事：决定这批改动是先提交还是和你的 agent 工作混在一起。** 我建议先单独提交——它是一件已完成的独立工作，混进 agent 那一大坨 diff 里会让两边都难 review。

**❌ 公开站没有这批改动。** `vercel --prod --yes --archive=tgz` 被 Claude Code 的权限分类器拦下（Reason: No reason provided），从未部署成功。公开站还是旧构建。

任务进度：`docs/sdd/orincard/tasks.md` **87 项已勾 / 99 项**，12 项未勾。未勾的是诚实判断，不是遗漏——**不要因为「测试绿了」就补勾**。

---

## 3. 门禁命令（我当场跑过的，附实测结果）

```bash
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
cd /Users/www.macpe.cn/Documents/ChatGPT/Orincard-walking-skeleton

pnpm typecheck                       # exit 0，无输出
pnpm test                            # 44 files, 314 passed | 7 skipped, 0 failed
node scripts/check-planning.mjs      # PASS ... 15 unchanged design files
```

注意：
- **`pnpm lint` 不存在**，package.json 里没有这个脚本。别去跑它。
- `pnpm test` 默认排除 `tests/cloud/**`。云端用例要单独 `pnpm test:cloud`，且需要真实凭据。
- `*.vercel.app` 在这台机器的网络上被 DNS 污染，**公开站只能用浏览器（Chrome DevTools MCP）验证，curl 一定失败**。本地端口 curl 正常。

服务器存活检查（每次收尾都跑）：

```bash
for p in 3000 3100 8080; do curl -so /dev/null -m 5 -w "$p %{http_code}\n" http://127.0.0.1:$p/; done
docker ps --format '{{.Names}}' | grep -c orincard    # 必须是 9
```

---

## 4. 现有代码地图（只列和 agent 相关的）

```
src/server/ai.ts               唯一的 LLM 调用层。DeepSeek via OpenAI SDK。
src/server/prompts.ts          buildGenerationPrompt / buildSchemaRepairPrompt
src/server/generation.ts       生成编排：配额 → 调用 → 校验 → 落库 → 结算
src/server/rewrite.ts          单张改写，和 generation 同构
src/server/cost.ts             计价表 MODEL_RATES、attemptKey()、priceTextUsage()
src/server/cost-settlement.ts  registerJobCostAttempt / settleGenerationUsage / ...
src/server/jobs.ts             JobStore、dispatchPendingJob、reconcileJobs
src/server/tools/              7 个工具的服务端实现
src/server/sources/            来源解析：url / pdf / video / slides / ocr / transcribe
src/domain/tools.ts            TOOL_IDS 常量 + Zod schema
src/trigger/                   16 个 Trigger.dev 任务（含 2 个 cron）
src/app/api/v1/                48 个路由
```

7 个工具（`src/domain/tools.ts:3`）：`caption` `linkedin-post` `post-ideas` `quote-card` `infographic` `portrait` `carousel-to-video`。

---

## 5. 加 agent 之前必须知道的五件事（重点）

### 5.1 `ai.ts` 不支持工具调用，一行都没有

`src/server/ai.ts` 对外只有一个接口：

```ts
interface StructuredAI {
  generateStructured(request: StructuredOutputRequest): Promise<unknown>;
}
```

`createDeepSeekResponsesAdapter` 里的请求体是写死的：`model` / `store:false` / `instructions` / `input`（单条 user 消息）/ `text.format = json_schema`。**没有 `tools` 字段，没有 `tool_choice`，没有多轮 `messages` 数组，没有 assistant 回合。** 返回值只取 `output_text` 然后 `JSON.parse`。

结论：agent 循环（模型决定调哪个工具 → 执行 → 把结果喂回去 → 再决定）**在现有 adapter 上做不出来**。你要么给 `StructuredAI` 加一个并列的 `runToolLoop()` 之类的接口，要么新写一个 adapter。`generateStructured` 本身不要改签名——`generation.ts` 和 `rewrite.ts` 都依赖它，改了会连带炸。

### 5.2 `store:false` 是硬要求，会话状态必须自己存

`store:false` 写在 adapter 里，注释和交接文档里都被标为不可变边界（供应商侧不保留任何内容）。这意味着 **多轮对话历史必须由我们自己持久化**，不能靠 provider 的 conversation id。你要新建表。

### 5.3 每一次模型调用都必须结算，幂等键的形状已经定死了

`src/server/cost.ts:126`：

```ts
attemptKey(jobId: string, operation: string, sequence: number)
```

流程是 `registerJobCostAttempt()` 先占位 → 调用 → `onMeasurement` 回调拿实测 usage → `settleGenerationUsage()` 落 `private.cost_attempts`。注意 `ai.ts` 里那句注释：**「先结算再校验产物：token 是照烧的，输出无效不等于这次调用没花钱」**——这个顺序不能反。

对 agent 的直接影响：**一次 agent 会话 = N 次模型调用 = N 条结算记录**，`sequence` 怎么排是你必须先想清楚的事。用轮次序号最自然，但要保证重试时不会和已有记录撞键。

### 5.4 预算闸门会在中途把你打断，agent 必须能优雅地停

`registerJobCostAttempt` 的返回 `outcome` 有 `quota_exceeded` / `budget_exceeded` / `idempotency_conflict` 等（`src/server/generation.ts:494`）。另有断路器 `BUDGET_CIRCUIT_OPEN`（`src/server/observability.ts:12`）。

对 agent 的直接影响：**第 3 轮被预算打断是正常路径，不是异常路径。** 要设计成「已完成的部分成果要保留并告诉用户，而不是整个会话回滚」。另外强烈建议给单次 agent 会话加一个**轮数硬顶**，否则一个循环能把 $10 月度额度一次吃光。

### 5.5 Trigger worker 的载荷被限死了，对话历史塞不进去

不可变边界原文：**Worker 载荷只允许 `{ jobId, schemaVersion, requestId }`**（解析任务为 `{ sourceId, schemaVersion, requestId }`）。

对 agent 的直接影响：如果 agent 跑在 Trigger 任务里（长任务需要），**对话历史只能落库、由 worker 用 `jobId` 去读**，不能当参数传。

---

## 6. 你必须先做的四个决定（我不替你定，但给了倾向）

| # | 岔路 | 选项 | 我的倾向与理由 |
|---|---|---|---|
| 1 | agent 循环跑在哪 | (a) Next 路由里同步跑 (b) Trigger 任务 + 前端轮询 | **(b)**。理由：Vercel 函数有执行时长上限，多轮工具调用轻松超时；而且 `jobs` 表 + `/api/v1/jobs/[id]` 轮询这套基建**已经有了**，16 个 Trigger 任务都在用，复用它比新造一条同步路径便宜得多。代价是要新建会话表（见 5.5） |
| 2 | 模型与 adapter | (a) 给 DeepSeek 新写一个支持 tools 的 adapter (b) 换支持 function calling 更成熟的 provider | **(a) 先试**。DeepSeek 走的是 OpenAI SDK，`responses.create` 本身支持 `tools`，adapter 里只是没传。先验证 `deepseek-v4-pro` 的工具调用实际表现，**跑一次真实调用看结果再决定**，别靠文档下结论。换 provider 要连带改 `MODEL_RATES` 计价表 |
| 3 | 给 agent 哪些工具 | (a) 一次接全部 7 个 tool + 生成 + 改写 + 导出 (b) 先接 3 个 | **(b)**。建议第一刀只接 `解析来源` / `生成大纲` / `改写单张`——这三个链路最短、都有现成的服务端函数、失败也最好排查。跑通了再加 |
| 4 | 会话状态存哪 | (a) 新建 `agent_sessions` + `agent_messages` 表 (b) 塞进 `jobs.payload` | **(a)**。`jobs` 是单次任务模型（`kind` + 状态机），塞多轮历史进去会把 `reconcileJobs` 的语义搞坏。新表要写迁移，注意现在已有 **27 份迁移** |

---

## 7. 建议的第一刀（最小可跑通，不是全部）

按这个顺序，每步跑通了再进下一步：

1. **先验证工具调用能力**：写一个一次性脚本，用 `.env.local` 里的 `DEEPSEEK_API_KEY`（子 shell 加载，不打印），对 `deepseek-v4-pro` 发一次带 `tools` 的请求，看它是否真的返回 tool_call。**这一步花几分钱，是整个功能的前提。跑不通就直接回报「DeepSeek 不支持，需要换 provider」，不要硬凑。**
2. 写迁移建 `agent_sessions` / `agent_messages` 表，带 RLS（参考既有 27 份迁移的 RLS 写法）。
3. 在 `src/server/ai.ts` **旁边**新建 `src/server/agent.ts`，实现带轮数硬顶的循环 + 每轮结算。不要改 `generateStructured` 的签名。
4. 接 3 个工具，用依赖注入的方式（仓库现有代码到处都是注入适配器的写法，照抄）。
5. 新建 Trigger 任务 `src/trigger/agent.ts`，载荷只放 `{ jobId, schemaVersion, requestId }`。
6. 前端：复用现有 job 轮询组件。
7. 中英双语词条两份都要加（`messages/en.json` + `messages/zh-Hans.json`），漏一边单测会红。
8. 写 `docs/acceptance/agent.md`，**跑通写跑通，跑不通写跑不通加一行原因**。

---

## 8. 明确不要做的事

- ❌ 不要跑 `pnpm build`（会覆盖 `:3100` 正在用的 `.next`）
- ❌ 不要关 `:3000` / `:3100` / `:8080` 和 9 个 docker 容器
- ❌ 不要改 `docs/design/reference/`
- ❌ 不要用 Supabase MCP 操作本项目
- ❌ 不要 mock AI / Storage / Trigger 的成功来让测试变绿
- ❌ 不要改 `generateStructured` 的签名
- ❌ 不要去掉 `store:false`
- ❌ 不要为了 agent 方便就把对话历史塞进 Trigger 载荷
- ❌ 不要动 `main` 分支
- ❌ 不要推进 S20 及之后的开发步骤——助手原型仍等用户过图

---

## 9. 仍然挂着的阻塞项（和 agent 无关，但别以为它们已经好了）

| 项 | 状态 |
|---|---|
| **部署** | ❌ `vercel --prod` 被权限分类器拦下，界面修复没上线 |
| **Trigger 公开站项目** | 等用户新建 Trigger 项目并提供 `proj_…` ref 和 `tr_prod_…` key |
| **Supabase Confirm email** | 用户已答应在控制台关掉，未证实是否已关 |
| S20 | 🛑 助手原型待用户过图 |
| B-1 | 12 项法务/商业决策未定，三份法律文本正文明写「不可用作生产条款」 |
| B-2 | Stripe 只有 `sk_test_`，`BILLING_LIVE_ENABLED=false`，付费完全不可用 |
| B-4 | GitHub production environment 未配，本地 CLI 直推绕开了 5 条发布守卫（`release-guards.test.ts` 仍 5 红，未粉饰） |
| 用户已明确暂不做 | Supabase Site URL + `/auth/callback` 白名单；生产库密码重置。**不要反复催** |

---

## 10. 交接确认清单

接手后建议按顺序做，做完再动代码：

- [ ] `export PATH="/opt/homebrew/opt/node@22/bin:$PATH"`
- [ ] 三个端口 200、9 个容器在
- [ ] `git status` 确认还是 30 个未提交改动（若不是，说明中间有人动过，先搞清楚）
- [ ] `pnpm typecheck` + `pnpm test` + `node scripts/check-planning.mjs` 三条全绿，作为你的基线
- [ ] 读完本文第 5 节
- [ ] 和用户确认第 6 节那四个决定
