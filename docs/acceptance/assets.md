# B06 素材与 Brand Kit 验收记录

状态：`PENDING — T053 真实开发环境验收尚未运行`

记录日期：2026-09-09

本记录只在显式真实验收完成后更新。当前不得将本地单元测试、mock、代码审查或 Trigger 部署成功写作 Pexels、截图、OpenAI 图片生成、Storage、导出或跨账号隔离已通过。

## 运行门槛

在专用开发环境启动应用后，设置 `ORINCARD_RUN_ASSETS_E2E=1` 并运行：

```sh
pnpm exec playwright test tests/e2e/assets-brands.spec.ts
```

该测试需要两名独立的已验证测试用户，以及 `PEXELS_API_KEY`、`OPENAI_API_KEY`、`TRIGGER_SECRET_KEY`、开发 Supabase 的服务端测试凭据。测试生成的项目、Brand Kit、素材和私有 Storage 对象会在 `finally` 中清理；未成功清理的对象或记录必须在本节登记。

## 待采集的真实证据

| 检查 | 预期证据 | 当前结果 |
|---|---|---|
| Pexels 搜索与导入 | 真实 provider ID、作者/来源/许可证字段、私有复制对象和配额响应 | 未运行 |
| 隔离截图 | Trigger run、公开 URL 的私有 PNG、浏览器无 Cookie 会话 | 未运行 |
| AI Image / Portrait | 两次真实供应商调用、候选 `ready`、接受前后状态和预算账本 | 未运行 |
| 素材库与跨账号 | 本账号可列出；第二账号不能列出或复制第一账号素材/品牌 | 未运行 |
| Brand Kit | 创建、复制的新 ID、确认应用后的项目快照、删除影响清单 | 未运行 |
| 预览与导出 | 应用后的项目快照、preflight、实际导出产物及其素材/品牌一致 | 未运行 |
| 清理 | 运行创建的 assets、objects、projects、Brand Kits 均已清除 | 未运行 |

## 当前发布阻断

- T053 尚未在真实开发环境运行，因此 B06 不得标记为通过。
- 验收脚本要求 `apply` 后删除影响清单包含该项目。若当前项目保存路径未同步 `projects.brand_kit_id`，此断言会失败；必须修复该产品行为并重新执行真实验收，不能降低断言或改写为通过。
- AI 图片的原子预算预留、实际成本结算和失败释放 RPC 尚待集成 migration。余额预检不构成真实预算控制验收。
- 截图和图片生成 Trigger worker 必须部署到专用开发项目并使用加密环境变量；本文件在获得 run 证据前不记录部署为验收成功。
