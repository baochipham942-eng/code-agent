# 定点反馈 Loop（Locality-Anchored Feedback）设计

> 状态：Phase 1（网页 Live Preview）本期实现；Phase 2/3（PPT/表格）设计就绪，实现待与 P0-2 项目空间会话对齐。
> 分支：`feat/locality-feedback`（base = origin/main，含 PR #209 swarm-goal，与本任务无重叠）
> 关联：`docs/research/2026-06-02-coze-codeg-cumora-competitive-analysis.md`（定点反馈 loop 升格为 P0 交互原语）

## 1. 核心论点

Cline Kanban 式"在代码 diff 某一行留 comment → comment 变成喂给 agent 的新指令 → agent 在原 worktree 继续迭代"只适用于**程序员用户**。Neo 的 cowork 非程序员用户看不懂代码 diff，等价原语是：

**在渲染后的产物里圈选元素 → "这里改成 X" → agent 定向迭代。**

交互原语相同（局部锚定反馈，替代整段重新描述的 follow-up），载体从代码 diff 换成渲染后的产物：网页某区块 / PPT 某页 / 表格某单元格。

这**不是**做代码 diff 的 comment 系统。

## 2. 现状核实（70% 基建已有）

| 能力 | 现状 | 文件 |
|------|------|------|
| Web click-to-source bridge | ✅ `vg:select` 带 file/line/column/rect/tag/className/computedStyle | `src/shared/livePreview/protocol.ts` |
| 选区流入 envelope | ✅ iframe 点击 → appStore → composerStore → `envelope.context.livePreviewSelection` | `composerStore.ts:227` |
| 精确定位编辑工具 | ✅ `visual_edit(file,line,userIntent)` / `ppt_edit(slide_index)` / `excel_edit`/`DocEdit(cell)` | `src/main/tools/modules/**` |
| 解耦发送通道 | ✅ `useMessageActionStore.sendPrompt(content)` → `sendMessage(buildEnvelope(content))`，选区随 envelope 自动带出 | `messageActionStore.ts` |

**真缺口（30%，比初始核实多一处）：**

1. **编排断头（核心）**：`envelope.context.livePreviewSelection` 在**主进程侧完全没有被消费**。契约注释自己写着"main 侧消费链路分步接入"。结果：模型根本看不到用户圈选了什么，选区是死数据。
2. **反馈 UI**：当前选区只是被动塞进下一条消息的 envelope，没有"圈选 + 留言 → 定向发给 agent"的主动交互。Web 端有 `TweakPanel`（直接改样式）和"跳转源码"，但没有"自然语言反馈 → agent 迭代"的入口。

## 3. 架构：两层分离

定点反馈 = **选区产生**（per-surface）+ **编排消费**（全产物共用）。把这两层显式分开，是三种产物能复用同一地基的关键。

```
┌─ Layer B: 选区产生（per-surface UI）──────────────────────┐
│  Web  : LivePreviewFrame 选中条 + 内联反馈框   [Phase 1 ✅] │
│  PPT  : design_ppt overlay（WorkspacePreviewPanel）[Phase 2]│
│  表格 : 单元格点击 overlay                       [Phase 3] │
└───────────────────────┬───────────────────────────────────┘
                        │ 选区 + 反馈文本
                        ▼
┌─ Layer A: 编排地基（全产物共用，main 侧）─────────────────┐
│  workbenchTurnContext.ts                                   │
│  注入 <live_preview_selection> block → turnSystemContext   │
│  引导模型自判路由：web→visual_edit / ppt→ppt_edit /        │
│  sheet→excel_edit，file/line/slide/cell 直接用注入值       │
└───────────────────────┬───────────────────────────────────┘
                        ▼  模型自判（system prompt 注入，非前端硬绑）
              visual_edit / ppt_edit / excel_edit 定向迭代
```

**路由策略**（爸拍板）：system prompt 注入选区 + 模型自判用哪个编辑工具。不在前端按产物类型预绑定工具——前端硬绑会绕过 agent loop，且每加一种产物都要前端硬编一套，与现有 agent 编排范式割裂。

## 4. Phase 1 — 网页 Live Preview（本期实现）

### 4.1 Layer A：编排地基（`src/main/app/workbenchTurnContext.ts`）

在 `buildWorkbenchTurnSystemContext` 中新增选区 block：当 `context.livePreviewSelection` 非空时，注入

```
<live_preview_selection>
用户在 Live Preview 里圈选了一个渲染后的元素，本轮消息是针对它的定点反馈。
- 源文件（绝对路径）：<location.file>
- 行号：<location.line>  列号：<location.column>
- DOM 标签：<tag>   组件：<componentName?>
- 可见文本：<text?>
路由指引：用 visual_edit 工具做定向修改，file/line 直接用上面给的值，
userIntent = 用户这条消息的诉求。这是局部锚定反馈——只改这个元素相关的代码，
不要全局重写、不要顺手改别的地方。如果用户这条消息与圈选元素明显无关，忽略本段。
</live_preview_selection>
```

- 复用现有 `<turn_workbench_context>` 包裹机制（与 `designBrief` 注入同一范式）。
- 选区的 `location.file` 已是绝对路径（`LivePreviewFrame.resolveAndSetSelectedElement` 写入 `resolved.absolute`），正好对上 `visual_edit` 的 `file` 入参要求。
- 文案保留"无关则忽略"的逃生口，对齐 turn_workbench_context 既有风格，避免误触发。
- **不加 envelope 字段**：纯消费现成 `livePreviewSelection`。

### 4.2 Layer B：网页反馈 UI（`src/renderer/components/LivePreview/LivePreviewFrame.tsx`）

在现有"选中提示条"（`selected <tag> file:line` + 跳转源码 + 清除）内联追加：

- 一个文本输入框（placeholder "这里改成…"）+ 发送按钮（Enter 提交）。
- 提交时：`useMessageActionStore.getState().sendPrompt(feedbackText)`。选区通过 `composerStore.buildContext() → readActiveLivePreviewSelection()` 自动随 envelope 带出（零额外接线）。
- 提交后清空输入框；保留选区高亮（用户可能连续反馈同一元素）。

不引入新模式开关、不新建面板（爸拍板"复用选中提示条"）。

### 4.3 Phase 1 验收（E2E）

起 dev server（spike-app，装了 `vite-plugin-code-agent-bridge`）→ 预览点击元素 → 选中条出现反馈框 → 输入"把这个按钮改成红色" → 发送 → 验证 agent 调用 `visual_edit`，参数 file/line 对上选中元素，且改对了源文件。参考 `tests/e2e/` 现有 Playwright 范例 + `scripts/acceptance/` headless 方法。

## 5. Phase 2/3 — PPT / 表格（设计就绪，实现待 P0-2 对齐）

### 5.1 两条硬边界（实现前必须与 P0-2 会话对齐）

1. **选区数据塞不进现成字段**：`livePreviewSelection` 的类型 `SelectedElementInfo` 是纯 Web-DOM 形（`location.{file,line,column}` + tag/rect/className/computedStyle）。PPT 的 `slide_index`、表格的 `cell "B7"` 套不进去。
2. **PPT/xlsx 预览长在 P0-2 的组件里**：`design_ppt` / `spreadsheet` 渲染在 `WorkspacePreviewPanel.tsx`（"Workspace Preview 升级为项目维度聚合"是 P0-2 的活）。加圈选 overlay 必须改 P0-2 组件。

### 5.2 推荐方案（不加 envelope 字段，绕开边界 1）

PPT/表格选区**不走结构化 envelope 字段**，而是 Layer B overlay 捕获点击后，把局部锚点**编进消息文本**交给 Layer A 的模型自判路由：

- PPT：点击第 3 页 → 反馈框提交时，content 前缀 `[针对 deck.pptx 第 3 页] ` + 用户诉求 → 模型路由到 `ppt_edit(slide_index=3)`。
- 表格：点击单元格 B7 → content 前缀 `[针对 sheet.xlsx 单元格 B7] ` → 模型路由到 `excel_edit` / `DocEdit(cell="B7")`。

这样 Layer A 的选区注入 block 仍只服务 Web（结构化），PPT/表格走"锚点编进文本 + 模型自判"，**完全不加 envelope 字段**，符合爸的约束。

边界 2（overlay 改 WorkspacePreviewPanel）仍需与 P0-2 对齐归属：要么等 P0-2 聚合预览稳定后我在其上加 overlay，要么 P0-2 预留 overlay 挂载点。**Phase 2/3 不在本期实现。**

## 6. 边界与并行约束（P0-2 项目空间会话）

- 本任务只动 artifact 预览的"交互/编辑"链路，不碰"归属/项目聚合"逻辑。
- `conversationEnvelope.ts` 只用现成 `livePreviewSelection` 字段，**不加新字段**。
- Phase 1 改动文件全部不在 P0-2 范围内：
  - `src/main/app/workbenchTurnContext.ts`（Layer A）
  - `src/renderer/components/LivePreview/LivePreviewFrame.tsx`（Layer B）
- Phase 2/3 触及 `WorkspacePreviewPanel.tsx`（P0-2 文件）→ 实现前停下来对齐。

## 7. 提交纪律

每个功能点 `npm run typecheck`，不跑全量 vitest，commit 不 push，禁止硬编码（选区 block 文案、前缀串若需常量化走 `src/shared/constants.ts`）。
