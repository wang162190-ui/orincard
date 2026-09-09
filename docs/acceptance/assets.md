# B06 素材与 Brand Kit 验收记录

状态：`PASS — T053 真实开发环境素材与 Brand Kit 主流程通过`

记录日期：2026-09-09

2026-09-09 在开发 Supabase、Trigger 和真实供应商环境执行。图片供应商为 APIMart GPT-Image-2，生成参数为 `1k`、`1:1`；Trigger 部署版本为 `20260909.7`。

## 运行门槛

在专用开发环境启动应用后，设置 `ORINCARD_RUN_ASSETS_E2E=1` 并运行：

```sh
pnpm exec playwright test tests/e2e/assets-brands.spec.ts
```

该测试需要两名独立的已验证测试用户，以及 `PEXELS_API_KEY`、`APIMART_API_KEY`、`TRIGGER_SECRET_KEY`、开发 Supabase 的服务端测试凭据。测试生成的项目、Brand Kit、素材和私有 Storage 对象会在 `finally` 中清理。

## 真实证据

| 检查 | 预期证据 | 当前结果 |
|---|---|---|
| Pexels 搜索与导入 | 真实 provider ID、作者/来源/许可证字段、私有复制对象和配额响应 | 通过 |
| 隔离截图 | IANA 公开页面生成私有 PNG，并校验实际 PNG 尺寸 | 通过 |
| AI Image / Portrait | 两次真实 APIMart 调用、候选 `ready`、接受前后状态 | 通过 |
| 素材库与跨账号 | 本账号可列出；第二账号不能列出或删除第一账号素材/品牌 | 通过 |
| Brand Kit | 创建、独立 ID 复制、确认应用后的项目快照、删除影响清单 | 通过 |
| 清理 | `finally` 清除本次 assets、objects、project 和 Brand Kits | 通过 |

完整 Playwright 命令以单 worker 执行，结果为 `1 passed (2.8m)`。另有真实 APIMart adapter 测试验证响应为 1K PNG。

## 修复记录与剩余门槛

- 本机 Node、Git 和 Trigger CLI 原先未继承 macOS HTTP 代理，安全截图的固定地址连接也绕过代理；现已为运行命令和安全连接器显式接入代理，并优先使用已验证 IPv4 地址。
- APIMart 提交、轮询和下载增加单次 20 秒截止时间，Trigger 任务上限调整为 300 秒；云端直连强制 IPv4。结果下载只接受明确列入清单的 HTTPS 主机。
- `apply` 原先只写入文档快照，未同步 `projects.brand_kit_id`，导致删除影响清单为空。migration `20260909090000` 已在开发 Supabase 应用，通过数据库触发器同步字段并回填同 owner 的历史引用。
- AI 图片的原子预算预留、实际成本结算和失败释放 RPC 尚待集成 migration。余额预检不构成真实预算控制验收。
- 当前 T053 脚本验证应用后的项目快照，但不生成最终导出产物；预览与实际导出一致性仍需在导出批次的真实验收中覆盖。
