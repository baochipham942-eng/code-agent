# 设计 Surface 会话化改造 Spec（表单 → 常驻设计 agent 会话）

> **状态**：已拍板，一期实施中（分支 `feat/design-conversational-surface`，基线 `d93e26f93`）。
> **日期**：2026-06-24（2026-06-24 修订：基线、agent-loop-entry 洞察、R2 专属 tab、一期加法）
> **定位铁律**：Agent Neo = cowork 人机协作产品（产物为主轴、对标 Manus），**不是文生图工具**。设计 surface 退回「填参数表单→点生成」与 Neo 自身 agent 定位打架。
> **竞品实证**：Lovart（ChatCanvas = 对话+无限画布）、OpenDesign（studio = 左对话流 + 右画布产物）。截图 `~/Downloads/opendesign-screenshots/`（`02-home.png`、`03-studio-image.png`）。
> **基线已变（2026-06-24）**：PR #281（ADR-027 有界自主）已合入 origin/main（merge `d93e26f93`）。故本刀基线**同时含 ADR-026 + ADR-027**（`proposeCanvasOps` + `RequestDesignAutonomy` + 两个审批条 `CanvasProposalReviewBar`/`CanvasAutonomyReviewBar` 均已焊在 `DesignCanvas` 内）。原"等 #281 合入再 rebase"的风险**已消除**。

## 1. 命题

当前「设计」tab 是一个**全屏表单 surface**：左侧需求字段 + 语气/品牌色/尺寸/生图模型一排控件 + 「生成」按钮（直连出图，一次性）。问题：

1. **范式错位**：竞品是「常驻对话 agent 驱动画布」，Neo 是「填表→点生成」上一代文生图工具皮肤。
2. **触发缺口**：agent 操作画布的能力（ADR-026/027）全建好测好了，**但用户进不去**。
3. **冗余双腿**：Neo 已有会话化设计链路（T5：question-form → DesignBrief），现独立表单是退化路径。

**目标**：把设计 surface 改成「常驻设计 agent 会话 + 画布（预览）+ 会话内 question-form 收集参数」，收口到已有原语。

## 2. 核心洞察：「重新接线」不是「从零造」——但有一个被措辞盖住的真相

三块拼图全部有现成原语（会话/历史 `sessionStore`、预览 tab 体系、question-form→DesignBrief 链 T5、ADR-026/027 工具已注册），agent loop（`useAgentIPC`）模式无关。

**但"几乎零改"盖住的真相（2026-06-24 核出，是本刀真命门）**：**今天设计 surface 根本没有 agent loop 的 UI 入口。**
- 全屏覆盖层 `DesignWorkspace` 里那个 composer 是**表单**，生成按钮 `onGenerate = generateCanvas`（`DesignWorkspace.tsx:220/482`）**直连出图 API，绕开 agent loop**。
- agent loop 唯一 UI 入口是 code 布局的聊天 composer；`workspaceMode==='design'` 时 `DesignWorkspace` 整屏覆盖（`App.tsx:776`）把它盖掉。
- **净结果：设计模式下没有任何路径通向 agent loop。** 缺口物理根源不是"agent 看不见画布"，是"压根没 agent 会话在跑"。

**推论**：单放宽注入闸（R1）对设计 surface **空转**——没有设计会话在跑，注入给谁。故 **R1 必须和"会话入口进设计 surface"绑一起做，不能拆到二期**。

## 3. 改造内容

### R1 — 放宽画布快照注入门（解触发缺口）
- 现状：`useAgentIPC.ts:78` `if (workspaceMode !== 'design') return context`。
- 改为：**`if (!isSessionDesignActive(currentSessionId)) return context`**（按 session 严格闸，保留"画布空不注入"兜底）。决策③：用「设计会话激活」非「画布有节点」，防污染普通编码会话。

### R2 — 画布进 workbench tab（专属 tab id，非 preview: tab）
- 现状：`DesignCanvas`(konva, 1340 行) 活在全屏 `DesignWorkspace` 覆盖层。
- 改为：挂进**专属 `WorkbenchTabId = 'design-canvas'`**（在 `App.tsx` tab switch 渲染，对齐 `task`/`skills`/`context`/`audit` 模式）。
- **修订 spec 原写法**：原写 `preview:design-canvas`，但 `preview:` tab 是 **file-backed**（`PreviewTab` 只带 `path`/`content`），挂不了任意 React 组件。故用专属 tab id。
- 复用：审批条（`CanvasProposalReviewBar`/`CanvasAutonomyReviewBar`）、ghost、变体对比都在 `DesignCanvas` 内，随之进 tab，零改。

### R3 — 表单退役（二期，加法在前删除在后）
- **⚠️ 回归暗坑**：表单不只是图片参数表，是 **4 种媒介（网页/图/演示稿/视频）统一入口**，`onGenerate` 对四者**全部直连**（`generatePrototype`/`generateCanvas`/`generateVideo`）。ADR-026/027 只覆盖画布/图像。
- 故一期**不动表单**（它兜着网页/演示稿/视频）。二期先为其它媒介补 agent 路径，再删表单 composer + 直连入口。god-file `DesignWorkspace`(1056) 借机瘦身。

### R4 — 布局收口（二期）
- 设计 surface = 会话主轴 + 画布预览列（决策②，贴 Lovart/OpenDesign）。退役 `WorkspaceModeSwitch` design 跳转 + `workspaceMode 'design'` 分支。

## 4. 复用清单
- 会话/历史：`sessionStore`、ConversationEnvelope、composer、Turn Timeline
- 问答表单：`question-form` artifact（`artifactExtractor.ts`）、`QuestionFormPreview`、`DesignBrief`（`setSessionDesignBrief`/`getSessionDesignBrief`/`withDesignBriefContext`）
- 预览容器：`WorkbenchTabId`、`openWorkbenchTab`、App.tsx tab switch
- 画布操作：ADR-026（`proposeCanvasOps`）、ADR-027（`RequestDesignAutonomy`）——基线已含，只缺入口
- 出图核：`useDesignCanvasGeneration`、视觉模型注册表

## 5. 已拍板决策（2026-06-24，林晨）
1. **逃生口**：彻底退役——无独立「快速直出」UI，出图统一走会话。
2. **布局**：会话主轴 + 画布预览列（二期目标态）。
3. **R1 注入闸**：设计会话激活才注入（按 session 严格闸）。
4. **分期**：一期 R1+R2（加法）→ 二期 R3+R4（收口）。
5. **一期 loop 入口**：直接切会话布局托画布（聊天 composer 入口，复用 `useAgentIPC`，不建过渡 composer）。

## 6. 分期
- **一期（加法，零回归）**：R1 注入闸（按 session）+ R2 画布进专属 tab + 聊天内「打开设计画布」入口（标记设计会话 + 开画布 tab）。表单覆盖层**原样保留**。让用户能在会话里驱动 ADR-026/027。TDD + headless E2E。详见 `design-surface-conversational-impl-一期.md`。
- **二期（收口）**：为网页/演示稿/视频补 agent 路径 → R3 表单退役 → R4 布局收口 → god-file 瘦身。一期落地后另起 detailed plan。

## 7. 风险
- R1 注入门误污染编码会话（用按-session `isSessionDesignActive` 严格闸）。
- `DesignWorkspace`/`DesignCanvas` god-file（1056/1340 行），搬迁遵拆分纪律。
- 一期 `workspaceMode` 与 `isSessionDesignActive` 双信号并存（过渡态，二期收敛）。
- `DesignCanvas` standalone 挂载可能缺 `DesignWorkspace` 提供的隐式上下文（含 `loadCanvasDoc` 加载 effect）——一期 E2E 兜。
- 付费出图 dogfood 默认只跑一次、付费前向林晨确认。

## 8. 工作纪律
origin/main 独立 worktree、TDD、独立 context 对抗审计修 HIGH/MED、PR 等 CI 全绿不擅自合、更新本 spec 与 `design-roadmap.md` 进度。
