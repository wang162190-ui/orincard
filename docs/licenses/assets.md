# Orincard 素材许可清单

状态：T088 发布前许可核对，2026-09-11。

这份清单是 `tests/cloud/release-guards.test.ts` 的数据源，不是说明文档：表格的列位置被测试直接读取，改列序会让守卫失效。守卫的判定规则是「缺条目即失败、条目写着未知即失败」，因此本文件里出现「未知」是一个**真实的发布阻塞项**，不是占位符。

字体软件许可另见 [fonts.md](fonts.md)；来源解析工具与 copyleft 审查另见 [parsers.md](parsers.md)。本文件覆盖的是随仓库分发的素材文件、字体登记、权利条目对照与模型资格。

## 1. 随仓库分发的素材文件

| 路径 | 类别 | 许可 | rightsId | 证据 |
|---|---|---|---|---|
| `content/templates.json` | 模板 | proprietary-owned | orincard-editorial-copy | 团队为 T012 撰写的模板文案与版式，git 历史即出处 |
| `docs/design/reference/assets/img/avatar-elena.jpg` | 设计参考图 | 未知 | - | 无 |
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
| `tests/fixtures/base-document.json` | 验收夹具 | proprietary-owned | orincard-editorial-copy | 团队撰写的样例文档，git 历史即出处 |
| `tests/fixtures/corpus.json` | 验收夹具 | proprietary-owned | orincard-editorial-copy | T090 素材清单，每条自带 `rightsId` |
| `tests/fixtures/rights.json` | 权利登记表 | proprietary-owned | - | 登记表本身由团队维护，不含第三方素材 |

三点必须随表一起读：

1. **`avatar-elena.jpg` 是当前唯一的未知项。** 同目录的 `credits.json` 记了 6 条，而目录里有 7 张 jpg，这一张没有对应条目，无法核对作者、来源 URL 与许可。它是一张人像，未知许可的人像风险高于风景图。闭合方式只有两条：补齐可核对的上游出处（Wikimedia 页面或原始授权），或删除该文件并改用已登记的图片。**在此之前 T088 不能勾选**，守卫会持续失败，这是正确结果。
2. **六张 CC BY 2.0 图片带署名义务。** 任何再分发（含把 `docs/design/reference/` 打包交付）必须同时保留 `credits.json` 里的作者、标题与许可字段。它们只是设计参考，不进产品构建；一旦被引入产品界面，需重新按 CC BY 的署名位置要求审查。
3. **`client-supplied-internal` 的含义是「出处清楚、但未获对外再分发授权」。** 这批文件是用户在 2026-09-04 指定的设计快照的原样副本，供内部迁移比对使用，不随产品分发，也不得单独对外发布。

## 2. 字体（随构建分发，文件来自 npm 包）

| id | 家族 | npm 包 | 许可 | 校验 |
|---|---|---|---|---|
| `inter-latin-variable` | Inter | `@fontsource-variable/inter@5.3.0` | SIL OFL 1.1 | `src/render/font-manifest.json` 记录 SHA-256，装载前校验 |
| `source-serif-4-latin-variable` | Source Serif 4 | `@fontsource-variable/source-serif-4@5.3.0` | SIL OFL 1.1 | 同上 |
| `noto-sans-sc-simplified-400` | Noto Sans SC | `@fontsource/noto-sans-sc@5.3.0` | SIL OFL 1.1 | 同上 |

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
