# B01 技术地基验收记录

状态：`IN PROGRESS — 等待 Trigger.dev 真实云部署与运行`

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

## 已发现并修正的问题

| 部署 | 结果 |
|---|---|
| `20260903.1` / `yg58aovg` | 失败；Node 22 构建已启动且 qpdf 安装步骤完成，但 Trigger.dev 4.5.16 的 Playwright 扩展无法解析 Playwright 1.62.1 改版后的 `install --dry-run` 输出 |
| 修正 | 将 `playwright`、`@playwright/test` 和构建扩展安装版本统一锁定为 1.57.0；该版本仍输出扩展需要的 `browser: chromium-headless-shell` 记录 |
| `20260903.2` / `gsl41h40` | 成功；专用开发项目的 Production 环境在 Node 22 运行时完成 Chromium、qpdf、任务依赖与索引构建 |

## 云端通过条件

只有以下条件都获得真实运行证据后，才把状态改为 `PASS` 并完成 T004/T006：

1. Trigger.dev 专用开发项目的 Production 环境部署成功，运行时为 Node 22；
2. 构建镜像安装 Chromium 与 qpdf；
3. 云任务真实生成 360×450 PNG、单页 PDF 和含可编辑文本的 PPTX；
4. qpdf 把 `orincard-project.json` 嵌入 PDF，并能逐字取回同一 JSON；
5. 三个产物的字节数、SHA-256、任务耗时和 RSS 内存来自同一次真实运行；
6. `RUN_CLOUD_PROBES=1 pnpm test:cloud` 全部通过。

## 待回填的真实证据

| 字段 | 结果 |
|---|---|
| Trigger 项目 ref | `proj_bhwgeecxnhxxjrkmdqvh` |
| Deployment/version | `gsl41h40` / `20260903.2` |
| Run ID | `PENDING` |
| Chromium version | `PENDING` |
| qpdf version | `PENDING` |
| PNG/PDF/PPTX bytes | `PENDING` |
| elapsedMs / rssBytes | `PENDING` |
| 云测试结果 | `PENDING` |

不得用本地模拟、空文件、截图或手写数字替代以上云端证据。
