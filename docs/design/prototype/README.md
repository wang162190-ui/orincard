# 工作区闭环原型（reference 的续集）

> source: docs/sdd/orincard/spec.md · 续 docs/design/reference/

`../reference/` 是 2026-09-04 从用户指定的 Open Design 项目原样复制的快照，覆盖 AC-001~AC-008 的四个屏。它的 `index.html` 在 "Not built this round" 里列明了没做的部分。本目录补上其中的**工作区闭环四屏**（对应 AC-007 尾与 AC-009），以及 2026-09-14 追加的**编辑器助手两屏**（对应 spec 新增的 AC-012）。

## 为什么另起目录，而不是往 reference 里加

`manifest.json` 保存了 reference 全部 15 个文件的 SHA-256，`scripts/check-planning.mjs:125` 逐个校验字节数与哈希，`:135` 还会把那 5 个页面里的每个本地 `href`/`src` 解析成路径并要求文件存在。**连"在 reference/index.html 里加一条指向新页面的链接"都会让 `pnpm test:planning` 报 `Changed design reference`。** README 第 5 行"原件未修改"是那份快照作为设计师交付物的证据价值所在，不应为了导航便利而牺牲。

`check-planning.mjs:176` 把 designRoot 写死为 `docs/design/reference`，全仓库仅此一处引用 `docs/design`，所以本目录对所有校验隐形。

代价是**导航只能单向**：本目录的侧栏链得到 reference 四屏，reference 链不回来。`index.html` 承担全景导航。

## 入口

- [原型全景](index.html)：十屏总览，标出哪四屏来自冻结快照。
- [导出中心](exports.html)：导出批次、留存到期、按格式重试、预检阻断与渲染失败。
- [账单](billing.html)：套餐、额度、发票、取消订阅。
- [设置](settings.html)：创作默认值、个人资料、数据导出、删除账号。
- [账号入口](auth.html)：登录 / 注册 / 找回密码 / 匿名草稿迁移。
- [编辑器助手](assistant.html)：思考中 / 提出改动 diff / 确认写入新 revision / 拒绝后逐列未变 / apply 失败 / 预算打满整轮被拒。
- [助手冲突](assistant-conflict.html)：助手基于 v4 提议、用户已手改到 v5，`expectedRevision` 整体拒绝，附逐列未变的证据表。

## 复用

样式与脚本不复制、不 symlink，直接引用 `../reference/assets/orincard.css` 和 `../reference/assets/ori.js`，图片引用 `../reference/assets/img/*`。单一事实来源，零字节重复。

本目录**没有新增任何全局 class**。所有组件来自 reference 的设计系统（`.card` `.panel` `.plan-card` `.progress` `.counter` `.empty` `.steps` `.seg` `.switch` `.tabs` `.notice-*` `.badge-*` `.ds-table` `.dialog` `.field`），页面私有布局写在页内 `<style>` 且只用既有 token。也没有新增图片资源。

## 演示数据

沿用 reference 建立的同一个世界，不另起炉灶：今天是 `Sep 2, 2026`，账号是 Elena Marsh（Creator plan），项目是 `../reference/projects.html` 里的 p1~p6，Brand Kits 是 `../reference/brand-kits.html` 里的四套，下载留存期 30 天（源自 p3 于 Aug 24 导出、`expires: 'Sep 23, 2026'`）。

`exports.html` 里的每一批导出都能在 projects.html 找到对应项目；p3 与 p6 的 `exp.files` 逐字一致。

这些演示项目、状态、文案、姓名和计数属于 `[ILLUSTRATIVE-EXAMPLE: 用户设计演示数据，不是真实业务记录]`。静态脚本模拟的生成、保存、收费和下载不是实现证据。

### 价格、额度与佣金

spec §11 把定价、配额、页数上限、哪个档位解锁高分辨率/PPTX/MP4、以及 affiliate 佣金比例全部列为未决。reference 的做法是留空；本目录按产品负责人 2026-09-11 的决定改为**填示意数字并显著标注**，以便评审时看清结构。

`billing.html` 顶部挂全页声明，每个价格与配额数字旁挂 `.badge-quiet` 标 `ILLUSTRATIVE`。**这些数字不构成定价决策，实现时不得当作已定参数读取。**

## 助手两屏要你定的事（2026-09-14）

`assistant.html` 把助手放进编辑器**右栏**，而不是浮在画布上。代价写在页面顶部的 notice 里：画布从 400 px 缩到 340 px，缩略图从 140 px 缩到 116 px，原来的单页检查器退到同一栏的 *Slide* 标签后面。这是整个编辑器的布局层改动，在图上改比在代码里改便宜一个量级 —— 这也是 S20 设这道停止线的原因。

三条在图上已经拍死、实现时不得放宽的规则：

1. **提议不预览。** 画布始终显示已保存的那一版；提议只以逐页 diff 的形式待在会话里。让画布先变成提议后的样子，等于用"看起来已经改了"去换用户的确认。
2. **没有"仍然应用"。** `assistant-conflict.html` 给了三条出路，没有一条是拿旧提议盖掉新 revision。要回退到 v4 得用户自己去版本历史里做。
3. **预算不够就不跑。** 第 5 态里模型根本没被调用，页面上也没有思考动画 —— 上限是在花钱之前拦，不是花完之后报。

`assistant.html` 的六个状态按钮是**评审用的走查器**，不是产品里的控件。

## 已编码的规则修正

reference README §23 列了五条对快照模拟行为的修正。本目录落实了其中两条：

1. **文字溢出阻断全部五种格式**，不保留 PNG 绕过路径（§26 第 2 条）。所以 `exports.html` 里 p1 的那批导出是在预检阶段整批被拒、零文件产出，而不是"PNG 成了、PDF 没成"。快照 `index.html` 的编辑器卡片仍写着"PNG 与字幕仍能跑"，那是被修正掉的旧行为。
2. **跨页状态、云端保存、版本、下载必须真实联通，不用 toast 替代**（§28）。表单校验错误一律 `.input-invalid` + 字段内联报错。

## 素材权利

图片沿用 `../reference/assets/img/`，权利状态与 `credits.json` 的记录一致：部分照片有 CC BY 2.0 归属，未列明者一律视为未验证，全部仅作私有设计参考，上线前完成许可审计或替换。本目录未新增任何图片。
