# T054 — 可编辑 PPTX 导出

状态：`PASS — 本地结构、真实持久导出与 PowerPoint 兼容性通过`

## 已验证

- `renderPptx` 使用固定 `CarouselDocument` 快照及已经授权的 data URI 素材，不在导出阶段访问外部 URL。
- 每个项目页生成一个 PPTX slide，LinkedIn/Instagram 为 1080×1350，TikTok 为 1080×1920 的等比例自定义页面。
- 标题、正文、项目符号、引用、署名和 CTA 写入 DrawingML 原生文本节点；不是整页截图。
- 输出以 `orincard.pptx` 和 Office Open XML presentation MIME 打包，manifest 只含尺寸、顺序、哈希和 renderer 版本，不包含原始来源、Storage key 或项目正文。
- 专项测试解包真实 PPTX，检查内容类型、presentation XML、slide 数量、平台几何和可编辑文本节点。

## 验收命令

`pnpm exec vitest run tests/cloud/pptx.test.ts`

## 发布前剩余项

- 开发 Supabase 已应用 `20260909191000_b07_export_formats.sql`，Trigger `20260909.8` 已完成真实持久 PPTX 导出；下载后解包验证 6 页顺序与原生文本节点。
- Microsoft PowerPoint 16.109.1 成功打开并识别 6 页。Keynote 14.4 在自动化导入阶段超过 60 秒未返回，因此记录为兼容性限制；字体不嵌入，跨 Office 版本不承诺像素级一致。
