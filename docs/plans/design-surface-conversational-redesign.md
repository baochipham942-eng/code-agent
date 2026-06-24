# 设计 Surface 会话化改造 Spec（表单 → 常驻设计 agent 会话）

> **状态**：一期完成 + 真机 dogfood 收口（含部分二期：设计模式收口/意图驱动/秒关等），HEAD `c3ae5b5c4`，22 commit，待 push/PR。分支 `feat/design-conversational-surface`，基线 `d93e26f93`。详细进度与待办见 `design-roadmap.md` 2026-06-24 条目。
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
- 遗留全屏表单 surface（`workspaceMode==='design'`）**不参与会话化属主语义**：它不调 `claimCanvasForSession`/`markSessionDesignActive`，但它是表单路径（不走 agent loop、用直连出图、不发 `proposeCanvasOps`），故读注入失效与写路径 owner 闸都不从这触发，无害（L1-R2）。二期退役表单时一并收口。

## 8. 工作纪律
origin/main 独立 worktree、TDD、独立 context 对抗审计修 HIGH/MED、PR 等 CI 全绿不擅自合、更新本 spec 与 `design-roadmap.md` 进度。

---

## 9. 二期设计（2026-06-24 林晨拍板，3 个 PR）

> 一期 + 真机 dogfood 收口已合进 PR #282（OPEN，基线 `d93e26f93`）。二期在它之上继续。**基线**：PR #282 未合且是地基（ProposeCanvasOps 接线 / executionIntent 透传 / affordance 服务端注入 / `ownerSessionId` 属主闸都在它上面），故二期 worktree 基于 `feat/design-conversational-surface` 起；#282 落 main 后把后续 PR rebase。

### 9.0 拍板结论（4 岔路 + 1 追加）
1. **分期顺序**：拆 3 个 PR，**先做主轴**（媒介 agent 路径 2b）→ 鲁棒性（2a）→ 收口（2c）。每个独立 PR、独立审计、各自 CI/测试绿。
2. **文档型产物落点**：网页/演示稿落**预览 tab**（贴 OpenDesign「左对话 + 右产物 tab」）；图片/视频落**画布节点**。画布保持「视觉合成」纯语义。
3. **出图失衡处理**：**健康优先选型 + 单步兜底**（详见 2a #3）。billing 红线=最多 +1 次、真实成本如实回传、绝不静默多扣。
4. **表单退役节奏**：**先降级保留、dogfood 实证后再删**（加法在前、删除在后、留回退窗口）。
5. **【追加】成本确认搬进对话区**：付费生成的「消耗 ¥X 确认」弹窗做成**会话内交互卡**，不再落画布审批条/`window.confirm` 抢焦点；产物仍落画布/预览 tab。

### 9.1 媒介 agent 路径现状（探子核实，file:line 见 2b 计划）
| 媒介 | 引擎 | agent 工具 | 现状落点 | 距离会话化 |
|---|---|---|---|---|
| 图 | `imageGenerationService` | ✅ `ProposeCanvasOps`(ADR-026) | 画布节点 | 已通 |
| 视频 | `videoGenerationService`（独立可调） | ❌ 无 | 表单直连 IPC | 加 `ProposeVideoOps`→画布 `KonvaVideoNode` |
| 演示稿 | `slidesGenerator`（独立可调） | ❌ 无 | 表单直连 IPC | 加 `ProposeSlidesOps`→预览 tab |
| 网页 | agent 写 HTML（`dispatchToRun`） | ～（程序化进 loop，非工具/非对话） | iframe 预览 tab | 最近：确认会话化通路 + 预览 tab 接好 |

### 9.2 PR 2b — 媒介 agent 路径 + 成本确认搬进对话（主轴，先做）
- 视频 → 画布节点：新增 `ProposeVideoOps`，复用 ProposeCanvasOps 桥接（tool→IPC→落 `KonvaVideoNode`）。**硬约束**：视频永不进 ADR-027 自主信封，每次必人审批 + 出图前显示预估 ¥。
- 演示稿 → 预览 tab：新增 `ProposeSlidesOps`，调 `slidesGenerator`（大纲免费 / illustrate 出图才付费），产物 = pptx + 预览，落专属 workbench 预览 tab。
- 网页 → 预览 tab：会话化通路确认 + affordance 扩展到「写 HTML 落地页 → 预览 tab」，验证为主、少量接线。
- **成本确认共享原语**：建一个「会话内成本确认」原语，复用 `AskUserQuestion` 的阻塞 round-trip（`USER_QUESTION_ASK/RESPONSE`，双模式已通），渲染对话流卡片「本次生成消耗 ¥X，是否继续？[确认][取消]」。三媒介统一走它；图像把现有 `CanvasProposalReviewBar` 的**花钱确认**迁进对话；视频/标注替换 `window.confirm`。自主预算信封（ADR-027）保留画布（预授权域语义）。
- **接线必做（dogfood 血泪）**：① 新工具注册进 CORE/DEFERRED + designCanvasActive 提进基础表；② 媒介意图沿 `executionIntent` 在 web HTTP 路径透传；③ `canvasSessionReminder` 扩到网页/演示稿/视频；④ 每条新 IPC 写路径过 `ownerSessionId` 属主闸 fail-closed。
- 详见 `design-surface-conversational-impl-phase2b.md`。

### 9.3 PR 2a — 鲁棒性三件（各自独立、低风险）
- **#3 出图健康优先 + 单步兜底**：默认只在「已配 key」模型里选；抽 `classifyImageGenerationError`（复用 `modelRouterPolicy` 的 quota/auth/network 模式）→ 余额/鉴权类自动换下一个健康模型重试**一次**（非循环），真实累计成本 sum 回传；仍失败给清晰分类提示。affordance 告诉 agent 已自动兜底、别自己循环换模型。
- **#4 草稿去重**：`findReusableNewSessionDraft` 改「空草稿（message/turn=0）无视标题即复用」或令 ConversationJudge 不给空草稿改名。web 侧为主。
- **#5 历史污染迁移**：复用 `migrations.ts` 加幂等 strip（`messages.content` 以设计 affordance marker 开头→剥离），事务 + 批处理 + best-effort 不抛。**实现前先核实真实 marker 字符串与 web/electron DB 落点**。

### 9.4 PR 2c — 表单退役 + 布局收口 + god-file 拆分 + 打磨
- 表单先降级隐藏 → dogfood 实证三媒介稳后删 DesignWorkspace 直连 `onGenerate` + 退役 `workspaceMode 'design'` 全屏覆盖 + `WorkspaceModeSwitch` design 跳转。
- 布局收口「对话主轴 + 画布/网页/演示稿 预览 tab 列」（§9.0.2 图）。
- god-file 拆分：DesignWorkspace→~500 行；DesignCanvas→~700 行（抽 `CanvasOverlays`/`useCanvasPanZoom`/`useCanvasKeyboardShortcuts`/`ProposalAndAutonomyOverlays`/`CanvasEditPanel`，**避开 diagram/annotation 高耦合两块**）；同步删 `architectureDebtReport` 白名单。
- 设计入口一等可发现性 + 视觉打磨。
