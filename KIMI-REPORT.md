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
