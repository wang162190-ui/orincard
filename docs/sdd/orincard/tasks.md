# Orincard 原子开发任务

> source: docs/sdd/orincard/spec.md

2026-09-04，HARD-GATE 2 已批准。共 95 项任务，12 批；按依赖执行，标记 `[P]` 的任务按 `Parallel` 组在最多三条隔离工作线中并行，未标记者串行收口。

## 执行约定

- 每项先写可失败的测试，再实现；Check必须断言下面的结果，不能只检查进程返回0。
- 所有命令是未来实现后的验收命令；本次只运行规划验证，未运行这些业务测试。
- cloud测试缺开发凭据必须失败并报告先决条件，禁止skip后称通过；不得请求生产密钥或使用生产数据。
- files为唯一允许修改的源文件集合（每项最多5个）；CLI生成的lockfile、migration和字体/测试资源须列清单审查，不偷偷扩大源文件范围。新迁移名由CLI实际生成后登记，不能猜时间戳。
- 每批最后的集成项必须通过并review才合main；生成/支付/导出真集成不能由fixture替代。归档临时截图不提交Git，验收文档只保留摘要和安全的证据引用。
- 新增依赖、生成迁移、字体下载均需登记来源与哈希；公开内容必须实写并审核，不把空页面视为全量完成。
- 每项继承前一项的已验证产物。DB定义任务先在允许的开发/CI数据库验证，集成任务通过CLI生成、重放并提交迁移；禁止在生产试SQL。
- `[P]` 任务必须声明 `Parallel: <组>/<工作线>`；同组不同工作线的文件集合不得交叉，也不得互相依赖。每组最多三条工作线，汇合后的云测试、数据库变更、Trigger部署和Playwright验收由协调线串行执行。

## B01

- [x] T001 `package.json`, `pnpm-lock.yaml`, `tsconfig.json`, `.node-version`, `.gitignore` — 建立锁版本运行环境 → AC-001, AC-011
  - Batch: B01
  - Depends: none
  - Check: `node --version && pnpm install --frozen-lockfile`
  - Expect: 依赖锁定、Node版本一致；本任务尚无应用代码，类型检查自T002开始。

- [x] T002 `vitest.config.ts`, `playwright.config.ts`, `tests/setup.ts`, `tests/fixtures/base-document.json`, `tests/setup.test.ts` — 建立单元、契约和浏览器测试入口 → AC-001, AC-006
  - Batch: B01
  - Depends: T001
  - Check: `pnpm exec vitest run tests/setup.test.ts && pnpm exec tsc --noEmit`
  - Expect: 测试命令缺凭据不默默跳过；浏览器默认单worker。

- [x] T003 `src/domain/document.ts`, `src/domain/errors.ts`, `tests/unit/document.test.ts` — 实现文档schema与格式约束 → AC-003, AC-004, AC-006
  - Batch: B01
  - Depends: T002
  - Check: `pnpm exec vitest run tests/unit/document.test.ts`
  - Expect: 4/6/12页、三预设、非法引用/字段/版本均有断言。

- [x] T004 `src/trigger/probe.ts`, `tests/cloud/render-probe.test.ts`, `tests/cloud/recovery-probe.test.ts`, `trigger.config.ts` — 验证云端Chromium/PPTX/qpdf技术探针 → AC-006, AC-007
  - Batch: B01
  - Depends: T003
  - Check: `pnpm exec vitest run tests/cloud/render-probe.test.ts tests/cloud/recovery-probe.test.ts`
  - Expect: 真实云任务输出PNG/PDF/PPTX，PPTX可编辑文本，PDF附件可取回；无凭据必须失败。

- [x] T005 `src/render/fonts.ts`, `src/render/font-manifest.json`, `docs/licenses/fonts.md`, `tests/unit/fonts.test.ts` — 建立许可字体清单与资源装载校验 → AC-004, AC-006
  - Batch: B01
  - Depends: T004
  - Check: `pnpm exec vitest run tests/unit/fonts.test.ts`
  - Expect: 字体许可、来源、版本、哈希完整；缺字体明确报错；不提交不明系统字体。

- [x] T006 `tests/cloud/foundation-smoke.test.ts`, `docs/acceptance/foundation.md` — 完成地基集成冒烟 → AC-001, AC-006, AC-007
  - Batch: B01
  - Depends: T005
  - Check: `pnpm exec vitest run tests/cloud/foundation-smoke.test.ts`
  - Expect: 记录真实峰值内存/耗时、文件可读与恢复结果；探针失败禁止进入B02。

## B02

- [x] T007 `src/components/ui.tsx`, `src/components/ui.css`, `src/styles/tokens.css`, `tests/ui/primitives.test.tsx`, `vitest.config.ts` — 迁移设计tokens和公共基础组件 → AC-001, AC-004
  - Batch: B02
  - Depends: T006
  - Check: `pnpm exec vitest run tests/ui/primitives.test.tsx`
  - Expect: 原设计色彩和按钮/面板一致，焦点、dialog语义可用。

- [x] T008 `src/app/layout.tsx`, `src/app/page.tsx`, `src/components/workspace-shell.tsx`, `src/app/create/page.tsx`, `tests/ui/shell.test.tsx` — 建立同风格工作区壳和入口 → AC-001, AC-011
  - Batch: B02
  - Depends: T007
  - Check: `pnpm exec vitest run tests/ui/shell.test.tsx`
  - Expect: 真实路由可打开，设计导航不成为营销首页，无失效主入口。

- [x] T009 `src/features/editor/reducer.ts`, `src/features/editor/commands.ts`, `tests/unit/editor-commands.test.ts` — 实现逐页命令与撤销重做 → AC-003, AC-005
  - Batch: B02
  - Depends: T008
  - Check: `pnpm exec vitest run tests/unit/editor-commands.test.ts`
  - Expect: 增删复制排序、4/12边界、undo/redo不改其他页。

- [x] T010 [P] `src/features/editor/local-drafts.ts`, `tests/unit/local-drafts.test.ts` — 实现隔离的IndexedDB草稿与过期 → AC-001, AC-007
  - Batch: B02
  - Parallel: WS-B02-1/A
  - Depends: T009
  - Check: `pnpm exec vitest run tests/unit/local-drafts.test.ts`
  - Expect: 24小时过期、账号隔离、显式迁移、刷新保留未同步稿。

- [x] T011 [P] `src/render/slide.tsx`, `src/render/slide.css`, `src/render/preflight.ts`, `tests/ui/preflight.test.tsx` — 实现共享卡片渲染与测量 → AC-004, AC-006
  - Batch: B02
  - Parallel: WS-B02-1/B
  - Depends: T005, T007, T009
  - Check: `pnpm exec vitest run tests/ui/preflight.test.tsx`
  - Expect: 字体/图像就绪后测量；四模式和全部视觉格式统一阻断溢出。

- [x] T012 `src/features/editor/editor.tsx`, `src/features/editor/slide-panel.tsx`, `src/app/editor/[id]/page.tsx`, `tests/ui/editor.test.tsx` — 连接编辑器控件与页面操作 → AC-003, AC-005
  - Batch: B02
  - Depends: T010, T011, T013
  - Check: `pnpm exec vitest run tests/ui/editor.test.tsx`
  - Expect: 单页文本/CTA/模式/图片槽可编辑，拖拽与键盘上下移结果相同。

- [x] T013 [P] `src/render/templates.ts`, `src/features/editor/theme-panel.tsx`, `tests/unit/themes.test.ts` — 实现六主题和全局样式/平台切换 → AC-004, AC-008
  - Batch: B02
  - Parallel: WS-B02-1/C
  - Depends: T007, T009
  - Check: `pnpm exec vitest run tests/unit/themes.test.ts`
  - Expect: Ink/Paper/Signal/Blush/Butter/Sky完整，局部覆盖和内容在切换后保留。

- [x] T014 `tests/e2e/editor.spec.ts`, `tests/visual/editor.spec.ts` — 验证编辑器集成与设计回归 → AC-001, AC-003, AC-004, AC-005
  - Batch: B02
  - Depends: T012
  - Check: `pnpm exec playwright test tests/e2e/editor.spec.ts tests/visual/editor.spec.ts`
  - Expect: 桌面/窄屏可编辑、4/6/12页、离线草稿、原设计布局通过人工比对。

## B03

- [x] T015 `src/server/supabase.ts`, `src/features/auth/client.ts`, `src/server/environment.ts`, `tests/unit/environment.test.ts`, `tests/db/client.ts` — 建立Supabase客户端与环境校验 → AC-007, AC-008
  - Batch: B03
  - Depends: T014
  - Check: `pnpm exec vitest run tests/unit/environment.test.ts`
  - Expect: Preview指向生产、缺密钥、客户端泄露server secret均被拒绝。

- [x] T016 `supabase/definitions/identity.sql`, `supabase/tests/identity.sql`, `tests/db/identity.test.ts` — 定义用户及最小权限SQL → AC-007
  - Batch: B03
  - Depends: T015
  - Check: `pnpm exec vitest run tests/db/identity.test.ts`
  - Expect: 匿名/所有者/跨账号、删除账号断言，全部表列有COMMENT。

- [x] T017 [P] `supabase/definitions/projects.sql`, `supabase/tests/projects.sql`, `tests/db/projects.test.ts` — 定义项目版本与CAS事务SQL → AC-003, AC-007
  - Batch: B03
  - Parallel: WS-B03-2/A
  - Depends: T016
  - Check: `pnpm exec vitest run tests/db/projects.test.ts`
  - Expect: CAS并发只成功一次、快照不可变、不能伪造owner。

- [x] T018 [P] `supabase/definitions/assets.sql`, `supabase/tests/assets.sql`, `tests/db/assets.test.ts` — 定义品牌/来源/资源引用与Storage权限 → AC-002, AC-005, AC-008
  - Batch: B03
  - Parallel: WS-B03-2/A
  - Depends: T017
  - Check: `pnpm exec vitest run tests/db/assets.test.ts`
  - Expect: 私有桶下载需身份；同owner引用、删除后访问与历史保护有效；在项目表已建后添加品牌与素材的跨表约束，分批SQL可顺序重放。

- [x] T019 [P] `supabase/definitions/jobs-usage.sql`, `supabase/tests/jobs-usage.sql`, `tests/db/jobs-usage.test.ts` — 定义任务/额度/预算原子事务 → AC-002, AC-006, AC-009
  - Batch: B03
  - Parallel: WS-B03-2/A
  - Depends: T018
  - Check: `pnpm exec vitest run tests/db/jobs-usage.test.ts`
  - Expect: 任务及写操作回放幂等、取消持久化、请求成本预留和attempt流水完整；并发/重复回调不透支不双扣。

- [x] T020 [P] `scripts/prepare-migrations.mjs`, `supabase/config.toml`, `tests/db/migration-smoke.test.ts` — 生成并验证第一组数据库迁移集成 → AC-007, AC-008, AC-009
  - Batch: B03
  - Parallel: WS-B03-2/A
  - Depends: T019
  - Check: `pnpm exec vitest run tests/db/migration-smoke.test.ts`
  - Expect: 在开发分支通过CLI生成并提交迁移，干净CI库可重放；注释完整；只连接允许的开发项目。

- [x] T021 [P] `src/server/auth.ts`, `src/app/login/page.tsx`, `src/app/signup/page.tsx`, `src/features/auth/auth-form.tsx`, `tests/cloud/auth.test.ts` — 实现邮箱密码登录注册与Google入口 → AC-001, AC-007
  - Batch: B03
  - Parallel: WS-B03-2/B
  - Depends: T016
  - Check: `pnpm exec vitest run tests/cloud/auth.test.ts`
  - Expect: 真实开发Supabase登录，非法密码/邮箱/过期session失败，注册不自动上传匿名正文。

- [x] T022 [P] `src/app/auth/callback/route.ts`, `src/app/reset-password/page.tsx`, `src/proxy.ts`, `src/server/mail.ts`, `tests/cloud/auth-recovery.test.ts` — 完成回调/密码重置/会话刷新 → AC-007
  - Batch: B03
  - Parallel: WS-B03-2/B
  - Depends: T021
  - Check: `pnpm exec vitest run tests/cloud/auth-recovery.test.ts`
  - Expect: 受信回调、Resend开发邮件、重置过期/重复链接与退出清理验证。

- [x] T023 [P] `src/server/projects.ts`, `src/app/api/v1/projects/route.ts`, `src/app/api/v1/projects/[id]/route.ts`, `src/features/editor/autosave.ts`, `tests/cloud/autosave.test.ts` — 实现项目API和可靠自动保存 → AC-003, AC-007
  - Batch: B03
  - Parallel: WS-B03-3/A
  - Depends: T020, T022
  - Check: `pnpm exec vitest run tests/cloud/autosave.test.ts`
  - Expect: 实际写入才显示saved；断网重连/多标签冲突保留本地稿。

- [x] T024 [P] `src/server/jobs.ts`, `src/trigger/dispatch.ts`, `src/app/api/v1/jobs/[id]/route.ts`, `tests/cloud/dispatch.test.ts` — 实现事务outbox投递与任务状态API → AC-002, AC-006, AC-009
  - Batch: B03
  - Parallel: WS-B03-3/B
  - Depends: T020, T022
  - Check: `pnpm exec vitest run tests/cloud/dispatch.test.ts`
  - Expect: 重复投递同jobId，投递超时可恢复，状态仅本人可见。

- [x] T025 [P] `src/app/api/v1/jobs/[id]/retry/route.ts`, `src/app/api/v1/jobs/[id]/cancel/route.ts`, `src/trigger/reconcile-jobs.ts`, `src/server/jobs.ts`, `tests/cloud/job-controls.test.ts` — 实现任务取消/重试与早期对账 → AC-002, AC-006, AC-009
  - Batch: B03
  - Parallel: WS-B03-3/B
  - Depends: T024
  - Check: `pnpm exec vitest run tests/cloud/job-controls.test.ts`
  - Expect: 取消状态持久化，心跳过期先查云任务；重复重试不双扣、不重放成功步骤。

- [x] T026 `tests/e2e/projects-save.spec.ts`, `tests/cloud/ownership-smoke.test.ts` — 完成账号与保存集成冒烟 → AC-001, AC-007, AC-008
  - Batch: B03
  - Depends: T023, T025
  - Check: `pnpm exec playwright test tests/e2e/projects-save.spec.ts && pnpm exec vitest run tests/cloud/ownership-smoke.test.ts`
  - Expect: 匿名同意迁移、保存刷新、账号切换、猜ID失败。

## B04

- [x] T027 [P] `src/server/sources/index.ts`, `src/app/api/v1/sources/route.ts`, `tests/cloud/text-source.test.ts` — 建立Topic/Text来源写入接口 → AC-002
  - Batch: B04
  - Parallel: WS-B04-1/A
  - Depends: T026
  - Check: `pnpm exec vitest run tests/cloud/text-source.test.ts`
  - Expect: 注册文本来源先验证后保存7天，匿名禁止持久化；sourceId可以供下一项生成使用。

- [x] T028 [P] `src/server/ai.ts`, `src/server/prompts.ts`, `src/server/generation.ts`, `tests/cloud/generation.test.ts` — 实现DeepSeek Responses适配与结构化生成 → AC-002, AC-003
  - Batch: B04
  - Parallel: WS-B04-1/A
  - Depends: T027
  - Check: `pnpm exec vitest run tests/cloud/generation.test.ts`
  - Expect: 真实deepseek-v4-pro输出经本地schema校验有效，请求固定store:false，拒绝嵌入指令，一次修复失败不会返回空成功。

- [x] T029 [P] `src/trigger/generate.ts`, `src/app/api/v1/generation/route.ts`, `src/features/generation/progress.tsx`, `tests/cloud/generation-job.test.ts` — 连接注册生成任务与进度UI → AC-002, AC-003
  - Batch: B04
  - Parallel: WS-B04-2/A
  - Depends: T028
  - Check: `pnpm exec vitest run tests/cloud/generation-job.test.ts`
  - Expect: 关闭再开页面可按jobId恢复，完成前不结算，不覆盖旧稿。

- [x] T030 [P] `src/app/api/v1/guest/generate/route.ts`, `src/server/guest-guards.ts`, `tests/cloud/guest.test.ts` — 实现匿名临时生成和反滥用 → AC-001, AC-002
  - Batch: B04
  - Parallel: WS-B04-2/B
  - Depends: T028
  - Check: `pnpm exec vitest run tests/cloud/guest.test.ts`
  - Expect: 无正文持久化/日志，幂等元数据、预算、410结果不保留错误明确。

- [x] T031 `src/features/generation/source-input.tsx`, `src/features/generation/options.tsx`, `src/app/create/page.tsx`, `tests/e2e/text-generation.spec.ts` — 连接Topic/Text创建入口与生成结果 → AC-001, AC-002
  - Batch: B04
  - Depends: T029, T030
  - Check: `pnpm exec playwright test tests/e2e/text-generation.spec.ts`
  - Expect: 匿名短请求和注册source→job两条路径可编辑；默认6页/4–12页、语言和指令真实生效。

- [x] T032 [P] `src/server/rewrite.ts`, `src/features/editor/ai-proposal.tsx`, `src/app/api/v1/projects/[id]/rewrite/route.ts`, `src/app/api/v1/projects/[id]/apply-proposal/route.ts`, `tests/cloud/rewrite.test.ts` — 实现局部AI提案接受/拒绝 → AC-003
  - Batch: B04
  - Parallel: WS-B04-2/B
  - Depends: T023, T028
  - Check: `pnpm exec vitest run tests/cloud/rewrite.test.ts`
  - Expect: 只改目标字段，人工编辑后旧提案409，不重复收费。

- [x] T033 [P] `src/app/api/v1/projects/[id]/regenerate/route.ts`, `src/features/generation/regenerate.tsx`, `src/server/generation.ts`, `tests/cloud/regenerate.test.ts` — 实现整套重新生成候选稿 → AC-003
  - Batch: B04
  - Parallel: WS-B04-2/B
  - Depends: T032
  - Check: `pnpm exec vitest run tests/cloud/regenerate.test.ts`
  - Expect: 原项目不被任务自动覆盖；替换/另存均经确认，版本冲突和重复请求不会丢稿。

- [x] T034 [P] `src/render/render-deck.ts`, `src/trigger/export.ts`, `src/server/export-package.ts`, `tests/cloud/basic-export.test.ts` — 实现PNG/JPG/PDF云端导出 → AC-004, AC-006
  - Batch: B04
  - Parallel: WS-B04-1/C
  - Depends: T026
  - Check: `pnpm exec vitest run tests/cloud/basic-export.test.ts`
  - Expect: 真实文件尺寸/页数/顺序正确，无隐藏原文；格式失败互不删除。

- [x] T035 [P] `src/app/api/v1/projects/[id]/preflight/route.ts`, `src/app/api/v1/exports/route.ts`, `tests/cloud/export-preflight.test.ts` — 接通导出预检与历史列表接口 → AC-006, AC-007
  - Batch: B04
  - Parallel: WS-B04-1/C
  - Depends: T034
  - Check: `pnpm exec vitest run tests/cloud/export-preflight.test.ts`
  - Expect: 预检基于授权固定版本，溢出/缺资源明确；列表只读本人、到期可识别，不扣额度。

- [x] T036 [P] `src/features/exports/export-dialog.tsx`, `src/app/exports/page.tsx`, `src/app/api/v1/projects/[id]/exports/route.ts`, `src/app/api/v1/exports/[id]/download/route.ts`, `tests/cloud/download.test.ts` — 实现导出中心和授权下载 → AC-006, AC-007
  - Batch: B04
  - Parallel: WS-B04-1/C
  - Depends: T035
  - Check: `pnpm exec vitest run tests/cloud/download.test.ts`
  - Expect: 固定revision导出、过期重导、带身份下载，删除后新请求失败。

- [x] T037 `tests/e2e/walking-skeleton.spec.ts`, `docs/acceptance/walking-skeleton.md`, `supabase/definitions/b04.sql`, `supabase/tests/b04.sql`, `supabase/migrations/20260907002243_b04.sql` — 补齐并验收第一条真实小闭环的数据库事务与集成冒烟 → AC-001, AC-002, AC-003, AC-006, AC-007
  - Batch: B04
  - Depends: T031, T033, T036
  - Check: `pnpm exec supabase test db --linked supabase/tests/b04.sql && pnpm exec playwright test tests/e2e/walking-skeleton.spec.ts`
  - Expect: B04原子事务、RLS和私有Storage通过真实开发库验证；Topic/Text→编辑→注册保存→刷新→真实PNG/PDF，禁止用mock代替供应商/Storage。

## B05

- [x] T038 [P] `src/server/assets/upload.ts`, `src/trigger/validate-asset.ts`, `src/app/api/v1/assets/upload-intent/route.ts`, `src/app/api/v1/assets/[id]/complete/route.ts`, `tests/cloud/uploads.test.ts` — 实现直传与文件验证状态 → AC-005, AC-008
  - Batch: B05
  - Parallel: B05-SRC/A
  - Depends: T037
  - Check: `pnpm exec vitest run tests/cloud/uploads.test.ts`
  - Expect: 实际MIME/字节/owner校验；pending不能导出；不走Vercel大文件body。

- [x] T039 [P] `src/server/sources/safe-fetch.ts`, `src/server/sources/url.ts`, `tests/unit/ssrf.test.ts`, `tests/cloud/url.test.ts` — 实现安全URL抓取与正文提取 → AC-002
  - Batch: B05
  - Parallel: B05-SRC/B
  - Depends: T037
  - Check: `pnpm exec vitest run tests/unit/ssrf.test.ts tests/cloud/url.test.ts`
  - Expect: 私网/IPv6/DNS重绑定/每跳重定向/超大响应被拦截，合法正文可用。

- [x] T040 [P] `src/server/sources/pdf.ts`, `src/server/sources/ocr.ts`, `tests/cloud/pdf.test.ts` — 实现PDF文字层和受限OCR → AC-002
  - Batch: B05
  - Parallel: B05-SRC/C
  - Depends: T037
  - Check: `pnpm exec vitest run tests/cloud/pdf.test.ts`
  - Expect: 文字/扫描/空白/加密/超页PDF正确区分，不生成假空结果。

- [x] T041 [P] `src/server/sources/slides.ts`, `src/server/sources/archive.ts`, `tests/cloud/slides.test.ts` — 实现PPTX来源解析 → AC-002
  - Batch: B05
  - Parallel: B05-SRC/C
  - Depends: T040
  - Check: `pnpm exec vitest run tests/cloud/slides.test.ts`
  - Expect: 页序/文字/图片保留；zip bomb/XXE/外链被拒绝；key给转换说明。

- [x] T042 `src/server/sources/video.ts`, `src/server/sources/transcribe.ts`, `src/trigger/parse-source.ts`, `tests/cloud/video.test.ts` — 实现合法视频与分段转录 → AC-002
  - Batch: B05
  - Depends: T041
  - Check: `pnpm exec vitest run tests/cloud/video.test.ts`
  - Expect: 真实音轨/字幕/偏移，无权URL给替代入口；转录失败不伪造。

- [x] T043 `src/features/generation/source-input.tsx`, `src/app/api/v1/sources/route.ts`, `src/app/create/page.tsx`, `src/server/sources/index.ts`, `tests/ui/source-input.test.tsx` — 完成六输入页面和来源API → AC-001, AC-002
  - Batch: B05
  - Depends: T042
  - Check: `pnpm exec vitest run tests/ui/source-input.test.tsx`
  - Expect: 六标签、限制、OCR告知、重复提交、页数/语言/指令全部连接真实服务。

- [x] T044 `tests/e2e/sources.spec.ts`, `tests/cloud/source-failures.test.ts`, `docs/acceptance/sources.md`, `supabase/tests/b05.sql`, `supabase/migrations/20260908110457_b05_parse_budget.sql` — 验收多来源集成与失败恢复 → AC-002, AC-009
  - Batch: B05
  - Depends: T043
  - Check: `pnpm exec supabase test db --linked supabase/tests/b05.sql && pnpm exec playwright test tests/e2e/sources.spec.ts && pnpm exec vitest run tests/cloud/source-failures.test.ts`
  - Expect: 合法六来源成功，安全错误/额度/上游故障不消耗用户额度。
  - Migration history: `supabase/migrations/20260907171424_b05.sql` 已应用且不可修改；本项新增迁移账本匹配的 `20260908110457_b05_parse_budget.sql`，T042 原有 worker/转录文件补齐成本闸门，T044 验证预算、lease 与失败结算。

## B06

- [x] T045 `src/server/assets/pexels.ts`, `src/features/assets/gallery.tsx`, `src/app/api/v1/assets/search/route.ts`, `tests/cloud/gallery.test.ts`, `src/app/api/v1/assets/import-stock/route.ts` — 实现授权图库搜索与导入 → AC-005
  - Batch: B06
  - Depends: T044
  - Check: `pnpm exec vitest run tests/cloud/gallery.test.ts`
  - Expect: 作者/来源/配额保留，选择后才导入，任意外链不能冒充图库。

- [x] T046 `src/trigger/screenshot.ts`, `src/app/api/v1/assets/screenshot/route.ts`, `tests/cloud/screenshot.test.ts` — 实现隔离的URL截图 → AC-005
  - Batch: B06
  - Depends: T045
  - Check: `pnpm exec vitest run tests/cloud/screenshot.test.ts`
  - Expect: 导航和子资源均防SSRF，用户cookie不传入，无权限页面不绕过。

- [x] T047 `src/server/assets/ai-image.ts`, `src/trigger/generate-image.ts`, `src/app/api/v1/assets/generate/route.ts`, `tests/cloud/ai-assets.test.ts` — 实现AI图片与Portrait候选素材 → AC-005
  - Batch: B06
  - Depends: T046
  - Check: `pnpm exec vitest run tests/cloud/ai-assets.test.ts`
  - Expect: 真实调用、授权参考人像、预算、拒绝/接受状态与图片权利记录完整。

- [x] T048 `src/features/assets/media-panel.tsx`, `src/features/assets/crop.ts`, `tests/ui/media.test.tsx` — 实现素材面板/Emoji/裁切/透明度 → AC-005
  - Batch: B06
  - Depends: T047
  - Check: `pnpm exec vitest run tests/ui/media.test.tsx`
  - Expect: 四页面模式、六素材来源、跨页复用，删一页不删其他素材。

- [x] T049 `src/app/api/v1/assets/route.ts`, `src/app/api/v1/assets/[id]/accept/route.ts`, `src/app/api/v1/assets/[id]/route.ts`, `src/server/assets/library.ts`, `tests/cloud/asset-lifecycle.test.ts` — 实现素材列表/候选接受/引用保护删除 → AC-005, AC-007
  - Batch: B06
  - Depends: T048
  - Check: `pnpm exec vitest run tests/cloud/asset-lifecycle.test.ts`
  - Expect: ready但未接受的AI图不能导出；活引用删除409；删除资源不影响他人或其他页。

- [x] T050 `src/server/brands.ts`, `src/features/brands/brand-editor.tsx`, `src/app/brand-kits/page.tsx`, `src/app/api/v1/brand-kits/route.ts`, `tests/cloud/brands.test.ts` — 实现Brand Kit创建复制入口与编辑 → AC-008
  - Batch: B06
  - Depends: T049
  - Check: `pnpm exec vitest run tests/cloud/brands.test.ts`
  - Expect: 多kit隔离、创建/重命名与版本冲突正确；应用与复制动作在后续同批接口项接通。

- [x] T051 `src/app/api/v1/brand-kits/[id]/apply/route.ts`, `src/app/api/v1/brand-kits/[id]/duplicate/route.ts`, `src/server/brands.ts`, `tests/cloud/brand-apply.test.ts` — 实现Brand Kit应用与复制接口 → AC-004, AC-008
  - Batch: B06
  - Depends: T050
  - Check: `pnpm exec vitest run tests/cloud/brand-apply.test.ts`
  - Expect: 明确同意后更新快照，复制新ID且隔离，保留单页覆盖和已有素材引用。

- [x] T052 `src/features/brands/delete-dialog.tsx`, `src/app/api/v1/brand-kits/[id]/route.ts`, `tests/cloud/brand-delete.test.ts` — 实现品牌删除影响确认 → AC-008
  - Batch: B06
  - Depends: T051
  - Check: `pnpm exec vitest run tests/cloud/brand-delete.test.ts`
  - Expect: 逐项目替换/内联选择，影响集合变化409，保留必要素材引用。

- [x] T053 `tests/e2e/assets-brands.spec.ts`, `docs/acceptance/assets.md` — 验收素材和品牌集成 → AC-005, AC-008
  - Batch: B06
  - Depends: T052
  - Check: `pnpm exec playwright test tests/e2e/assets-brands.spec.ts`
  - Expect: 跨账号拒绝、全部来源/品牌操作结果真实且预览导出一致。

## B07

- [x] T054 `src/render/pptx.ts`, `tests/cloud/pptx.test.ts`, `docs/acceptance/pptx.md` — 实现可编辑PPTX导出 → AC-006
  - Batch: B07
  - Depends: T053
  - Check: `pnpm exec vitest run tests/cloud/pptx.test.ts`
  - Expect: 提取PPTX XML确认标题/正文为可编辑文本，手动Office/Keynote兼容性记录。

- [x] T055 `src/render/video.ts`, `tests/cloud/mp4.test.ts`, `docs/acceptance/mp4.md` — 实现MP4与授权音轨 → AC-006
  - Batch: B07
  - Depends: T054
  - Check: `pnpm exec vitest run tests/cloud/mp4.test.ts`
  - Expect: ffprobe检查尺寸/编码/结尾，页时长和音频符合选项；无音频可用。

- [ ] T056 `src/server/recovery.ts`, `src/app/api/v1/imports/inspect/route.ts`, `src/app/api/v1/imports/[id]/confirm/route.ts`, `tests/cloud/recovery.test.ts` — 实现恢复包检查与确认导入 → AC-006, AC-007
  - Batch: B07
  - Depends: T055
  - Check: `pnpm exec vitest run tests/cloud/recovery.test.ts`
  - Expect: ZIP/PDF附件恢复新ID，损坏/恶意/缺资源预览确认，拒绝跨账号key。

- [ ] T057 `src/features/projects/versions.tsx`, `src/app/api/v1/projects/[id]/versions/route.ts`, `src/app/api/v1/projects/[id]/restore/route.ts`, `tests/cloud/versions.test.ts` — 实现版本浏览与恢复 → AC-007
  - Batch: B07
  - Depends: T056
  - Check: `pnpm exec vitest run tests/cloud/versions.test.ts`
  - Expect: 原快照不可变，恢复新revision，版本对应素材仍可读。

- [ ] T058 `src/app/projects/page.tsx`, `src/features/projects/library.tsx`, `src/app/api/v1/projects/[id]/duplicate/route.ts`, `src/app/api/v1/projects/[id]/archive/route.ts`, `tests/e2e/library.spec.ts` — 实现项目库搜索复制归档 → AC-007
  - Batch: B07
  - Depends: T057
  - Check: `pnpm exec playwright test tests/e2e/library.spec.ts`
  - Expect: 最近记录/筛选/搜索/复制/归档/继续编辑使用真实数据。

- [ ] T059 `src/server/deletion.ts`, `src/trigger/cleanup.ts`, `src/app/api/v1/account/route.ts`, `tests/cloud/deletion.test.ts`, `src/app/api/v1/projects/[id]/route.ts` — 实现项目与账户分阶段删除 → AC-007, AC-008
  - Batch: B07
  - Depends: T058
  - Check: `pnpm exec vitest run tests/cloud/deletion.test.ts`
  - Expect: 先拒绝权限再清理，删除中任务不能写回，共享活引用不被删。

- [ ] T060 `src/app/settings/page.tsx`, `src/app/api/v1/settings/route.ts`, `src/app/api/v1/account/export/route.ts`, `src/trigger/account-export.ts`, `tests/cloud/account-export.test.ts` — 实现偏好和用户数据包 → AC-007
  - Batch: B07
  - Depends: T059
  - Check: `pnpm exec vitest run tests/cloud/account-export.test.ts`
  - Expect: 偏好持久化；账号包只含本人授权内容，无密钥/支付凭证。

- [ ] T061 `tests/e2e/export-restore.spec.ts`, `tests/cloud/package-privacy.test.ts` — 验收全格式与恢复集成 → AC-006, AC-007
  - Batch: B07
  - Depends: T060
  - Check: `pnpm exec playwright test tests/e2e/export-restore.spec.ts && pnpm exec vitest run tests/cloud/package-privacy.test.ts`
  - Expect: 逐格式真实输出及恢复、部分失败重试、超大包、隐藏原文扫描。

## B08

- [ ] T062 `src/domain/tools.ts`, `src/features/tools/registry.ts`, `tests/unit/tools.test.ts` — 定义七工具输入/结果类型和上下文选择 → AC-010
  - Batch: B08
  - Depends: T061
  - Check: `pnpm exec vitest run tests/unit/tools.test.ts`
  - Expect: 七tool枚举和结果契约完整；只继承用户勾选的上下文。

- [ ] T063 `src/server/tools/text-tools.ts`, `src/trigger/tool.ts`, `tests/cloud/text-tools.test.ts` — 实现Caption/LinkedIn Post/Post Ideas → AC-010
  - Batch: B08
  - Depends: T062
  - Check: `pnpm exec vitest run tests/cloud/text-tools.test.ts`
  - Expect: 空输入/项目入口均可生成，修改建议不直接写原项目。

- [ ] T064 `src/server/tools/visual-tools.ts`, `src/render/tool-templates.tsx`, `tests/cloud/visual-tools.test.ts` — 实现Quote/Infographic/Portrait/Carousel-to-Video → AC-005, AC-006, AC-010
  - Batch: B08
  - Depends: T063
  - Check: `pnpm exec vitest run tests/cloud/visual-tools.test.ts`
  - Expect: 复用图片/渲染任务，Quote不伪造名人名言，工具尺寸有独立类型。

- [ ] T065 `src/server/tools/outputs.ts`, `src/app/api/v1/tools/outputs/[id]/download/route.ts`, `tests/cloud/tool-outputs.test.ts` — 实现不绑定轮播的独立工具产物与下载 → AC-006, AC-010
  - Batch: B08
  - Depends: T064
  - Check: `pnpm exec vitest run tests/cloud/tool-outputs.test.ts`
  - Expect: 单张Quote/Infographic及独立MP4按owner/job授权下载；无需伪造4页项目，过期或删除后拒绝。

- [ ] T066 `src/app/tools/page.tsx`, `src/app/tools/[tool]/page.tsx`, `src/app/api/v1/tools/[tool]/route.ts`, `src/app/api/v1/tools/[tool]/apply/route.ts`, `tests/e2e/tools.spec.ts` — 连接工具页面与显式应用 → AC-010, AC-011
  - Batch: B08
  - Depends: T065
  - Check: `pnpm exec playwright test tests/e2e/tools.spec.ts`
  - Expect: 七工具可独立访问，结果可复制/导出/确认应用，失败保留项目。

- [ ] T067 `tests/cloud/tools-matrix.test.ts`, `docs/acceptance/tools.md` — 验收工具矩阵集成 → AC-010
  - Batch: B08
  - Depends: T066
  - Check: `pnpm exec vitest run tests/cloud/tools-matrix.test.ts`
  - Expect: 七工具×独立/项目入口×成功/失败完整通过，不用占位成功。

## B09

- [ ] T068 `src/domain/entitlements.ts`, `src/server/billing/policy.ts`, `tests/unit/entitlements.test.ts` — 实现版本化权益策略和测试价目隔离 → AC-009
  - Batch: B09
  - Depends: T067
  - Check: `pnpm exec vitest run tests/unit/entitlements.test.ts`
  - Expect: 客户端不能提权，生产缺真实policy拒绝开通，test_only不能装载生产。

- [ ] T069 `supabase/definitions/billing.sql`, `supabase/tests/billing.sql`, `tests/db/billing.test.ts` — 定义订阅/事件/审计SQL → AC-009
  - Batch: B09
  - Depends: T068
  - Check: `pnpm exec vitest run tests/db/billing.test.ts`
  - Expect: 注释齐全、事件唯一、不同发票不被时间戳错误合并。

- [ ] T070 `src/server/billing/stripe.ts`, `src/app/api/v1/billing/checkout/route.ts`, `src/app/api/v1/billing/portal/route.ts`, `tests/cloud/checkout.test.ts` — 实现Stripe Checkout和Portal → AC-009
  - Batch: B09
  - Depends: T069
  - Check: `pnpm exec vitest run tests/cloud/checkout.test.ts`
  - Expect: 真实Sandbox可进入；customer/price和允许的promotion code由服务端控制，失效优惠码不生效，重复点击不重复开订阅。

- [ ] T071 `src/app/api/v1/webhooks/stripe/route.ts`, `src/server/billing/events.ts`, `src/trigger/reconcile-billing.ts`, `tests/cloud/billing-events.test.ts` — 实现验签Webhook与订阅对账 → AC-009
  - Batch: B09
  - Depends: T070
  - Check: `pnpm exec vitest run tests/cloud/billing-events.test.ts`
  - Expect: 无效签名拒绝、持久化后应答、重复/乱序收敛、失败可补偿。

- [ ] T072 `src/app/billing/page.tsx`, `src/features/billing/upgrade-dialog.tsx`, `src/app/api/v1/billing/route.ts`, `tests/e2e/billing.spec.ts` — 实现账单页和额度/付费墙 → AC-009
  - Batch: B09
  - Depends: T071
  - Check: `pnpm exec playwright test tests/e2e/billing.spec.ts`
  - Expect: 余额/周期/失败/取消/降级入口真实，取消不删除项目。

- [ ] T073 `tests/cloud/billing-lifecycle.test.ts`, `docs/acceptance/billing.md` — 验收支付生命周期集成 → AC-009
  - Batch: B09
  - Depends: T072
  - Check: `pnpm exec vitest run tests/cloud/billing-lifecycle.test.ts`
  - Expect: Sandbox升级/续费/失败/期末取消/退款/并发额度全覆盖；无live交易。

## B10

- [ ] T074 `src/app/page.tsx`, `src/app/pricing/page.tsx`, `src/features/marketing/home.tsx`, `tests/e2e/marketing.spec.ts` — 完成原创营销首页和价格页 → AC-001, AC-011
  - Batch: B10
  - Depends: T073
  - Check: `pnpm exec playwright test tests/e2e/marketing.spec.ts`
  - Expect: 沿现有风格补稿并review，未配置真实价格不公开测试数字。

- [ ] T075 `src/app/templates/page.tsx`, `src/app/templates/[slug]/page.tsx`, `content/templates.json`, `tests/e2e/templates.spec.ts` — 完成模板案例索引和创建副本 → AC-004, AC-011
  - Batch: B10
  - Depends: T074
  - Check: `pnpm exec playwright test tests/e2e/templates.spec.ts`
  - Expect: 原创分类/案例可索引，选择模板进入真实创建路径。

- [ ] T076 `src/server/content.ts`, `src/app/help/[slug]/page.tsx`, `src/app/guides/[slug]/page.tsx`, `content/help/getting-started.mdx`, `tests/unit/content.test.ts` — 完成帮助指南与受控MDX内容 → AC-011
  - Batch: B10
  - Depends: T075
  - Check: `pnpm exec vitest run tests/unit/content.test.ts`
  - Expect: 内容仅仓库受信MDX，帮助覆盖输入/导出/保存/账单/恢复目录，无任意用户脚本。

- [ ] T077 `content/guides/text-to-carousel.mdx`, `content/help/export-and-restore.mdx`, `content/help/billing-and-cancellation.mdx`, `tests/unit/content-coverage.test.ts` — 补齐实际帮助指南与案例内容 → AC-011
  - Batch: B10
  - Depends: T076
  - Check: `pnpm exec vitest run tests/unit/content-coverage.test.ts`
  - Expect: 至少一篇原创指南和输入/编辑/导出/恢复/账单帮助可读；无空指南目录或复制竞品文案。

- [ ] T078 `src/app/robots.ts`, `src/app/sitemap.ts`, `src/server/metadata.ts`, `tests/e2e/seo.spec.ts` — 实现SEO和私有路由禁索引 → AC-011
  - Batch: B10
  - Depends: T077
  - Check: `pnpm exec playwright test tests/e2e/seo.spec.ts`
  - Expect: canonical/sitemap/SSR正文正确，私有/Preview无index；robots不充当访问控制。

- [ ] T079 `supabase/definitions/growth.sql`, `supabase/tests/growth.sql`, `tests/db/growth.test.ts` — 定义Affiliate/工单数据与反冲规则 → AC-011
  - Batch: B10
  - Depends: T078
  - Check: `pnpm exec vitest run tests/db/growth.test.ts`
  - Expect: 申请/审批/唯一码、同意/窗口/自荐/唯一归因/佣金反冲、注释和脱敏隔离通过。

- [ ] T080 `src/server/affiliate.ts`, `src/app/affiliate/page.tsx`, `src/app/affiliate/dashboard/page.tsx`, `src/app/api/v1/affiliate/attribute/route.ts`, `tests/cloud/affiliate.test.ts` — 实现Affiliate申请和统计页面 → AC-011
  - Batch: B10
  - Depends: T079
  - Check: `pnpm exec vitest run tests/cloud/affiliate.test.ts`
  - Expect: 审批前无佣金链接、未同意不写归因cookie、退款反冲、无购买者隐私。

- [ ] T081 `src/app/api/v1/affiliate/apply/route.ts`, `src/app/api/v1/affiliate/dashboard/route.ts`, `scripts/affiliate-review.mjs`, `tests/cloud/affiliate-approval.test.ts` — 接通Affiliate申请/汇总和受控审批 → AC-011
  - Batch: B10
  - Depends: T080
  - Check: `pnpm exec vitest run tests/cloud/affiliate-approval.test.ts`
  - Expect: 申请审批状态可追溯；仅批准后产生唯一码；审批命令需授权、环境确认和审计，客户端不能自批。

- [ ] T082 `src/app/api/v1/support/route.ts`, `src/features/support/form.tsx`, `src/app/legal/[slug]/page.tsx`, `content/legal/README.md`, `tests/e2e/support.spec.ts` — 实现支持/版权与法律页面 → AC-007, AC-011
  - Batch: B10
  - Depends: T081
  - Check: `pnpm exec playwright test tests/e2e/support.spec.ts`
  - Expect: 诊断仅用户选择ID；法律文本未经确认不伪称已审核。

- [ ] T083 `content/legal/privacy.mdx`, `content/legal/terms.mdx`, `content/legal/affiliate.mdx`, `tests/unit/legal-policy.test.ts` — 建立可审核的生产法律文本包 → AC-007, AC-009, AC-011
  - Batch: B10
  - Depends: T082
  - Check: `pnpm exec vitest run tests/unit/legal-policy.test.ts`
  - Expect: 用户审核权利/保留/退款/佣金政策后才标生产可发布；缺审批证据阻断，测试文案不冒充法律审核。

- [ ] T084 `tests/e2e/growth.spec.ts`, `docs/acceptance/growth.md` — 验收增长闭环集成 → AC-011
  - Batch: B10
  - Depends: T083
  - Check: `pnpm exec playwright test tests/e2e/growth.spec.ts`
  - Expect: 公开入口→试用→注册→Sandbox归因/退款均可追溯，无自动社媒发布。

## B11

- [ ] T085 `.github/workflows/check.yml`, `.github/workflows/release.yml`, `vercel.json`, `tests/unit/deployment.test.ts` — 实现分环境CI与受控生产发布 → AC-007, AC-009, AC-011
  - Batch: B11
  - Depends: T084
  - Check: `pnpm exec vitest run tests/unit/deployment.test.ts`
  - Expect: Preview不接生产；发布同一已测试commit内的已提交迁移，按测试→迁移→worker→网站执行，失败不晋升。

- [ ] T086 `src/server/observability.ts`, `src/trigger/retention.ts`, `tests/cloud/operations.test.ts` — 实现预算/到期清理和监控 → AC-002, AC-007, AC-009
  - Batch: B11
  - Depends: T085
  - Check: `pnpm exec vitest run tests/cloud/operations.test.ts`
  - Expect: 来源/导出到期清理、80%告警/100%熔断；复验已有reconciler，日志无正文。

- [ ] T087 `scripts/backup.mjs`, `scripts/restore-check.mjs`, `docs/runbooks/recovery.md`, `tests/cloud/backup.test.ts` — 实现备份与隔离恢复工具 → AC-007
  - Batch: B11
  - Depends: T086
  - Check: `pnpm exec vitest run tests/cloud/backup.test.ts`
  - Expect: 已批准备份目标的DB和Storage共同恢复，哈希/引用/删除tombstone检查通过。

- [ ] T088 `docs/licenses/assets.md`, `docs/acceptance/security.md`, `tests/cloud/release-guards.test.ts` — 完成许可与安全发布检查 → AC-005, AC-007, AC-008, AC-009
  - Batch: B11
  - Depends: T087
  - Check: `pnpm exec vitest run tests/cloud/release-guards.test.ts`
  - Expect: 未知许可/模型资格/支付政策阻断上线，无密钥、用户原文或不合规素材提交。

- [ ] T089 `tests/cloud/release-drill.test.ts`, `docs/acceptance/release-drill.md` — 完成发布/回滚运维集成演练 → AC-007, AC-009, AC-011
  - Batch: B11
  - Depends: T088
  - Check: `pnpm exec vitest run tests/cloud/release-drill.test.ts`
  - Expect: 隔离环境验证旧版兼容、worker故障、网站回滚、DB恢复流程，生产无破坏操作。

## B12

- [ ] T090 `tests/fixtures/corpus.json`, `tests/fixtures/rights.json`, `tests/unit/corpus.test.ts` — 建立20份授权全量验收语料清单 → AC-002, AC-005, AC-006
  - Batch: B12
  - Depends: T089
  - Check: `pnpm exec vitest run tests/unit/corpus.test.ts`
  - Expect: 20份原创/授权样本涵盖六来源、混排/OCR/媒体/恶意输入，来源和授权可核对。

- [ ] T091 `tests/visual/export-matrix.spec.ts`, `docs/acceptance/visual.md` — 执行主题×平台×页数视觉矩阵 → AC-004, AC-005, AC-006
  - Batch: B12
  - Depends: T090
  - Check: `pnpm exec playwright test tests/visual/export-matrix.spec.ts`
  - Expect: 6主题×3平台×4/6/12页及长词/中文/Emoji通过，无裁切缺字缺资源。

- [ ] T092 `tests/cloud/security-matrix.test.ts`, `docs/acceptance/isolation.md` — 执行跨账号与故障幂等矩阵 → AC-001, AC-002, AC-007, AC-008, AC-009
  - Batch: B12
  - Depends: T091
  - Check: `pnpm exec vitest run tests/cloud/security-matrix.test.ts`
  - Expect: 盗ID/改owner/过期JWT/删除后下载/并发保存/重复回调/未知上游状态全部断言。

- [ ] T093 `tests/e2e/accessibility.spec.ts`, `tests/e2e/browsers.spec.ts`, `docs/acceptance/browsers.md` — 执行可访问性和浏览器兼容验收 → AC-001, AC-004, AC-006
  - Batch: B12
  - Depends: T092
  - Check: `pnpm exec playwright test tests/e2e/accessibility.spec.ts tests/e2e/browsers.spec.ts`
  - Expect: Chrome/Firefox/Safari桌面核心流与窄屏可用，键盘/焦点/下载兼容有证据。

- [ ] T094 `tests/cloud/performance.test.ts`, `docs/acceptance/costs.md` — 测量真实成本和内存边界 → AC-002, AC-006, AC-009
  - Batch: B12
  - Depends: T093
  - Check: `pnpm exec vitest run tests/cloud/performance.test.ts`
  - Expect: 记录样本token/分钟/渲染秒/峰值内存/流量，修正预算估计，不把mock时延当实测。

- [ ] T095 `tests/e2e/full-product.spec.ts`, `docs/acceptance/release.md`, `tests/contracts/api-coverage.test.ts` — 完成全产品集成冒烟与发布清单 → AC-001, AC-002, AC-003, AC-004, AC-005, AC-006, AC-007, AC-008, AC-009, AC-010, AC-011
  - Batch: B12
  - Depends: T094
  - Check: `pnpm exec vitest run tests/contracts/api-coverage.test.ts && pnpm exec playwright test tests/e2e/full-product.spec.ts`
  - Expect: 逐方法逐路径契约覆盖、全部模块和L01–L07证据齐全，经用户验收；未配置能力不能计为完成。

## AC覆盖索引

| AC | 任务 |
|---|---|
| AC-001 | T001, T002, T006, T007, T008, T010, T014, T021, T026, T030, T031, T037, T043, T074, T092, T093, T095 |
| AC-002 | T018, T019, T024, T025, T027, T028, T029, T030, T031, T037, T039, T040, T041, T042, T043, T044, T086, T090, T092, T094, T095 |
| AC-003 | T003, T009, T012, T014, T017, T023, T028, T029, T032, T033, T037, T095 |
| AC-004 | T003, T005, T007, T011, T013, T014, T034, T051, T075, T091, T093, T095 |
| AC-005 | T009, T012, T014, T018, T038, T045, T046, T047, T048, T049, T053, T064, T088, T090, T091, T095 |
| AC-006 | T002, T003, T004, T005, T006, T011, T019, T024, T025, T034, T035, T036, T037, T054, T055, T056, T061, T064, T065, T090, T091, T093, T094, T095 |
| AC-007 | T004, T006, T010, T015, T016, T017, T020, T021, T022, T023, T026, T035, T036, T037, T049, T056, T057, T058, T059, T060, T061, T082, T083, T085, T086, T087, T088, T089, T092, T095 |
| AC-008 | T013, T015, T018, T020, T026, T038, T050, T051, T052, T053, T059, T088, T092, T095 |
| AC-009 | T019, T020, T024, T025, T044, T068, T069, T070, T071, T072, T073, T083, T085, T086, T088, T089, T092, T094, T095 |
| AC-010 | T062, T063, T064, T065, T066, T067, T095 |
| AC-011 | T001, T008, T066, T074, T075, T076, T077, T078, T079, T080, T081, T082, T083, T084, T085, T089, T095 |
