# B05 多来源验收记录

状态：`PASS — T038–T044 已在开发环境完成真实验收`

记录日期：2026-09-08

本记录覆盖 Topic、Text、URL、PDF、Slides 与 Video 六类来源。数据库成本闸门、Trigger.dev 容器构建、直传、URL、PDF、Slides、豆包真实语音转写、B04 回归和六来源 E2E 已在开发环境真实通过。

## 已取得的云端证据

| 检查 | 结果 |
|---|---|
| Supabase 项目 | 仅开发项目 `orincard-dev` / `ettuzeunkadkfnawawdy`；未接触生产项目 |
| B05 初始迁移 | `20260907171424_b05.sql` 已存在于云端迁移账本，不再修改 |
| 成本闸门补丁 | `20260908110457_b05_parse_budget.sql` 已应用到开发项目 |
| B05 pgTAP | 补丁应用后 `supabase/tests/b05.sql` 72/72 通过 |
| Supabase 安全顾问 | **1 项 WARN**：泄露密码保护尚未开启；不得记为 0 |
| Supabase 性能顾问 | 当前 **9 项 INFO**，为空库索引未使用提示；按本次实际复核值记录 |
| Trigger 项目 / 环境 | `proj_bhwgeecxnhxxjrkmdqvh` / 专用开发项目的 Production 环境 |
| 最终干净部署 | `20260908.7` / `6zsylkb9`，构建成功并同步 2 个加密转写变量；[部署详情](https://cloud.trigger.dev/projects/v3/proj_bhwgeecxnhxxjrkmdqvh/deployments/6zsylkb9) |
| T038 直传与文件验证 | 21/21 通过 |
| T039 URL 与 SSRF | 40/40 通过；公开探针为 IANA example domains 说明页 |
| T040 PDF 与受限 OCR | 24/24 通过 |
| T041 PPTX | 29/29 通过 |
| T042 视频与真实豆包转写 | 34/34 通过；模型 `volc.seedasr.auc` |
| B04 文本源回归 | 10/10 通过 |
| B04 生成任务回归 | 19/19 通过 |
| T044 六来源 E2E | 2/2 通过；无字幕语音视频经 Trigger 和豆包转写，真实综合用例约 1.5 分钟 |
| T044 远程 pgTAP | 经 IPv4 session pooler 连接开发库，72/72 通过 |

`server_claim_source_parse` 在文件读取和供应商请求前原子创建 `jobs(kind='parse')`。PDF 与 Slides 预留 0；Video 使用 `[UNVERIFIED-NUMBER]` 1,000,000 微美元保守预留。`server_start_source_transcription` 在每个真实请求前记录唯一数字音段，`server_finalize_source_parse_job` 按 lease 同时终结来源、任务与成本预留。解析流程不写用户 `usage_ledger`；供应商请求已发送但成本未知时保留预算头寸等待对账。

## Trigger 容器解析器版本

以下版本来自同一 `node-22` / Debian bookworm 基础镜像的强制重建日志；诊断依赖随后撤销，最终 `20260908.7` 使用原始六包配置重新构建成功。

| Debian 包 | 版本 |
|---|---|
| `poppler-utils` | `22.12.0-2+deb12u3` |
| `tesseract-ocr` | `5.3.0-2` |
| `tesseract-ocr-eng` | `1:4.1.0-2` |
| `tesseract-ocr-chi-sim` | `1:4.1.0-2` |
| `qpdf` | `11.3.0-1+deb12u1` |
| `ffmpeg` | `7:5.1.9-0+deb12u1` |

许可与调用边界见 [`docs/licenses/parsers.md`](../licenses/parsers.md)。

## 已完成的本地验证

| 检查 | 结果 |
|---|---|
| `pnpm typecheck` | 通过 |
| `pnpm test` | 20 个文件；167 passed / 5 skipped |
| `pnpm test:planning` | 19/19 通过 |
| B05 定向测试 | 6 个文件通过、1 个 live-only 文件整体跳过；138 passed / 16 skipped |
| T043 UI + T044 worker 边界 | 17/17 通过 |
| `tests/e2e/sources.spec.ts --list` | 2 条用例成功收集；真实用例由 `ORINCARD_RUN_SOURCES_E2E=1` 守门 |

聚合 `pnpm test:cloud` 在没有 `RUN_CLOUD_PROBES=1` 时按设计由 B01 三个保护断言失败；本次没有把该失败改成 skip，也没有将其记为 B05 通过。

## 转写供应商与数据边界

视频无字幕时由 ffmpeg 提取 MP3 分片，写入私有 `sources` bucket 的临时路径并生成 10 分钟签名 URL。豆包录音文件识别模型 2.0 拉取后，worker 查询异步结果并在成功或失败时删除临时对象。供应商返回的毫秒时间戳转换为来源内绝对秒数；API Key 只保存在本地环境和 Trigger 加密变量中。

按 2026-09-08 官方计费文档，模型 2.0 后付费为 0.8 元/小时。数据库仍使用保守的未核实美元预留，在供应商未返回可核实成本时保持 `unknown`，不伪造实际成本。

## 已知限制

| 项 | 说明 |
|---|---|
| URL 端口与跳转 | 仅允许 80/443，最终 URL 必须为 HTTPS；每次 DNS 解析、连接地址及每一跳重定向均重校验 |
| PPTX 外链 | 外部图片关系会计数后丢弃，不把远端资源取回或保存为来源内容 |
| 资产媒体属性 | B05 验证后的 `width`、`height`、`duration_ms` 仍写 `null` |
| 解析任务进程中断 | worker 已领取 parse job 后若进程在 finalization 前消失，现有通用 reconciler 没有该 Trigger run 的 `provider_run_id`，不能自动重新派发；正常异常会在 worker 内转为安全失败并结算，但硬中断恢复仍待后续修复 |
| 视频成本 | 真实转录请求只有数字音段审计；供应商未返回可核实成本时 reservation/attempt 保持 `unknown`，不得伪造实际成本 |
