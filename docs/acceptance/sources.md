# B05 多来源验收记录

状态：`PENDING — 云端来源检查尚未完成，T038–T044 不勾选`

记录日期：2026-09-08

本记录覆盖 Topic、Text、URL、PDF、Slides 与 Video 六类来源。当前已完成数据库成本闸门、Trigger.dev 容器构建和本地回归；真实开发库的直传、URL、PDF、Slides、视频转录及六来源 E2E 仍需在用户终端注入凭据后串行执行。未运行的检查不计为通过。

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
| 最终干净部署 | `20260908.5` / `om5z7gf6`，构建成功；[部署详情](https://cloud.trigger.dev/projects/v3/proj_bhwgeecxnhxxjrkmdqvh/deployments/om5z7gf6) |

`server_claim_source_parse` 在文件读取和供应商请求前原子创建 `jobs(kind='parse')`。PDF 与 Slides 预留 0；Video 使用 `[UNVERIFIED-NUMBER]` 1,000,000 微美元保守预留。`server_start_source_transcription` 在每个真实请求前记录唯一数字音段，`server_finalize_source_parse_job` 按 lease 同时终结来源、任务与成本预留。解析流程不写用户 `usage_ledger`；供应商请求已发送但成本未知时保留预算头寸等待对账。

## Trigger 容器解析器版本

以下版本来自同一 `node-22` / Debian bookworm 基础镜像的强制重建日志；诊断依赖随后撤销，最终 `20260908.5` 使用原始六包配置重新构建成功。

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

## 尚未取得的证据

当前 Codex 进程只检查变量是否存在，未读取或打印任何值。Supabase URL/keys、测试账号、Trigger key、URL probe、`OPENAI_API_KEY` 与 `AI_TRANSCRIBE_MODEL` 均未注入当前进程，因此以下命令尚未真实执行：

1. T038：`ORINCARD_RUN_UPLOADS_CLOUD=1 pnpm exec vitest run tests/cloud/uploads.test.ts`
2. T039：`ORINCARD_RUN_URL_SOURCE_CLOUD=1 pnpm exec vitest run tests/unit/ssrf.test.ts tests/cloud/url.test.ts`
3. T040：`ORINCARD_RUN_PDF_CLOUD=1 pnpm exec vitest run tests/cloud/pdf.test.ts`
4. T041：`ORINCARD_RUN_SLIDES_CLOUD=1 pnpm exec vitest run tests/cloud/slides.test.ts`
5. B04 回归：`ORINCARD_RUN_TEXT_SOURCE_CLOUD=1 pnpm exec vitest run tests/cloud/text-source.test.ts`
6. B04 回归：`ORINCARD_RUN_GENERATION_JOB_CLOUD=1 pnpm exec vitest run tests/cloud/generation-job.test.ts`
7. T042：`ORINCARD_RUN_VIDEO_CLOUD=1 pnpm exec vitest run tests/cloud/video.test.ts`
8. T044：`ORINCARD_RUN_SOURCES_E2E=1 pnpm exec playwright test tests/e2e/sources.spec.ts`

这些检查必须在开发环境中按上述顺序串行运行。T042 使用真实语音与 OpenAI 转录；缺少 `OPENAI_API_KEY` 或模型名会显式失败。T044 的真实用例创建六类合法来源、解析一个损坏 PDF、检查私网 URL 的替代动作，并断言四个解析任务没有任何用户额度流水。

## 已知限制

| 项 | 说明 |
|---|---|
| URL 端口与跳转 | 仅允许 80/443，最终 URL 必须为 HTTPS；每次 DNS 解析、连接地址及每一跳重定向均重校验 |
| PPTX 外链 | 外部图片关系会计数后丢弃，不把远端资源取回或保存为来源内容 |
| 资产媒体属性 | B05 验证后的 `width`、`height`、`duration_ms` 仍写 `null` |
| 解析任务进程中断 | worker 已领取 parse job 后若进程在 finalization 前消失，现有通用 reconciler 没有该 Trigger run 的 `provider_run_id`，不能自动重新派发；正常异常会在 worker 内转为安全失败并结算，但硬中断恢复仍待后续修复 |
| 视频成本 | 真实转录请求只有数字音段审计；供应商未返回可核实成本时 reservation/attempt 保持 `unknown`，不得伪造实际成本 |

完成“尚未取得的证据”并保存真实输出后，才能把本文件状态改为 PASS、勾选 T038–T044，并在 `CHANGELOG.md` 登记 B05 完成。
