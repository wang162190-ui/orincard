# T054 — 可编辑 PPTX 导出

状态：本地渲染与包结构验证通过；尚未部署。

## 已验证

- `renderPptx` 使用固定 `CarouselDocument` 快照及已经授权的 data URI 素材，不在导出阶段访问外部 URL。
- 每个项目页生成一个 PPTX slide，LinkedIn/Instagram 为 1080×1350，TikTok 为 1080×1920 的等比例自定义页面。
- 标题、正文、项目符号、引用、署名和 CTA 写入 DrawingML 原生文本节点；不是整页截图。
- 输出以 `orincard.pptx` 和 Office Open XML presentation MIME 打包，manifest 只含尺寸、顺序、哈希和 renderer 版本，不包含原始来源、Storage key 或项目正文。
- 专项测试解包真实 PPTX，检查内容类型、presentation XML、slide 数量、平台几何和可编辑文本节点。

## 验收命令

`pnpm exec vitest run tests/cloud/pptx.test.ts`

## 发布前剩余项

- 集成线须将 `server_create_exports` 接受的格式集合和 renderer version 与现有 `pptx` 数据库 enum 对齐，再在开发 Supabase 应用 migration、执行 pgTAP/RLS 检查并部署 Trigger worker。
- 使用部署生成的真实文件分别在 Microsoft PowerPoint 和 Keynote 手动打开；记录字体替代、可编辑 title/body/CTA 和图片显示。字体不嵌入，跨 Office 版本不承诺像素级一致。
