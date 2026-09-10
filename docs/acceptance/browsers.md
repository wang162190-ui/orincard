# T093 可访问性与浏览器兼容

## 已实现行为

`tests/e2e/accessibility.spec.ts` 与 `tests/e2e/browsers.spec.ts` 是 `playwright.config.ts` 里 `CROSS_BROWSER_SPECS` 指名的两个文件，因此它们同时在 `chromium`、`firefox`、`webkit` 三个 project 上执行，共 33 条用例。用例一律按 `testInfo.project.name` 取当前引擎，不硬编码单一浏览器；断言走 `getByRole` / `getByLabel`，即读屏软件看到的那棵可访问性树，没有引入 axe 之类的新依赖。

### 可访问性（`tests/e2e/accessibility.spec.ts`，6 条）

| 用例 | 断言的已实现行为 |
|---|---|
| 营销首页地标 | `banner` / `main` / `contentinfo` 三个地标可见，一级标题恰好 1 个，`Public navigation` 与 `Footer navigation` 两个导航各有自己的可访问名；品牌链接的可访问名是 `Orincard home`（纸鹤图形 `aria-hidden`，读屏不会去念一个装饰多边形）；`html[lang="en"]` |
| 工作台外壳 | `Main navigation` 可见，`New carousel` 带 `aria-current="page"`，`Workspace` 不带；`main` 地标与一级标题 `Create a carousel` 可见 |
| 创建表单的名字与提交闸门 | `Source type` 是有名字的 `tablist`，6 个 `tab`，默认选中 `Topic`；`Generation options` 是有名字的 `group`，`Platform`、`Template`、`Language`、`Content format`、`Number of slides`、`Instructions` 六个控件各自能按标签取到；来源为空时 `Generate carousel` 禁用，填入主题后启用；切到 `Text` / `URL` / `PDF` 时输入框改名为 `Source text` / `Public link` / `PDF file`，而不是留下一个没有名字的输入框；权利声明复选框默认未勾 |
| Tab 阅读顺序与可见焦点 | 焦点从导航后的 `document.body` 出发，靠真实 `Tab` 按键走完创建表单的 13 个停靠点（5 个来源 tab → Topic → Platform → Template → Language → Content format → Number of slides → Instructions → Generate carousel），顺序错了就点名是哪一站；每一站读 `document.activeElement` 的 `getComputedStyle`，`outline-style` 不为 `none` 且 `outline-width` 大于 0，即焦点环真的看得见 |
| 纯键盘走核心流 | 在本地草稿编辑器里，只按 `Tab` 走到第 2 张幻灯片、按 `Enter` 选中（`aria-pressed="true"`），再按 `Shift+Tab` 回到 `Headline`，用 `ControlOrMeta+a` 全选后键入新标题；状态区显示 `Saved locally.`，重载后新标题仍在缩略图上。全程没有用 `element.focus()` 把键盘可达性绕过去，走不到就抛错点名目标 |
| 导出入口 | `/exports` 有一级标题 `Exports` 与 `main` 地标；未登录时状态写在 `role="alert"` 里（`Exports are temporarily unavailable.`），而不是渲染一个读屏会跳过去的空盒子 |

`focusByKey()` 最多按 80 下，超出就抛错并点名走不到的目标，不会静默通过。

### 浏览器兼容（`tests/e2e/browsers.spec.ts`，5 条）

| 用例 | 断言的已实现行为 |
|---|---|
| 三引擎矩阵自检 | `testInfo.config.projects` 必须同时含 `chromium`、`firefox`、`webkit`；当前页面的真实 `navigator.userAgent` 必须匹配本 project 声称的引擎、且不匹配另一引擎的特征。若矩阵哪天塌回单一引擎，这条先失败，而不是让三份 chromium 结果冒充三个浏览器 |
| 桌面核心流 | 首页 → `Create your first carousel` → `/create`，填 Topic / Platform / Number of slides / Instructions 后 `Generate carousel` 可点击（只断言就绪，不点击）→ 本地草稿编辑器 → 选中第 2 张并改标题 → 状态 `Saved locally.`、6 张幻灯片在位 → 重载后改动仍在 → 经 `Main navigation` 回工作台 → `/exports` 标题可见 |
| 窄屏 | 1280px 时内容面板在画布左侧（同一行三栏）；390px 时画布移到内容面板上方（单栏）且宽度不超过 390；`documentElement.scrollWidth` 不超过 `clientWidth + 1`，即窄屏不需要横向滚动；唯一允许滚动的幻灯片条 `overflow-x` 为 `auto`；导航仍可见，第 3 张幻灯片仍可点选并把标题读回输入框 |
| 引擎能力 | 当前引擎真的具备产品依赖的四项：`indexedDB`、`URL.createObjectURL`、锚点的 `download` 属性、`structuredClone`；并真实打开 `orincard-local-drafts` 的 `drafts` object store 数一遍行数，确认草稿确实落到了 IndexedDB |
| 真实登录下载（默认跳过） | `ORINCARD_RUN_BROWSERS_E2E=1` 时才跑：真实登录（30 秒等待），`/exports` 不应出现 `role="alert"`，从真实 `ready` 导出点 `Download`，断言 `download` 事件、文件名非空、文件真的落盘，随后删除临时文件 |

跨浏览器矩阵刻意不花供应商预算：不点 `Generate carousel`、不触发真实导出，所以一次三引擎矩阵不会变成三次真实付费调用。真实生成与真实导出由协调线在串行的云端验收里跑。

真实登录用例复用既有 e2e 登录写法：先填 `Email` 与 `Password`，点 `Sign in` 后立刻把口令字段清空（`.catch()` 兜住已跳转的情况），再等 30 秒跳回首页。开关打开但缺变量时 `required()` 抛错并点名缺失变量，不 skip 后当作通过；开发账号没有 `ready` 导出时同样显式抛错，这条用例在空历史上永远不会"通过"。需要的变量：`ORINCARD_AUTH_TEST_EMAIL`、`ORINCARD_AUTH_TEST_PASSWORD`、`PLAYWRIGHT_BASE_URL`。

`browsers.spec.ts` 在文件顶层关掉 `screenshot` 与 `trace`：登录用例会在页面上填真实口令，而 trace 与失败截图会把那一帧连同请求存进 `test-results/`。Playwright 不允许把 `use()` 收窄到 `describe`（会强制新 worker），所以整个文件关掉这两项。不含凭据的 `accessibility.spec.ts` 仍用配置里的 `retain-on-failure` / `only-on-failure`。

## 验收命令

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
# 门禁（不启浏览器、不触云端）
pnpm typecheck
pnpm test

# 只收集，不执行：确认 33 条用例在三个引擎上都挂上了
pnpm exec playwright test --list tests/e2e/accessibility.spec.ts tests/e2e/browsers.spec.ts

# 三引擎验收（需要本地应用已在 PLAYWRIGHT_BASE_URL 上跑起来；单 worker）
pnpm exec playwright test tests/e2e/accessibility.spec.ts tests/e2e/browsers.spec.ts

# 单个引擎
pnpm exec playwright test --project=firefox tests/e2e/browsers.spec.ts

# 附带真实登录下载（开发项目，串行执行）
ORINCARD_RUN_BROWSERS_E2E=1 pnpm exec playwright test tests/e2e/browsers.spec.ts
```

## 验收结论（协调线，2026-09-11）

三个引擎真实执行，运行于 `next build && next start` 的生产构建（`PLAYWRIGHT_BASE_URL=http://127.0.0.1:3100`），单 worker：

```
29 passed, 4 skipped (14.5s)
```

| project | 结果 |
|---|---|
| chromium | 11 条：10 通过，1 skipped（真实登录下载，未开 `ORINCARD_RUN_BROWSERS_E2E`） |
| firefox | 11 条：10 通过，1 skipped（同上） |
| webkit | 11 条：9 通过，2 skipped（真实登录下载 + 纯键盘核心流，见下） |

`browsers.spec.ts` 的三引擎自检用例在每个 project 上真实读了 `navigator.userAgent` 并比对引擎特征，因此这三列不是同一个 chromium 冒充出来的。

### 定位方式的修正（不是放宽断言）

`src/features/generation/options.tsx` 里三个下拉的 `<label>` 是**包住** `<select>` 的，`<label>` 的纯文本因此连着当前选项文字（`"Platform" + "LinkedIn…"`）。Playwright 的 `getByLabel` 匹配的是 `<label>` 元素的原始文本，`exact: true` 对不上；而读屏软件读的是**可访问名**，实测就是 `Platform`。同理 `Instructions` / `Headline` / `Source text` 这几个已有取值的 `<textarea>`。

因此这些断言改用 `getByRole("combobox" | "textbox", { name, exact: true })`。这是收紧而不是放宽：它断言的正是读屏软件拿到的那个名字，也就是这条用例本来要证的契约。**产品端未做任何改动**——可访问名一直是对的，错的是测试的定位方式。

`/exports` 的播报断言从 `page.getByRole("alert")` 收窄为 `page.getByRole("main").getByRole("alert")`：Next 自己在文档末尾挂了一个空的 `<div role="alert" id="__next-route-announcer__">`，不限定范围会把框架噪声一起断言进来。

### Firefox：无头模式下 Tab 焦点不回绕

Firefox 无头走到最后一个可聚焦元素后不再前进——有界面时它会把焦点交给浏览器 UI，无头下没有 UI，于是原地不动。`blur()` 无效，因为 Firefox 记的是**顺序焦点导航起点**而不是当前焦点。解法是先点一下不可聚焦的一级标题把起点挪回页面顶部，再走整条读序。断言的停靠点一个没少。

`playwright.config.ts` 的 firefox project 显式设了 `accessibility.tabfocus = 7`。事后探针证明 Firefox 本来就会 Tab 到按钮和链接，这个 pref **不是**修好这条用例的原因；保留它是为了让 Tab 序不受本机系统设置左右，无害且已注明。

### WebKit：macOS「全键盘控制」系统惯例（如实记录，未绕过）

`defaults read -g AppleKeyboardUIMode` 在本机**未设置**，即 macOS 默认。该默认下 Tab 只停在文本框与列表上，**按钮、链接、`role=tab` 一律不进 Tab 序**。Safari/WebKit 照办，Chrome 与 Firefox 不照办。实测 WebKit 的 Tab 序是：

```
INPUT(Topic) → SELECT(Platform) → SELECT(Template) → INPUT(Language)
→ SELECT(Content format) → INPUT(Number of slides) → TEXTAREA(Instructions) → BODY
```

顺序与另两个引擎完全一致，只是少了 5 个来源 tab 与提交按钮。这是**操作系统惯例，对所有网站一视同仁，不是本产品的缺陷**；依赖键盘的 Mac 用户本来就开着「全键盘控制」，开启后 Safari 的 Tab 序与另两个引擎一致。**未修改本机系统设置。**

据此：

- **Tab 阅读顺序与可见焦点**：在 WebKit 上仍真实执行，只断言 WebKit 确实会停靠的 7 个控件的顺序与焦点环。含 5 个 tab 与提交按钮的完整 13 站读序，证据以 chromium 与 firefox 为准。
- **纯键盘走核心流**：第一步就要 Tab 到胶片条里的幻灯片按钮，在 WebKit 上无法执行。**显式 `test.skip` 并写明原因**，报告里计为 skipped，不改用鼠标点击后仍宣称「纯键盘」。这条流程在 chromium 与 firefox 上真实跑通。

### 未取证的部分

`signed-in download`（3 个引擎各 1 条）未运行：需要 `ORINCARD_RUN_BROWSERS_E2E=1` 与真实开发账号凭据，且开发账号需先有一件 `ready` 导出。**跨浏览器的真实下载路径因此尚无证据**，`browsers.spec.ts` 里断言的 `download` 事件、文件名与落盘只在开关打开后才成立。

### 结论

T093 的可访问性与三引擎兼容取证在 chromium / firefox 上完整成立，在 webkit 上按平台惯例部分成立且已逐条注明。**没有为了让用例变绿而削弱断言或跳过整个浏览器。**
