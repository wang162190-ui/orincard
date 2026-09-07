# Orincard 来源解析工具清单

状态：B05 依赖基线，2026-09-08。适用任务 T040（PDF 文字层与受限 OCR）、T041（PPTX 来源解析）。

结论先行：**B05 的来源解析没有新增任何 npm 依赖。** PDF 与 OCR 走容器内的系统可执行文件，PPTX 走仓库里已有的 `jszip@3.10.1` 加一个手写的受限 XML 读取器。`pnpm-lock.yaml` 在本批次不变。

## 1. 系统可执行文件（`trigger.config.ts` 的 `aptGet`）

| 用途 | 可执行文件 | 上游 | 许可 | 快照 |
|---|---|---|---|---|
| PDF 加密判定与页数 | `pdfinfo` | [poppler](https://gitlab.freedesktop.org/poppler/poppler) | GPL-2.0-or-later | 上游 2026-09-07 仍活跃 |
| PDF 文字层提取 | `pdftotext` | 同上 | GPL-2.0-or-later | 同上 |
| 扫描页栅格化 | `pdftoppm` | 同上 | GPL-2.0-or-later | 同上 |
| 扫描页 OCR | `tesseract` | [tesseract-ocr/tesseract](https://github.com/tesseract-ocr/tesseract) | Apache-2.0 | 76384 stars，2026-09-02 push |
| OCR 语言模型 | `tesseract-ocr-eng`、`tesseract-ocr-chi-sim` | [tesseract-ocr/tessdata](https://github.com/tesseract-ocr/tessdata_fast) | Apache-2.0 | 模型仓库 2024-08-01 push |
| PDF 附件恢复（B01 起既有） | `qpdf` | [qpdf/qpdf](https://github.com/qpdf/qpdf) | Apache-2.0 | 5373 stars，2026-08-30 push |

Debian 包的确切版本由镜像构建固定，首次部署后从构建日志回填，不在此预先填写。

## 2. poppler 的 GPL 审查

poppler 是本清单里唯一的 copyleft 组件（实查 GPL-2.0+，非 AGPL）。当前用法：Trigger.dev worker 容器内以独立进程调用命令行工具，通过文件与标准输出交换数据，**不链接 poppler 的库，也不把容器镜像分发给第三方**。GPL 的义务附着于分发（conveying），对外提供网络服务不构成分发，poppler 也不含 AGPL 的网络条款，因此当前形态不产生源码开放义务。

这个结论依赖两个前提，任一改变都必须重新审查：把 poppler 以库形式链接进 Orincard 代码，或把包含 poppler 的镜像/桌面产物交付给用户。届时的退路是把文字层与页数改用 `pdfjs-dist`（Apache-2.0），栅格化改用其它 Apache/MIT 方案，OCR 侧无需变动（tesseract 本身是 Apache-2.0）。

## 3. 未采用的方案与理由

| 方案 | 不采用的原因 |
|---|---|
| `tesseract.js`（Apache-2.0，38694 stars，2026-05-17 push） | [research.md](../sdd/orincard/research.md) 最初记为扫描页 OCR 的候选。默认在**任务运行时**从 CDN 拉取 wasm core 与 `*.traineddata`；改为自托管就要把中文模型这类大二进制提交进 git 并经 `additionalFiles` 送进容器，正是 B04 在字体与样式表上踩过的那类坑。容器体积是本批次的硬指标，因此改走 apt |
| `pdfjs-dist`（Apache-2.0） | 单独用它只解决文字层、页数与加密三项，扫描页栅格化仍需 canvas 原生模块或 poppler。为省一个 GPL 的命令行工具而引入原生编译依赖并不划算；保留为第 2 节所述的许可退路 |
| 云端 OCR 服务 | 当前只确认了 `OPENAI_API_KEY` 一项外部能力，走视觉模型 OCR 会挤占 `AI_MONTHLY_BUDGET_USD=10` 这同一份预算（还要与文本生成、图片、转录共享），且给「受限 OCR」增加一条网络失败路径。本地进程更可控 |
| `fflate` | research.md 的原始候选，但仓库里已经装了 `jszip@3.10.1` 并在用。多装一个 ZIP 库没有收益 |
| 任何 XML 解析库 | T041 的 Expect 明确要求拒绝 XXE。不引入解析器就没有实体展开面：改为手写受限读取器，只识别 PPTX 需要的元素，遇到 DOCTYPE、实体声明、外部引用一律判为非法来源并报错，不做静默降级 |

## 4. 本机先决条件

`pdftotext`、`pdfinfo`、`pdftoppm`、`tesseract` 在容器里由 apt 提供，在开发机上不会自动出现。缺失时 `tests/cloud/pdf.test.ts` 必须显式失败并报出缺少的可执行文件名，**不得 skip 后当作通过**——与 tasks.md 对缺少云端凭据的处理规则一致。

macOS 安装：`brew install poppler tesseract tesseract-lang`。当前开发机已具备 `pdftotext 26.04.0` 与 `tesseract 5.5.2`。`qpdf` 本机缺失但仅被容器内的 `src/trigger/probe.ts` 使用，因此 PDF 来源解析刻意用 `pdfinfo` 而非 `qpdf` 判定加密，避免新增一项本机先决条件。
