# Orincard 来源解析工具清单

状态：B05 依赖基线，2026-09-08。适用任务 T040（PDF 文字层与受限 OCR）、T041（PPTX 来源解析）、T042（合法视频与分段转录）。

结论先行：**B05 的来源解析没有新增任何 npm 依赖。** PDF/OCR 与视频走容器内的系统可执行文件，PPTX 走仓库里已有的 `jszip@3.10.1` 加一个手写的受限 XML 读取器，转录直接用 `fetch` 调 OpenAI 的 HTTP 接口而非再装一个 SDK。`pnpm-lock.yaml` 在本批次不变。

## 1. 系统可执行文件（`trigger.config.ts` 的 `aptGet`）

| 用途 | 可执行文件 | 上游 | 许可 | 快照 |
|---|---|---|---|---|
| PDF 加密判定与页数 | `pdfinfo` | [poppler](https://gitlab.freedesktop.org/poppler/poppler) | GPL-2.0-or-later | 上游 2026-09-07 仍活跃 |
| PDF 文字层提取 | `pdftotext` | 同上 | GPL-2.0-or-later | 同上 |
| 扫描页栅格化 | `pdftoppm` | 同上 | GPL-2.0-or-later | 同上 |
| 扫描页 OCR | `tesseract` | [tesseract-ocr/tesseract](https://github.com/tesseract-ocr/tesseract) | Apache-2.0 | 76384 stars，2026-09-02 push |
| OCR 语言模型 | `tesseract-ocr-eng`、`tesseract-ocr-chi-sim` | [tesseract-ocr/tessdata](https://github.com/tesseract-ocr/tessdata_fast) | Apache-2.0 | 模型仓库 2024-08-01 push |
| PDF 附件恢复（B01 起既有） | `qpdf` | [qpdf/qpdf](https://github.com/qpdf/qpdf) | Apache-2.0 | 5373 stars，2026-08-30 push |
| 视频时长与流探测 | `ffprobe` | [FFmpeg](https://ffmpeg.org/) | 见第 2 节 | 本机 8.1.1 |
| 字幕轨提取与音轨切段 | `ffmpeg` | 同上 | 见第 2 节 | 同上 |

Debian 包的确切版本由镜像构建固定，首次部署后从构建日志回填，不在此预先填写。

## 2. copyleft 审查（poppler 与 ffmpeg）

poppler 是本清单里最早的 copyleft 组件（实查 GPL-2.0+，非 AGPL）。当前用法：Trigger.dev worker 容器内以独立进程调用命令行工具，通过文件与标准输出交换数据，**不链接 poppler 的库，也不把容器镜像分发给第三方**。GPL 的义务附着于分发（conveying），对外提供网络服务不构成分发，poppler 也不含 AGPL 的网络条款，因此当前形态不产生源码开放义务。

这个结论依赖两个前提，任一改变都必须重新审查：把 poppler 以库形式链接进 Orincard 代码，或把包含 poppler 的镜像/桌面产物交付给用户。届时的退路是把文字层与页数改用 `pdfjs-dist`（Apache-2.0），栅格化改用其它 Apache/MIT 方案，OCR 侧无需变动（tesseract 本身是 Apache-2.0）。

ffmpeg 的许可取决于构建选项而非项目本身：库默认 LGPL-2.1+，一旦以 `--enable-gpl` 打开 GPL 组件，产出的命令行工具即为 GPL-2+（本机 Homebrew 的 8.1.1 正是这种构建，`--enable-gpl --enable-version3`）。容器里装的是 Debian 的 `ffmpeg` 包，同为 GPL 构建，而**不是** `ffmpeg-full` 之类含 nonfree 的变体——nonfree 构建不可再分发，那才是真正的红线。用法与 poppler 完全同形：独立进程、管道交换字节、不链接、不分发镜像，因此结论一致，且前述两个前提同样适用。退路是把探测与切段换成 LGPL 构建的 ffmpeg（去掉 `--enable-gpl`，本用法只需要解复用、mp3 编码与 webvtt 输出，不依赖 GPL 组件），代码无需改动。

第三条边界是**素材本身的权利**，与许可无关：[processing.md](../sdd/orincard/contracts/processing.md) 规定只处理用户有权提供且可合法读取的文件、字幕与直链，因此 `classifyVideoUrl` 把 YouTube、Bilibili 等观看页判为 `SOURCE_BLOCKED` 并给出上传或粘贴文字稿的替代动作，而不是尝试抓取。

## 3. 未采用的方案与理由

| 方案 | 不采用的原因 |
|---|---|
| `tesseract.js`（Apache-2.0，38694 stars，2026-05-17 push） | [research.md](../sdd/orincard/research.md) 最初记为扫描页 OCR 的候选。默认在**任务运行时**从 CDN 拉取 wasm core 与 `*.traineddata`；改为自托管就要把中文模型这类大二进制提交进 git 并经 `additionalFiles` 送进容器，正是 B04 在字体与样式表上踩过的那类坑。容器体积是本批次的硬指标，因此改走 apt |
| `pdfjs-dist`（Apache-2.0） | 单独用它只解决文字层、页数与加密三项，扫描页栅格化仍需 canvas 原生模块或 poppler。为省一个 GPL 的命令行工具而引入原生编译依赖并不划算；保留为第 2 节所述的许可退路 |
| 云端 OCR 服务 | 当前只确认了 `OPENAI_API_KEY` 一项外部能力，走视觉模型 OCR 会挤占 `AI_MONTHLY_BUDGET_USD=10` 这同一份预算（还要与文本生成、图片、转录共享），且给「受限 OCR」增加一条网络失败路径。本地进程更可控 |
| `fflate` | research.md 的原始候选，但仓库里已经装了 `jszip@3.10.1` 并在用。多装一个 ZIP 库没有收益 |
| `yt-dlp` / `youtube-dl` | 能下载观看页，但 processing.md 明确「不承诺任意 YouTube URL」，抓取受站点条款约束且与用户是否拥有该内容无关。装上它等于把一条我们无权走的路留在容器里，因此不装：平台链接在 `classifyVideoUrl` 里直接判为 `SOURCE_BLOCKED` |
| `fluent-ffmpeg` 之类的 npm 封装 | 只是拼参数的外壳，仍要求容器里有 ffmpeg 本体，却多一层参数转义面。`src/server/sources/ocr.ts` 的 `runCommand` 已经是本仓库统一的进程边界，直接复用 |
| `openai` npm SDK 走转录 | 依赖已在仓库里（B04 的文本生成在用），但转录只是一个 multipart POST；直接 `fetch` 让超时、状态码到 `TranscriptionError` 的映射留在我们自己手里，也不必迁就 SDK 对 `response_format` 的默认值 |
| 任何 XML 解析库 | T041 的 Expect 明确要求拒绝 XXE。不引入解析器就没有实体展开面：改为手写受限读取器，只识别 PPTX 需要的元素，遇到 DOCTYPE、实体声明、外部引用一律判为非法来源并报错，不做静默降级 |

## 4. 本机先决条件

`pdftotext`、`pdfinfo`、`pdftoppm`、`tesseract` 在容器里由 apt 提供，在开发机上不会自动出现。缺失时 `tests/cloud/pdf.test.ts` 必须显式失败并报出缺少的可执行文件名，**不得 skip 后当作通过**——与 tasks.md 对缺少云端凭据的处理规则一致。

`tests/cloud/video.test.ts` 同理，且门槛更高：除了 `ffprobe`、`ffmpeg`，它还点名 `OPENAI_API_KEY` 与 `AI_TRANSCRIBE_MODEL`，缺任一项都在 `beforeAll` 抛错。这条用例用 macOS 的 `say` 合成一句真实语音、经 ffmpeg 封进 mp4，再走真实转录断言识别结果里含 "carousel"——用静音文件顶替就成了「转录从未发生却记为通过」，正是 processing.md 禁止的那种事实。

macOS 安装：`brew install poppler tesseract tesseract-lang ffmpeg`。当前开发机已具备 `pdftotext 26.04.0`、`tesseract 5.5.2` 与 `ffmpeg/ffprobe 8.1.1`。`qpdf` 本机缺失但仅被容器内的 `src/trigger/probe.ts` 使用，因此 PDF 来源解析刻意用 `pdfinfo` 而非 `qpdf` 判定加密，避免新增一项本机先决条件。
