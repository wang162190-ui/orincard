# 视觉导出矩阵验收记录

## 已实现行为

`tests/visual/export-matrix.spec.ts` 覆盖主题 × 平台 × 页数矩阵，三个维度全部取自已发布常量，测试内不另抄一份清单：

- 主题：`src/render/templates.ts` 的 `THEME_IDS`（6 个）。
- 平台：`src/domain/document.ts` 的 `platformPresets` 键，画布尺寸取 `getPlatformDimensions`（3 个）。
- 页数：`MIN_SLIDE_COUNT` / `DEFAULT_SLIDE_COUNT` / `MAX_SLIDE_COUNT`，即 4 / 6 / 12。

组合共 6 × 3 × 3 = 54 个，按主题分成 6 个用例，同一用例内复用一个页面上下文，不为单个组合重启浏览器；worker 数由 `playwright.config.ts` 固定为 1。

页面文本全部来自 `tests/fixtures/corpus.json`，没有新造素材：`topic-zh-emoji` 提供中文与 Emoji 边界，`text-zh-en-mixed` 拆句后提供中英混排，`text-long-token` 提供不可断行长词。文档骨架来自 `tests/fixtures/base-document.json`；模板页若没有正文块，会补一个段落块以保证每个内容页都承载边界文本。

每个组合先经 `previewAppearance` 生成文档，并断言 `conflicts` 为空、`canvas` 等于该平台的导出尺寸——外观模型已判定冲突的文档不会进入渲染，避免后续 preflight 失败来源不明。文档随后按 `LocalDraftStore` 的键结构写入 IndexedDB（`orincard-local-drafts` / `drafts`），打开 `/editor/<id>`，断言草稿状态为 `Saved locally.` 且分页条数量与页数一致，再把画布宽度钉到该平台的导出宽度；幻灯片排版使用容器查询单位，因此按导出宽度测量等价于测量导出页。

「无裁切、缺字、缺资源」由 `src/render/preflight.ts` 的 `preflightVisualExport` 判定，断言 `issues`、`blockedFormats` 为空且 `ok` 为真，即 `TEXT_OVERFLOW` / `ASSET_MISSING` / `ASSET_NOT_READY` / `FONT_NOT_READY` / `MEASUREMENT_FAILED` 均未出现。两个反向用例保证判定不是空转：语料中的长词页产生 `TEXT_OVERFLOW`，无素材的图片页产生 `ASSET_MISSING`，两者的 `blockedFormats` 均等于 `VISUAL_EXPORT_FORMATS`。

与实现相关的两处偏差已写在测试注释中：

- 计量适配器沿用 `createDomPreflightAdapter` 的同一套 DOM 契约（`[data-slide-id]`、`[data-slide-content]`、`img[data-asset-id]`、`document.fonts`），但在页面内经 `page.evaluate` 求值，因为该适配器需要真实布局，测试进程侧没有；分类仍在 `preflightVisualExport` 内完成，issue code 来自产品代码。
- `preflightVisualExport` 经 `createRequire` 载入：`src/render/preflight.ts` 导入 `font-manifest.json` 时没有带 import attribute，Node 的 ESM 链接在 Playwright 加载模块图时会拒绝；走 CommonJS 转换即可载入同一份实现，无需改动源码。

截图沿用 `tests/visual/editor.spec.ts` 的风格，仅在 `ORINCARD_CAPTURE_VISUALS=1` 时写入 `output/playwright/`。

## 验收命令

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
pnpm typecheck
pnpm test
```

矩阵本身由 Playwright 执行（单 worker，需要本地应用服务）：

```sh
export PATH="/opt/homebrew/opt/node@22/bin:$PATH"
pnpm exec playwright test --project=chromium tests/visual/export-matrix.spec.ts
```

需要截图证据时附加 `ORINCARD_CAPTURE_VISUALS=1`。

## 验收结论（协调线，2026-09-11）

```
pnpm exec playwright test --project=chromium tests/visual/export-matrix.spec.ts
8 passed (28.1s)
```

6 个主题各 1 条用例覆盖 3 平台 × 3 页数 = 9 组，合计 54 组，另加长词与缺资源两条反向用例。全部 54 组的 `TEXT_OVERFLOW` / `ASSET_MISSING` / `ASSET_NOT_READY` / `FONT_NOT_READY` / `MEASUREMENT_FAILED` 均为空。

### 首轮 7 条失败牵出两个真实产品缺陷（已修，非削弱断言）

首轮 7 条用例全部报 `FONT_NOT_READY`，根因在 `src/render/preflight.ts`，两处都是预检自身的判定写错，与用例无关：

1. **字体就绪判定不看要渲染的字**。原实现调 `fonts.check(font)` 不带文本参数。浏览器对不带文本的查询按"该字族是否有任何已加载的面"回答，而语料里有中文与 Emoji 卡片，命中的是后备字体，于是每张卡都被判成未就绪。改为先 `fonts.load(font, text)` 再 `fonts.check(font, text)`，其中 `text` 取该张卡片自己的正文——即真正要渲染的那些字形。

2. **溢出测量量错了盒子**。原实现拿卡片根元素的盒子当边界。模板的背景形状按设计会越过卡片边缘（这是视觉效果，不是溢出），因此根元素的 `scrollWidth/Height` 恒大于边界，把正常卡片误报成裁切。改为测量 `[data-slide-content]` 的内容盒——那才是"文字有没有被裁掉"该看的范围。

两处修复同步反映在 `tests/ui/preflight.test.tsx` 与本文件的矩阵用例里。**没有放宽任何断言**：五类问题仍要求全为空，反向用例仍要求长词被报为 `TEXT_OVERFLOW`、缺图被报为 `ASSET_MISSING`。

### 仍未闭合的一点

`preflightVisualExport` 与 `createDomPreflightAdapter` 在 `src/` 下**没有任何调用方**。也就是说这套预检目前只被验收用例驱动，真实导出路径并不会在导出前跑它。矩阵证明了渲染结果本身没有裁切缺字缺资源，但**没有**证明产品会在用户导出时主动拦截这些问题。接线属于独立工作，如实记录于此。

### 结论

T091 真实通过，可勾选。
