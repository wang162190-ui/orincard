# Orincard 素材许可清单

状态：T088 发布前许可核对，2026-09-11。

这份清单是 `tests/cloud/release-guards.test.ts` 的数据源，不是说明文档：表格的列位置被测试直接读取，改列序会让守卫失效。守卫的判定规则是「缺条目即失败、条目写着未知即失败」，因此本文件里出现「未知」是一个**真实的发布阻塞项**，不是占位符。

字体软件许可另见 [fonts.md](fonts.md)；来源解析工具与 copyleft 审查另见 [parsers.md](parsers.md)。本文件覆盖的是随仓库分发的素材文件、字体登记、权利条目对照与模型资格。

## 1. 随仓库分发的素材文件

| 路径 | 类别 | 许可 | rightsId | 证据 |
|---|---|---|---|---|
| `content/templates.json` | 模板 | proprietary-owned | orincard-editorial-copy | 团队为 T012 撰写的模板文案与版式，git 历史即出处 |
| `docs/design/reference/assets/img/avatar-elena.jpg` | 设计参考人像 | client-supplied-internal | - | `docs/design/reference/README.md` 记载 2026-09-04 原样复制；产品所有者 2026-09-12 书面确认其来自同批 Open Design 导出、人像为 AI 生成或持有授权，见 [../roadmap.md](../roadmap.md) B-3 |
| `docs/design/reference/assets/img/credits.json` | 设计参考出处记录 | client-supplied-internal | - | `docs/design/reference/README.md` 记载 2026-09-04 原样复制 |
| `docs/design/reference/assets/img/desk-morning.jpg` | 设计参考图 | CC BY 2.0 | - | `docs/design/reference/assets/img/credits.json`，作者 Shixart1985，Wikimedia Commons |
| `docs/design/reference/assets/img/glasses-notebook.jpg` | 设计参考图 | CC BY 2.0 | - | `docs/design/reference/assets/img/credits.json`，作者 Shixart1985，Wikimedia Commons |
| `docs/design/reference/assets/img/notebook-pen.jpg` | 设计参考图 | CC BY 2.0 | - | `docs/design/reference/assets/img/credits.json`，作者 Shixart1985，Wikimedia Commons |
| `docs/design/reference/assets/img/portrait-smiling.jpg` | 设计参考图 | CC BY 2.0 | - | `docs/design/reference/assets/img/credits.json`，作者 Shixart1985，Wikimedia Commons |
| `docs/design/reference/assets/img/typing-office.jpg` | 设计参考图 | CC BY 2.0 | - | `docs/design/reference/assets/img/credits.json`，作者 Shixart1985，Wikimedia Commons |
| `docs/design/reference/assets/img/workspace-writing.jpg` | 设计参考图 | CC BY 2.0 | - | `docs/design/reference/assets/img/credits.json`，作者 Shixart1985，Wikimedia Commons |
| `docs/design/reference/assets/ori.js` | 设计参考脚本 | client-supplied-internal | - | `docs/design/reference/README.md`：用户指定 Open Design 项目 `9d82ca96-7422-48e2-a3e5-f2c9a7300f6e` |
| `docs/design/reference/assets/orincard.css` | 设计参考样式 | client-supplied-internal | - | 同上 |
| `docs/design/reference/brand-kits.html` | 设计参考页面 | client-supplied-internal | - | 同上 |
| `docs/design/reference/editor.html` | 设计参考页面 | client-supplied-internal | - | 同上 |
| `docs/design/reference/generator.html` | 设计参考页面 | client-supplied-internal | - | 同上 |
| `docs/design/reference/index.html` | 设计参考页面 | client-supplied-internal | - | 同上 |
| `docs/design/reference/manifest.json` | 设计参考清单 | client-supplied-internal | - | 同上 |
| `docs/design/reference/projects.html` | 设计参考页面 | client-supplied-internal | - | 同上 |
| `public/media/curated/paper-arrow-steps.webp` | 内置插画 | proprietary-owned | orincard-synthesised-media | 纸艺静物原创图：折纸箭头与纸块，OpenAI ImageGen 生成，无第三方参考照片 |
| `public/media/curated/paper-crane-cards.webp` | 内置插画 | proprietary-owned | orincard-synthesised-media | 纸艺静物原创图：纸鹤与卡片堆，OpenAI ImageGen 生成，无第三方参考照片 |
| `public/media/curated/paper-lotus-sphere.webp` | 内置插画 | proprietary-owned | orincard-synthesised-media | 纸艺静物原创图：纸瓣与玻璃球，OpenAI ImageGen 生成，无第三方参考照片 |
| `public/media/templates/bold-hot-take-5475c4a75a81-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-hot-take 第 1 页的真实渲染，版本 5475c4a75a81 |
| `public/media/templates/bold-hot-take-5475c4a75a81-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-hot-take 第 2 页的真实渲染，版本 5475c4a75a81 |
| `public/media/templates/bold-hot-take-5475c4a75a81-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-hot-take 第 3 页的真实渲染，版本 5475c4a75a81 |
| `public/media/templates/bold-hot-take-5475c4a75a81-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-hot-take 第 4 页的真实渲染，版本 5475c4a75a81 |
| `public/media/templates/bold-launch-9709664b4948-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-launch 第 1 页的真实渲染，版本 9709664b4948 |
| `public/media/templates/bold-launch-9709664b4948-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-launch 第 2 页的真实渲染，版本 9709664b4948 |
| `public/media/templates/bold-launch-9709664b4948-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-launch 第 3 页的真实渲染，版本 9709664b4948 |
| `public/media/templates/bold-launch-9709664b4948-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-launch 第 4 页的真实渲染，版本 9709664b4948 |
| `public/media/templates/bold-statement-3243971dad4c-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-statement 第 1 页的真实渲染，版本 3243971dad4c |
| `public/media/templates/bold-statement-3243971dad4c-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-statement 第 2 页的真实渲染，版本 3243971dad4c |
| `public/media/templates/bold-statement-3243971dad4c-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-statement 第 3 页的真实渲染，版本 3243971dad4c |
| `public/media/templates/bold-statement-3243971dad4c-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 bold-statement 第 4 页的真实渲染，版本 3243971dad4c |
| `public/media/templates/clear-idea-59fc0cca0981-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 clear-idea 第 1 页的真实渲染，版本 59fc0cca0981 |
| `public/media/templates/clear-idea-59fc0cca0981-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 clear-idea 第 2 页的真实渲染，版本 59fc0cca0981 |
| `public/media/templates/clear-idea-59fc0cca0981-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 clear-idea 第 3 页的真实渲染，版本 59fc0cca0981 |
| `public/media/templates/clear-idea-59fc0cca0981-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 clear-idea 第 4 页的真实渲染，版本 59fc0cca0981 |
| `public/media/templates/education-breakdown-bd90d09d0502-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 education-breakdown 第 1 页的真实渲染，版本 bd90d09d0502 |
| `public/media/templates/education-breakdown-bd90d09d0502-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 education-breakdown 第 2 页的真实渲染，版本 bd90d09d0502 |
| `public/media/templates/education-breakdown-bd90d09d0502-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 education-breakdown 第 3 页的真实渲染，版本 bd90d09d0502 |
| `public/media/templates/education-breakdown-bd90d09d0502-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 education-breakdown 第 4 页的真实渲染，版本 bd90d09d0502 |
| `public/media/templates/education-breakdown-bd90d09d0502-5.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 education-breakdown 第 5 页的真实渲染，版本 bd90d09d0502 |
| `public/media/templates/launch-changelog-313cdf88061f-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 launch-changelog 第 1 页的真实渲染，版本 313cdf88061f |
| `public/media/templates/launch-changelog-313cdf88061f-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 launch-changelog 第 2 页的真实渲染，版本 313cdf88061f |
| `public/media/templates/launch-changelog-313cdf88061f-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 launch-changelog 第 3 页的真实渲染，版本 313cdf88061f |
| `public/media/templates/launch-changelog-313cdf88061f-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 launch-changelog 第 4 页的真实渲染，版本 313cdf88061f |
| `public/media/templates/launch-changelog-313cdf88061f-5.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 launch-changelog 第 5 页的真实渲染，版本 313cdf88061f |
| `public/media/templates/minimal-note-53cefed9a3d1-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 minimal-note 第 1 页的真实渲染，版本 53cefed9a3d1 |
| `public/media/templates/minimal-note-53cefed9a3d1-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 minimal-note 第 2 页的真实渲染，版本 53cefed9a3d1 |
| `public/media/templates/minimal-note-53cefed9a3d1-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 minimal-note 第 3 页的真实渲染，版本 53cefed9a3d1 |
| `public/media/templates/minimal-note-53cefed9a3d1-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 minimal-note 第 4 页的真实渲染，版本 53cefed9a3d1 |
| `public/media/templates/minimal-quote-e726c29d8d41-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 minimal-quote 第 1 页的真实渲染，版本 e726c29d8d41 |
| `public/media/templates/minimal-quote-e726c29d8d41-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 minimal-quote 第 2 页的真实渲染，版本 e726c29d8d41 |
| `public/media/templates/minimal-quote-e726c29d8d41-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 minimal-quote 第 3 页的真实渲染，版本 e726c29d8d41 |
| `public/media/templates/minimal-quote-e726c29d8d41-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 minimal-quote 第 4 页的真实渲染，版本 e726c29d8d41 |
| `public/media/templates/modern-brief-0e59b0a40af5-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 modern-brief 第 1 页的真实渲染，版本 0e59b0a40af5 |
| `public/media/templates/modern-brief-0e59b0a40af5-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 modern-brief 第 2 页的真实渲染，版本 0e59b0a40af5 |
| `public/media/templates/modern-brief-0e59b0a40af5-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 modern-brief 第 3 页的真实渲染，版本 0e59b0a40af5 |
| `public/media/templates/modern-brief-0e59b0a40af5-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 modern-brief 第 4 页的真实渲染，版本 0e59b0a40af5 |
| `public/media/templates/modern-brief-0e59b0a40af5-5.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 modern-brief 第 5 页的真实渲染，版本 0e59b0a40af5 |
| `public/media/templates/modern-metrics-397dcb4810c5-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 modern-metrics 第 1 页的真实渲染，版本 397dcb4810c5 |
| `public/media/templates/modern-metrics-397dcb4810c5-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 modern-metrics 第 2 页的真实渲染，版本 397dcb4810c5 |
| `public/media/templates/modern-metrics-397dcb4810c5-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 modern-metrics 第 3 页的真实渲染，版本 397dcb4810c5 |
| `public/media/templates/modern-metrics-397dcb4810c5-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 modern-metrics 第 4 页的真实渲染，版本 397dcb4810c5 |
| `public/media/templates/modern-metrics-397dcb4810c5-5.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 modern-metrics 第 5 页的真实渲染，版本 397dcb4810c5 |
| `public/media/templates/playful-checklist-6da37af4b8a0-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 playful-checklist 第 1 页的真实渲染，版本 6da37af4b8a0 |
| `public/media/templates/playful-checklist-6da37af4b8a0-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 playful-checklist 第 2 页的真实渲染，版本 6da37af4b8a0 |
| `public/media/templates/playful-checklist-6da37af4b8a0-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 playful-checklist 第 3 页的真实渲染，版本 6da37af4b8a0 |
| `public/media/templates/playful-checklist-6da37af4b8a0-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 playful-checklist 第 4 页的真实渲染，版本 6da37af4b8a0 |
| `public/media/templates/playful-checklist-6da37af4b8a0-5.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 playful-checklist 第 5 页的真实渲染，版本 6da37af4b8a0 |
| `public/media/templates/playful-myths-5612b5d114ad-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 playful-myths 第 1 页的真实渲染，版本 5612b5d114ad |
| `public/media/templates/playful-myths-5612b5d114ad-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 playful-myths 第 2 页的真实渲染，版本 5612b5d114ad |
| `public/media/templates/playful-myths-5612b5d114ad-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 playful-myths 第 3 页的真实渲染，版本 5612b5d114ad |
| `public/media/templates/playful-myths-5612b5d114ad-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 playful-myths 第 4 页的真实渲染，版本 5612b5d114ad |
| `public/media/templates/prism-launch-f1af3770a57b-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 prism-launch 第 1 页的真实渲染，版本 f1af3770a57b |
| `public/media/templates/prism-launch-f1af3770a57b-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 prism-launch 第 2 页的真实渲染，版本 f1af3770a57b |
| `public/media/templates/prism-launch-f1af3770a57b-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 prism-launch 第 3 页的真实渲染，版本 f1af3770a57b |
| `public/media/templates/prism-launch-f1af3770a57b-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 prism-launch 第 4 页的真实渲染，版本 f1af3770a57b |
| `public/media/templates/prism-launch-f1af3770a57b-5.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 prism-launch 第 5 页的真实渲染，版本 f1af3770a57b |
| `public/media/templates/pulse-briefing-89f19c410df8-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 pulse-briefing 第 1 页的真实渲染，版本 89f19c410df8 |
| `public/media/templates/pulse-briefing-89f19c410df8-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 pulse-briefing 第 2 页的真实渲染，版本 89f19c410df8 |
| `public/media/templates/pulse-briefing-89f19c410df8-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 pulse-briefing 第 3 页的真实渲染，版本 89f19c410df8 |
| `public/media/templates/pulse-briefing-89f19c410df8-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 pulse-briefing 第 4 页的真实渲染，版本 89f19c410df8 |
| `public/media/templates/pulse-briefing-89f19c410df8-5.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 pulse-briefing 第 5 页的真实渲染，版本 89f19c410df8 |
| `public/media/templates/story-lessons-b1f1f74012d1-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 story-lessons 第 1 页的真实渲染，版本 b1f1f74012d1 |
| `public/media/templates/story-lessons-b1f1f74012d1-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 story-lessons 第 2 页的真实渲染，版本 b1f1f74012d1 |
| `public/media/templates/story-lessons-b1f1f74012d1-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 story-lessons 第 3 页的真实渲染，版本 b1f1f74012d1 |
| `public/media/templates/story-lessons-b1f1f74012d1-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 story-lessons 第 4 页的真实渲染，版本 b1f1f74012d1 |
| `public/media/templates/vertical-story-dd1695059afa-1.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 vertical-story 第 1 页的真实渲染，版本 dd1695059afa |
| `public/media/templates/vertical-story-dd1695059afa-2.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 vertical-story 第 2 页的真实渲染，版本 dd1695059afa |
| `public/media/templates/vertical-story-dd1695059afa-3.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 vertical-story 第 3 页的真实渲染，版本 dd1695059afa |
| `public/media/templates/vertical-story-dd1695059afa-4.webp` | 模板预览图 | proprietary-owned | orincard-synthesised-media | `scripts/render-template-previews.mjs` 截取模板 vertical-story 第 4 页的真实渲染，版本 dd1695059afa |
| `tests/fixtures/base-document.json` | 验收夹具 | proprietary-owned | orincard-editorial-copy | 团队撰写的样例文档，git 历史即出处 |
| `tests/fixtures/corpus.json` | 验收夹具 | proprietary-owned | orincard-editorial-copy | T090 素材清单，每条自带 `rightsId` |
| `tests/fixtures/rights.json` | 权利登记表 | proprietary-owned | - | 登记表本身由团队维护，不含第三方素材 |

三点必须随表一起读：

1. **`avatar-elena.jpg` 的出处由产品所有者答复闭合，不是由文件本身证明。** 同目录的 `credits.json` 记 6 条而目录里有 7 张 jpg，少的就是它；EXIF 只有 Photoshop 痕迹，没有来源信息。本文件此前给的处置建议是「删除该文件」，**那条建议不可行**：它在 `docs/design/reference/manifest.json` 里有 SHA-256 锁，且被 5 个 `reference/` 页与 3 个 `prototype/` 页引用，删它会同时破锁和破 8 个页面。实际闭合方式是路线图 B-3：产品所有者 2026-09-12 书面确认它与 `orincard.css` 及 5 个 HTML 同批来自 Open Design 项目 `9d82ca96-…` 的导出，人像为 AI 生成或持有肖像授权，因此按 `client-supplied-internal` 登记。**证据强度是「所有者声明」而非可核对的上游 URL**，与其余六张 CC BY 图片不同；若该文件日后要进入产品界面或对外分发，必须重新取证。`credits.json` 受锁，补不了第 7 条，登记只落在本表。
2. **六张 CC BY 2.0 图片带署名义务。** 任何再分发（含把 `docs/design/reference/` 打包交付）必须同时保留 `credits.json` 里的作者、标题与许可字段。它们只是设计参考，不进产品构建；一旦被引入产品界面，需重新按 CC BY 的署名位置要求审查。
3. **`client-supplied-internal` 的含义是「出处清楚、但未获对外再分发授权」。** 这批文件是用户在 2026-09-04 指定的设计快照的原样副本，供内部迁移比对使用，不随产品分发，也不得单独对外发布。

## 2. 字体（随构建分发，文件来自 npm 包）

| id | 家族 | npm 包 | 许可 | 校验 |
|---|---|---|---|---|
| `inter-latin-variable` | Inter | `@fontsource-variable/inter@5.3.0` | SIL OFL 1.1 | `src/render/font-manifest.json` 记录 SHA-256，装载前校验 |
| `source-serif-4-latin-variable` | Source Serif 4 | `@fontsource-variable/source-serif-4@5.3.0` | SIL OFL 1.1 | 同上 |
| `jetbrains-mono-latin-variable` | JetBrains Mono | `@fontsource-variable/jetbrains-mono@5.3.0` | SIL OFL 1.1 | 同上 |
| `noto-sans-sc-simplified-400` | Noto Sans SC | `@fontsource/noto-sans-sc@5.3.0` | SIL OFL 1.1 | 同上 |
| `noto-sans-sc-simplified-700` | Noto Sans SC | `@fontsource/noto-sans-sc@5.3.0` | SIL OFL 1.1 | 同上 |

同一家族的不同字重是独立的二进制文件，因此逐个登记：Noto Sans SC 的 400 与 700 各占一行。700 是 S18 为中文标题补的——只嵌 400 时浏览器会合成伪粗体，和 PPTX 里 PowerPoint 解析出的真 Bold 对不上。

字体二进制不在 Git 里，随构建从 npm 包取，因此不出现在第 1 节。守卫比对的是 `src/render/font-manifest.json` 的 `id` 集合与本表，多一个或少一个都失败。重新分发字体文件时必须一并保留各包的 `LICENSE`；裁剪、转格式或做衍生字体需重新审查 OFL 的 Reserved Font Name 条件。

## 3. 权利条目对照（对齐 tests/fixtures/rights.json）

| rightsId | license | redistribution | 用途 |
|---|---|---|---|
| `orincard-editorial-copy` | proprietary-owned | internal-acceptance-only | 团队为验收写的短文案，内联在 corpus 里 |
| `orincard-repo-content` | proprietary-owned | public | 仓库内的长文与法务页面，本项目自己的出版物 |
| `orincard-hosted-page` | proprietary-owned | public | 抓取的是 Orincard 自己的部署路由，不是第三方站点 |
| `orincard-adversarial-input` | proprietary-owned | internal-acceptance-only | 团队构造的恶意字符串与压缩包，用于触发自家防护 |
| `orincard-synthesised-media` | proprietary-owned | internal-acceptance-only | 由自有文本本地渲染出的 PDF/PPTX/音频/视频产物 |
| `no-material-ingested` | not-applicable-nothing-read | internal-acceptance-only | 观看页与 SSRF 目标：取字节之前就被判定拒绝，没有素材被读入 |

守卫对本表与 `tests/fixtures/rights.json` 做双向集合比较，并逐条比对 `license` 与 `redistribution` 字符串，任一不一致即失败。`rights.json` 属于 T090，本文件只做对照，不改它。第 1 节里 rightsId 写 `-` 表示该文件不由 `rights.json` 覆盖，其许可由该行自身的许可列与证据列承担。

## 4. 模型资格

| 模型 | 供应商 | 用途 | 商用资格 | 数据留存 |
|---|---|---|---|---|
| `deepseek-v4-pro` | DeepSeek（`https://api.deepseek.com`） | 结构化文案生成与文本工具，见 `src/server/ai.ts` | 商用 API，按调用计费，输出可商用 | 调用固定 `store:false`；返回仍经本地 Zod/domain 校验，不接受空成功 |
| `volc.seedasr.auc` | 火山引擎豆包录音文件识别模型 2.0 | 无字幕视频的分段转写，见 `src/server/sources/transcribe.ts` | 商用 API，按时长计费 | 只传临时签名 URL 供供应商拉取；数据库仅保存 HMAC 元数据，不落原文 |
| `gpt-image-2` | APIMart（`https://api.apimart.ai`） | AI 配图与视觉工具候选图，见 `src/server/assets/ai-image.ts`、`src/trigger/visual-tool.ts` | 商用 API，按张计费；产出图片登记在素材 `rights` 字段并需用户显式接受 | 提示词与候选状态存在素材行的 `rights` 里；预算由 `AI_MONTHLY_BUDGET_USD` 原子扣减 |

守卫从 `src/**/*.ts` 里抽取实际写死的模型标识（`model:` / `resourceId:` 字面量、`AI_*_MODEL` 常量、`process.env.AI_*_MODEL ?? "…"` 的兜底值），与本表做双向比对：出现未登记模型失败，本表登记了代码已不再调用的模型也失败。

`AI_TEXT_MODEL` 与 `AI_TRANSCRIBE_MODEL` 可由环境变量覆盖。**覆盖成一个未登记的模型不会被本守卫拦住**——守卫读的是代码，读不到运行环境。运维侧的约束写在 [../acceptance/security.md](../acceptance/security.md)。

## 5. 第三方矢量素材（随构建内联，文件来自 GitHub）

| id | 来源 | commit | 文件数 | 许可 | 需署名 | 产物 |
|---|---|---|---|---|---|---|
| `tabler-icons` | [tabler/tabler-icons](https://github.com/tabler/tabler-icons) | `55f87a73f45cf1d9eaf16d7da705065483a9e4f9` | 226 | MIT | 否 | `src/assets/generated/tabler-icons.ts` |
| `boring-avatars` | [boringdesigners/boring-avatars](https://github.com/boringdesigners/boring-avatars) | `d0ff2582a8921b643a89de4a4912be28938a828b` | 8 | MIT | 否 | `src/assets/generated/boring-avatars.tsx` |

`boring-avatars` 收的不是图，是**生成器**：上游每种画风一个 React 组件，按传入的 `name` 种子确定性地算出一张 SVG。矢量主题的图形层（`src/render/motif.tsx`）用它，颜色传 `var(--motif-1…5)`，所以同一个图形换主题就换色。上游六种画风里只放行五种，`beam` 画的是人脸、不是底纹，`src/render/motifs.ts` 有意不列它。

与 Tabler 那条不同的是，这个转换需要把多个源文件拼成一个模块，而每个文件都各自声明了同名的 `SIZE` / `ELEMENTS` / `generateColors`。脚本的做法是把每个文件的函数体原样包进一个 IIFE（只删 `import` 行、把 `export default X` 改成 IIFE 的返回值），**不改上游代码的字节**——`sha256` 校验的就是那些字节。

本项目只收**免署名**许可：CC0-1.0 / MIT / Apache-2.0 / ISC / OFL-1.1。白名单写在 `src/assets/vendor-manifest.json` 的 `allowedLicenses`，`scripts/vendor-assets.mjs` 在下载之前就按它判定，`src/assets/vendor.ts` 的 `assertVendorLicense()` 在代码侧重复同一判定；GPL/AGPL/LGPL 不是「没列进来」，是**必须一直不在里面**（`tests/unit/vendor-assets.test.ts` 逐条钉住）。

来源固定到 40 位 commit sha 而不是 tag——tag 可以被指到别的字节上。归档包本身有 `archiveSha256`，包内每个文件另有自己的 SHA-256，两层都在生成产物之前校验，任一不符即抛错（`ASSET_HASH_MISMATCH` / `ARCHIVE_HASH_MISMATCH`）。

上游许可原文随仓库分发在 `docs/licenses/vendor/<id>-LICENSE.txt`，由脚本从归档包里抄出，不手写。

这些素材**不以图片文件形式进 Git**：脚本把上游代码生成成 TypeScript 模块，渲染时内联成 `<svg>`，颜色走 CSS 变量（图标是 `currentColor`，motif 是 `var(--motif-1…5)`）。因此它们和字体一样不出现在第 1 节，也不受 `assertLocalAssets`（`src/render/render-deck.ts`）的外链限制。
