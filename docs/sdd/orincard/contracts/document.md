# CarouselDocument 与资源契约

> source: docs/sdd/orincard/spec.md

状态：Gate 2 review，2026-09-04。这是后续 Zod/TypeScript 的规范，不是已实现类型。

## 1. 基础类型（AC-003/004/006/007）

所有 ID 为服务端 UUID；匿名本地 ID 用 `local-` 前缀且不得作为云端主键提交。时间为 UTC ISO8601；金额为整数最小货币单位，预算为整数微美元；revision 为单调递增正整数。枚举值区分大小写；未知 schemaVersion 返回明确不支持错误，不尝试猜测。

| 类型 | 字段与约束 |
|---|---|
| CarouselDocument | schemaVersion=1；title；platform；templateId/templateVersion；theme；brandSnapshot或null；slides[]；caption；assetRefs[]。不含 owner_id、支付字段、Storage签名链接和完整源正文。 |
| PlatformPreset | linkedin、instagram：1080×1350；tiktok：1080×1920。尺寸由版本化预设决定，不允许前端任意大画布。 |
| Slide | id；revision；role=intro/content/outro；mode=text/text_image/image/screenshot；layoutId；eyebrow；title；bodyBlocks[]；cta；assetSlots[]；counterVisible；overrides。 |
| TextBlock | kind=paragraph/bullets/quote；text或items；emphasisRanges（按Unicode code point位置）；可选sourceRefs。不得存HTML。 |
| AssetSlot | slotId；assetId；fit=cover/contain；crop={x,y,width,height}均为0–1范围且不超边界；opacity=0–1；alt。 |
| ThemeSettings | paletteId或明确颜色值；fontPairId；textScale；spacing；alignment；background={solid/gradient,shape,texture,opacity}；arrow；radius；counterStyle。各模板声明可支持值与最小字号。 |
| BrandSnapshot | kitId、kitVersion、name、displayName、website、cta、colors、fontPairId、logoAssetId/headshotAssetId、counterDefaults。是项目快照，不是实时查询结果。 |
| SourceRef | sourceId；segmentId；可选page/timeStart/timeEnd；kind=quote/paraphrase。没有可验证时间码时字段为null，不生成假时间。 |

生成页数范围4–12、默认6来自选定设计，编辑 CRUD 也保持4–12。达到边界按钮禁用并显示理由；复制/拆页需先检查总数；换模板不改变数量。独立 Quote 工具允许单张图，但必须用 ToolResult 类型，不能绕过 CarouselDocument 的页数约束。

ToolResult以tool区分：caption/linkedInPost/postIdeas为文本结构；quote/infographic为1张受控视觉文档；portrait为经接受的asset引用；carouselToVideo为有序slides的媒体输出。共有schemaVersion、resultId、jobId、可选contextProjectId/contextRevision、payload。持久化到tool_outputs，导出关联该结果而不是强造CarouselProject；按本人和任务授权，独立产物也受尺寸/字体/资源/到期检查。账号数据包同样有独立主体，不借用任意项目权限。

## 2. 状态与编辑（AC-003/004/007/008）

编辑 document、UI selection、undo history 分开存。undo/redo 只变文档，不撤销已经执行的支付或任务。最多保留100次会话操作（技术默认，后续压测可调整），图片只存引用。AI提案包含targetSlideId/targetField/baseSlideRevision/before/after；接受时比较revision及before，不匹配即冲突，要求重新预览。整套重新生成创建独立候选稿，由用户选择替换或另存；不能静默覆盖。

本地 IndexedDB 按用户或匿名 session 隔离；退出账号清理该账号未同步内容前提示；匿名过期由读取时检查+打开应用时清理，不能声称浏览器关闭时仍有后台精确删除任务。

自动保存：停止编辑1秒后发送，保存过程中的新输入进入下一次保存；服务端只接受 expectedRevision。离线仍允许本地编辑；重新联网先取云版本，冲突显示“保留本地副本/使用云端版本”，不得最后写入者强行覆盖。

主题、品牌或平台切换先产生预览，再运行同一个 preflight。内容、顺序、来源、素材保留；用户可以取消切换。品牌删除需逐项目选择替换或保留内联快照；Brand引用置空但快照资源继续被项目引用保护。

## 3. 模板和字体（AC-004/006）

Template 为版本化、代码审核过的静态配置，不接受用户代码。基线采用设计包 Ink、Paper、Signal、Blush、Butter、Sky 六主题的角色化布局，所有角色和四种页面模式均有明确槽位。模板变更不热更新历史项目；迁移通过显式应用新版本。

Visual chrome 与导出主题分离。字号以1080px画布为基准，正文最小24px、标题最小40px、脚注最小18px为技术起点；每个主题经过长文本样本校准，不用无限缩放掩盖溢出。默认候选字体组合为 Source Serif 4 + Inter，中文fallback为Noto Sans CJK；字体任务验证上游许可、固定字体文件与哈希后才允许导出。Emoji采用许可合规的固定字体或矢量资源，不依赖操作系统彩色字体。

统一 rendererVersion、templateVersion、font manifest。浏览器 preview 缩放只改变视图尺寸，不改变排版几何。测量先等待 fonts.ready/图片解码；若资源失败或溢出，列slideId+问题+修复动作。允许选择布局、有限字号调整、主动缩写和用户确认拆页；禁止静默裁切、拉伸、随机换字体和自动增页。

## 4. 恢复与导出清单（AC-006/007）

ExportManifest v1：schemaVersion、rendererVersion、templateVersion、createdAt、platform、width/height、slideOrder、files[{path,mime,bytes,sha256}]、recoveryIncluded、warnings。资源路径必须相对且不含`..`、绝对路径或符号链接。

```text
01.png ... 06.png          所选格式的展示文件
caption.txt               用户选择的caption
manifest.json             文件顺序、尺寸、哈希和版本
project/document.json     启用可恢复包时包含结构化文档
project/assets/           仅该文档引用且允许再分发的素材
project/licenses.json     素材/字体许可、归因、缺失项说明
```

禁止打包源PDF/视频/原文、提示词、账号ID、内部Storage路径、订阅或别的项目素材。SourceRef导出时转换为用户选择的可见引用说明，不暴露内部ID。无法嵌入的素材给出明确警告，不偷偷联网补取。

普通PDF只含页面。用户启用“Include editable project”后，qpdf将恢复ZIP作为明确命名附件嵌入PDF；下载前显示文件大小与包含项。导入先检查哈希、版本、路径、解压大小、字体/素材缺项，显示恢复预览，经确认生成**新项目和新ID**，从不覆盖同名旧项目。

PDF被第三方平台移除附件后，只能回到来源导入；不可宣称任意PDF都能无损恢复。下载PPTX不等于能反向恢复原项目，恢复契约仅Orincard ZIP/PDF。
