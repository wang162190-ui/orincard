# B01 技术地基验收记录

状态：`PASS — T004/T006 真实云端运行验收完成`

记录日期：2026-09-04

## 本地结果

| 检查 | 结果 |
|---|---|
| 固定运行版本 | `.node-version` 与 `package.json` 均为 Node 22.23.2；当前开发终端实际为 Node 24.14.0，因此保留引擎告警，不将其冒充 Node 22 验证 |
| 依赖解析 | `pnpm install` 成功；TypeScript 从不兼容 Trigger 构建链的 7.0.2 调整并锁定为 5.9.3 |
| 类型检查 | `pnpm exec tsc --noEmit` 通过 |
| 单元测试 | `pnpm test:unit`：24 项通过 |
| 规划测试 | `pnpm test:planning`：12 项通过；95 个任务、12 个串行批次、11 个 AC、48 条 API 路径有映射 |
| 字体资源 | Inter、Source Serif 4、Noto Sans SC 三个固定 WOFF2 均通过包版本与 SHA-256 校验 |
| 云端预检 | Trigger.dev CLI 4.5.16 登录成功；已创建专用 Free 项目 `orincard-dev` |
| Preview 取舍 | Trigger Free 方案支持 0 个 Preview branch，因此 B01 部署到专用开发项目的 Production 环境；不得把它当作未来正式生产项目 |
| 云端测试 | `RUN_CLOUD_PROBES=1 pnpm test:cloud`：3 个测试文件、3 项测试全部通过；密钥只注入测试进程，未写入文件或 Git |

## 已发现并修正的问题

| 部署 | 结果 |
|---|---|
| `20260903.1` / `yg58aovg` | 失败；Node 22 构建已启动且 qpdf 安装步骤完成，但 Trigger.dev 4.5.16 的 Playwright 扩展无法解析 Playwright 1.62.1 改版后的 `install --dry-run` 输出 |
| 修正 | 将 `playwright`、`@playwright/test` 和构建扩展安装版本统一锁定为 1.57.0；该版本仍输出扩展需要的 `browser: chromium-headless-shell` 记录 |
| `20260903.2` / `gsl41h40` | 成功；专用开发项目的 Production 环境在 Node 22 运行时完成 Chromium、qpdf、任务依赖与索引构建 |

## 真实云端运行结果

同一个幂等云任务运行生成并返回全部产物；三个云测试分别验证渲染、可恢复性和地基冒烟，不以本地渲染替代。

| 检查 | 真实结果 |
|---|---|
| Trigger 项目 / 环境 | `proj_bhwgeecxnhxxjrkmdqvh` / 专用开发项目的 Production 环境 |
| Deployment / version | `gsl41h40` / `20260903.2`；配置与构建运行时为 Node 22 |
| Run | `run_06g6jhirrjap2onj2ch665dh01`；状态 `completed`；Attempt 1 完成 |
| Chromium | `143.0.7499.4`；真实 PNG 为 360×450，文件头、尺寸、字节数和 SHA-256 断言通过 |
| PDF | 1 页，文件头、页数、字节数和 SHA-256 断言通过 |
| PPTX | ZIP/XML 可读；`Orincard editable probe` 与 `This text must remain editable.` 均存在于 slide XML，确认文字可编辑 |
| qpdf 恢复 | `qpdf version 11.3.0`；附件名为 `orincard-project.json`，取回 JSON 与嵌入前逐字一致 |
| 任务输出耗时 / RSS | `2201 ms` / `145797120 bytes`（约 139.04 MiB） |
| 云测试 | `RUN_CLOUD_PROBES=1 pnpm test:cloud`：3/3 通过；最终复验耗时 4.15 秒 |

## 产物证据

| 产物 | 字节数 | SHA-256 |
|---|---|
| PNG | `14981` | `d361530ec93127d169ef27b79ae97143de1f013fc03d8e0abefbd94ec0ce7d23` |
| PDF（含恢复附件） | `18168` | `e6a164a0c86195109a8b555dc480bb821beed8e052bb32cc1800e17947d9bb39` |
| PPTX | `45836` | `d5552e9cad4da22a83b621f5fa747a056d9a5bfeae703f19f879920684b7febe` |

安全证据入口：[Trigger.dev run `run_06g6jhirrjap2onj2ch665dh01`](https://cloud.trigger.dev/projects/v3/proj_bhwgeecxnhxxjrkmdqvh/runs/run_06g6jhirrjap2onj2ch665dh01)。未提交 Base64 产物、临时文件、密钥或日志；以上数字由云任务输出返回，并由本地云测试对解码后的真实文件复核。
