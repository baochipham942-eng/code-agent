# KIMI-REPORT — Skill 装前预览 UI 批

- worktree: `/Users/linchen/Downloads/ai/code-agent/.worktrees/skill-preview-ui`
- 分支: `feat/skill-install-preview-ui`（基于 feat/skill-source-multiorigin，基点 `697fedc23`）
- HEAD: `cd2921251`（3 个 commit，未推分支、未开 PR，收口留给 Claude）

## 改动清单

1. **添加库流程切换**（`src/renderer/components/features/settings/tabs/SkillsSettings.tsx`）
   - `handleAddCustom` 不再调 `REPO_ADD_CUSTOM`，改为 `REPO_STAGE`；成功（`success && stageId`）打开预览弹窗，失败在自定义库表单位置内联展示错误（新增 `customError` state，随输入变化自动清除）。
   - URL 前端校验放宽为双源：`https://github.com/` 或 `https://(www.)?modelscope.cn/`，与 host 侧 `parseRepoUrl` 支持面对齐。
   - 确认安装成功后：关弹窗、清空 URL、成功提示、切回「已安装」tab 并 `loadData()` 刷新。

2. **预览弹窗**（新组件 `src/renderer/components/features/settings/tabs/SkillInstallPreviewModal.tsx`）
   - 复用现有 `Modal`/`ModalFooter`（portal/ESC/遮罩/焦点均由 Modal 处理），视觉对齐 McpServerEditor（zinc 底 + indigo 主色）。
   - 头部：repoName + 源徽标（GitHub / 魔搭）+ layout 说明（单 Skill 包 / 技能库 · 共 N 个 Skill）。
   - 主体：顶部固定 amber 安全提示（skill 内容将注入模型上下文，安装前确认来源可信）；warnings 非空时警示条列出；skill 列表 name + description，可展开查看 `skillMdContent` 全文（`font-mono`、`max-h-64 overflow-auto` 独立滚动区）。
   - 底部：取消 / 确认安装；confirm 失败在弹窗内红条展示错误、弹窗保持打开，不静默。
   - 所有关闭路径（取消按钮、ESC、遮罩、头部 X）汇聚到同一 `handleClose`，必然触发 `REPO_CANCEL`；`settledRef` 保证 confirm 成功后不再 cancel、也不重复 cancel。

3. **i18n**（`zhSettingsModels.ts` / `enSettingsModels.ts` 同步）
   - 新增 `settings.skills.preview.*` 13 个键（源徽标、layout、安全提示、警告、展开/收起、确认/安装中/失败）。
   - `invalidGithubUrl` 改名 `invalidRepoUrl` 并更新双源文案（仅原添加流程引用，无其他消费方）；删除不再使用的 `repoAdded`；`customDescription` 更新为双源说明。
   - 注：提示词称「en.ts 是 Translations 推导类型基准」，实际 `Translations = typeof zh`（`src/renderer/i18n/zh.ts:1057`）；两文件均已同步加键，typecheck 通过。

4. **测试**（`tests/renderer/components/skillInstallPreview.test.tsx`，9 条，mock `invokeSkillIPC` 层）
   - stage 成功渲染预览（repo 名 / 徽标 / layout / skill 列表 / 安全提示 / 警告，且未走旧 `REPO_ADD_CUSTOM`）；
   - 展开查看 SKILL.md 全文；
   - 确认安装调 `REPO_CONFIRM` 且刷新列表、不触发 cancel；
   - 取消按钮与 ESC 关闭都调 `REPO_CANCEL`；
   - confirm 失败弹窗内展示错误、不关闭、不 cancel；
   - stage 失败表单内联错误、不弹预览；
   - 非法 URL 前端拦截不调 stage；魔搭 URL 通过校验且徽标/layout 正确。

## 验收门运行结果

| 门 | 结果 |
|---|---|
| `npm run typecheck` | 通过（0 错误） |
| `npm run lint` | 0 errors；426 warnings 全为存量，本批改动文件 0 警告 |
| `npx vitest run tests/renderer/` | 506 文件 / 3221 用例全绿（含新增 9 条） |

约束核对：未改 `src/host` / `src/shared` 任何文件；未新增依赖（`git diff --stat` 仅 6 个文件，renderer + i18n + tests）。

## 遗留事项

- 「整库安装」（推荐仓库卡片）与 SkillsMP 搜索安装仍走旧的直接下载/添加 IPC，不在本批范围（提示词只要求切换「添加自定义库」）；如需统一装前预览，建议后续批次复用 `SkillInstallPreviewModal`。
- UI 批合并前需产品负责人过目审美（按提示词纪律，未推分支、未开 PR）。

## 二轮：可读性

背景：产品负责人真机反馈——对照 Kimi App skill 详情页，一轮的「查看全文」是等宽裸文本（`<pre>` 一坨难读），要求渲染成排版后的 markdown。

1. **SKILL.md 渲染为 markdown**（`SkillInstallPreviewModal.tsx`）
   - 复用现有 `MarkdownCore`（`src/renderer/components/features/chat/MessageBubble/MarkdownCore.tsx`），按 `CaptureDetail` 的既有做法 `React.lazy` + `Suspense` 懒加载，不进首屏 modulepreload；未新增依赖、未自写解析器。
   - 新增 `stripFrontmatter`：剥掉 `---` 包围的 YAML 头部（name/description 卡片上已有），frontmatter 不进入渲染正文；fallback 占位也用剥离后的正文。
   - 展开区样式：去掉 `font-mono text-[11px]`，改 `prose prose-invert prose-sm` + 正常字号行距，内边距加大（`px-4 py-3`），独立滚动区 `max-h-64` → `max-h-96`。

2. **弹窗宽度**：`size="lg"`（max-w-lg）→ `size="full"`（max-w-4xl），参照 ModelOnboardingModal 等大号 Modal 档位；信息层级（安全提示条、warnings、skill 卡片）未动。

3. **交互零改动**：stage/confirm/cancel、关闭即 cancel、settledRef 语义全部保持一轮实现。

4. **测试**（`tests/renderer/components/skillInstallPreview.test.tsx`）
   - fixture 的 alpha 内容加入 frontmatter + markdown 结构（标题/加粗/列表）。
   - 「展开」用例改为断言：渲染出语义元素（`heading` role、加粗文本）、无裸 `<pre>`、frontmatter（`name: alpha`）不出现在正文。其余 8 条用例不变。

### 二轮验收门

| 门 | 结果 |
|---|---|
| `npm run typecheck` | 通过（0 错误） |
| `npm run lint` | 0 errors；425 warnings 全为存量，本轮改动文件 `eslint` 单跑 0 警告 |
| `npx vitest run tests/renderer/components/skillInstallPreview.test.tsx` | 9 用例全绿 |

按提示词纪律：改动只追加 commit 到本分支，未 push，收口留给 Claude。
