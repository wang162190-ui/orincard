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
