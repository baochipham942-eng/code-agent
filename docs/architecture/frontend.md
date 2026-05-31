# 前端架构

> Tauri 2.x + React 18 + Zustand + Tailwind CSS

## 平台

桌面端基于 **Tauri 2.x**（Rust），替代早期的 Electron 方案。Tauri 壳层（`src-tauri/src/main.rs`）负责：

- 启动 Node.js Web Server 子进程
- System Tray 菜单（新建对话 / 粘贴上下文 / 退出）
- 全局快捷键 `Cmd+Shift+A` → 唤起窗口 + 触发 MemoFloater
- 通过 Tauri 事件总线（`memo:activate`、`memo:new_chat`、`memo:paste_context`）与前端通信

---

## 整体布局

```
┌────────────────────────────────────────────────────────┐
│  TitleBar  [Workspace] [Session Actions] [Task]         │
├──────┬──────────────────────────┬──────────────────────┤
│      │  ChatView                │  WorkbenchTabs ▸     │
│ Side │  ┌─ ChatSearchBar ─────┐ │  ├─ Task             │
│ bar  │  │ TurnBasedTraceView  │ │  ├─ Skills           │
│      │  │  └─ TurnCard[]      │ │  ├─ Files            │
│      │  │                     │ │  └─ Preview·(多tab)  │
│      │  ├─ ContextIndicator ──┤ │                      │
│      │  └─ ChatInput ────────┘ │                      │
├──────┴──────────────────────────┴──────────────────────┤
│  Sidebar User Menu: Eval / Lab / Automation / Desktop / Browser / Validation / Prompt │
├────────────────────────────────────────────────────────┤
│  StatusBar                                             │
└────────────────────────────────────────────────────────┘
MemoFloater（全局浮窗，Cmd+Shift+A 唤起）
```

布局使用 `react-resizable-panels` 实现可拖拽的多栏分割。**右侧工作面板统一**：Task / Skills / Files / Preview 共享同一宿主容器，由 `WorkbenchTabs` 顶栏切换，不再各自独立抢宽度。

### 右侧工作面板（v0.16.60-65+）

| 层 | 文件 | 职责 |
|----|------|------|
| 宿主 | `App.tsx` | `activeWorkbenchTab === 'task' → TaskPanel`，`'skills' → SkillsPanel`，`'files' → FileExplorerPanel`，`isPreviewActive → PreviewPanel` |
| 顶栏 | `components/WorkbenchTabs.tsx` | tab bar 组件，显示当前 tab 列表 + 关闭按钮；X 关闭后自动切到幸存 tab |
| Store action | `stores/appStore.ts` | `openWorkbenchTab(id)` / `closeWorkbenchTab(id)` 单一入口，替代旧的 `show*Panel` 分散 action |
| Preview tab 注册表 | `appStore.previewTabs` | 每个已打开文件一个 entry（content + dirty + LRU），`MAX_PREVIEW_TABS = 8` 上限，满时淘汰最久未使用 |

**迁移说明**：legacy `showTaskPanel / showSkillsPanel / showPreviewPanel` 及对应 toggle（CloudTaskToggle / TaskListToggle / DAGToggle / ObservabilityToggle）已全部移除。TitleBar 只保留 File Explorer / Skills / Task 三个入口，通过 `openWorkbenchTab` 触发。

2026-04-26 之后，TitleBar 进一步瘦身：全局页面入口（Eval / Lab / Automation / Agent Flow / Desktop）进入 Sidebar User Menu；关闭后的 Task/Skills/Files 可通过 `WorkbenchTabs` 右侧的 `+` 原地重开。

---

## 核心数据流：Turn-Based Trace

消息渲染已从扁平消息列表切换为 **Turn-based Trace 视图**：

```
messages[] ──useTurnProjection──▸ TraceProjection { turns[], activeTurnIndex }
                                      │
                              TurnBasedTraceView
                                      │
                              TurnCard[] ──▸ TraceNodeRenderer
                                               ├─ MessageContent（Markdown）
                                               ├─ ToolCallDisplay
                                               ├─ PermissionCard（内联）
                                               └─ InlinePlanCard
```

| 层级 | 文件 | 职责 |
|------|------|------|
| Hook | `hooks/useTurnProjection.ts` | 纯 `useMemo` 派生：将 `Message[]` 投影为 `TraceTurn[]`，按 user→assistant 轮次分组 |
| 容器 | `chat/TurnBasedTraceView.tsx` | 渲染 Turn 列表、自动滚底、加载历史消息、搜索高亮 |
| 卡片 | `chat/TurnCard.tsx` | 单个 Turn 的卡片，包含 TraceNode 渲染器 |
| 节点 | `chat/TraceNodeRenderer.tsx` | 根据 TraceNode 类型分发到不同子组件 |

v0.16.74 起，TurnCard 会从 `turnTimeline.kind === 'hook_activity'` 的节点里提取 Hook Activity，并在用户提示词下方展示本轮 hook 执行摘要。展示内容包括 hook 数量、allow/block 状态、错误数、是否改写输入、总耗时和按事件分组的 chip。

### Run Status Rail

`ChatView` 在 trace 上方挂载 `TaskStatusBar`，只在后台任务、队列或 Agent Team 活跃时出现。它读取 `taskStore / sessionStore / appStore / swarmStore`，展示 running/max concurrency、queued 数、活跃 session chip、swarm chip 和进度条；用户点击可以跳到对应 session，或打开 TaskPanel / Agent Team。

| 层 | 文件 | 职责 |
|----|------|------|
| 挂载 | `components/ChatView.tsx` | 在聊天主界面顶部插入 `TaskStatusBar` |
| 状态栏 | `components/features/chat/TaskStatusBar.tsx` | 聚合 task/session/swarm 状态并渲染轻量 rail |
| 数据来源 | `taskStore / sessionStore / appStore / swarmStore` | running、queued、active session、swarm 活跃态 |

### TaskPanel task-first rail

`TaskPanel` 当前只渲染 `TaskMonitor`，定位已经从“高级控制台”转为 task-first 状态工作面。它过滤底层工具噪音，把当前任务、后台任务、scheduled tasks、approval、outputs、context、MCP、memory、capability sheet 合并成右侧可扫描状态。

| 层 | 文件 | 职责 |
|----|------|------|
| 宿主 | `components/TaskPanel/index.tsx` | 右侧 Task tab 的单一入口 |
| 主体 | `components/TaskPanel/TaskMonitor.tsx` | 组合 run workbench cards、scope inspector、connector/context 状态 |
| 数据模型 | `hooks/useRunWorkbenchModel.ts` | 合并当前 turn、task、swarm、approval、outputs、context 等来源 |
| 展示规则 | `utils/taskRailPresentation.ts` | 过滤工具性步骤，派生用户能理解的 task rail 文案和状态 |
| 卡片 | `components/TaskPanel/RunWorkbenchCards.tsx` | 渲染当前动作、检查项、产物、待审项 |

---

## 关键组件

### 消息气泡 (MessageBubble)

`features/chat/MessageBubble/` 目录：

| 组件 | 文件 | 职责 |
|------|------|------|
| **MessageContent** | `MessageContent.tsx` | Markdown 渲染（react-markdown + remark-gfm/math + rehype-katex），代码块路由 |
| **ToolCallDisplay** | `ToolCallDisplay/` | 工具调用折叠面板（含 ResultSummary、ToolCallGroup） |
| **AttachmentPreview** | `AttachmentPreview.tsx` | 消息附件展示（图片/PDF/代码/数据/文件夹），内嵌 SpreadsheetBlock/DocumentBlock |
| **CoworkMessageBubble** | `CoworkMessageBubble.tsx` | 多 Agent 协作消息 |
| **SkillStatusMessage** | `SkillStatusMessage.tsx` | Skill 执行状态消息 |
| **ContentPartsRenderer** | `AssistantMessage.tsx` | 按服务端 `contentParts` 顺序**交错渲染**正文与工具调用（连续 tool_call 自动分组）；无 contentParts 时回退旧的「正文 + toolCalls 两段」模式。详见文末「2026-05-26~27 增量」 |

### Generative UI（富内容渲染）

MessageContent 通过 markdown 代码块的语言标签路由到不同渲染组件：

```
```chart          → ChartBlock
```json           → ChartBlock（仅当内容命中 chart spec：type∈{bar,line,area,pie,radar,scatter} + data 数组）
```generative_ui → GenerativeUIBlock
```spreadsheet   → SpreadsheetBlock
```document      → DocumentBlock
```mermaid       → MermaidDiagram
```

| 组件 | 文件 | 说明 |
|------|------|------|
| **ChartBlock** | `ChartBlock.tsx` | 基于 Recharts，支持 6 种图表（bar/line/area/pie/radar/scatter），暗色主题，JSON spec 驱动。图表在聊天内联渲染，不再生成 HTML 文件；除 ` ```chart` 外，` ```json` 代码块经 `isChartSpecSource()` 命中也改渲为图表（应对模型习惯用 json 包 spec） |
| **GenerativeUIBlock** | `GenerativeUIBlock.tsx` | 沙箱 iframe 渲染 AI 生成的 HTML 小程序，自动注入暗色样式，postMessage 动态调整高度 |
| **SpreadsheetBlock** | `SpreadsheetBlock.tsx` | 交互式表格查看器，多 Sheet 切换，列选中，支持排序/筛选 |
| **DocumentBlock** | `DocumentBlock.tsx` | 文档查看器，段落选中 + 操作栏（复制/编辑/删除），支持 Word 附件（mammoth HTML）和 JSON spec |

### ChatInput 输入系统

`features/chat/ChatInput/` 目录：

| 组件 | 职责 |
|------|------|
| **index.tsx** | 主输入框容器，组合子组件 |
| **InputArea** | 文本输入区域 |
| **InputAddMenu** | `+` 二级菜单：上传附件、打开 slash command、切换 Code/Plan/Ask |
| **AttachmentBar** | 已添加附件的预览条（支持文件/文件夹/图片/代码等分类图标） |
| **useFileUpload** | 文件上传 hook（拖拽 + 按钮），解析为 `MessageAttachment` |
| **SlashCommandPopover** | 输入 `/` 时弹出的内联命令面板（替代全屏 CommandPalette） |
| **ComboSkillCard** | Combo Skill 录制建议卡片 — 检测到可重复工作流时在输入框上方建议保存 |
| **VoiceInputButton** | 语音输入按钮 |
| **SendButton** | 发送按钮 |
| **ReportStyleSelector** | 报告样式选择器 |
| **SuggestionBar** | 建议栏 |

当前 ChatInput 常驻项按 B+ 口径收敛为：`+`、权限模式、上下文用量、模型+effort+engine 胶囊、语音、发送。Routing / Browser 已移入 Settings “对话”tab；Live Preview 已移入 session/workspace 级入口。

Prompt Rewind 需要把历史用户提示词重新放回输入框，所以 `ChatInputHandle` 暴露 `setDraft({ content, attachments })` 和 `focus()`；`ChatView` 在 `rewindToPrompt` 成功后调用它，并用返回的 `activeMessages` 刷新当前会话消息。

### Settings 信息架构

2026-04-26 后，Settings 不再是平铺 tab 列表。`settingsTabs.ts` 定义稳定 tab id、默认 tab、分组顺序和 tab -> group 映射；`SettingsModal` 通过 `buildSettingsTabGroups()` 渲染分组导航，并支持从搜索或 store 里的 `settingsInitialTab` 直接跳转。

`SettingsLayout` 提供 `SettingsPage` / `SettingsSection` / `SettingsDetails` 三个轻量页面骨架。MCP 设置页优先展示可操作配置，把 Local Bridge、Native Connectors、运行状态和诊断信息收进结构化 section/details，避免把低频诊断淹没主要设置流。

v0.16.74 新增 `HooksSettings`：位于"能力与连接"分组，调用 `domain:hook/list` 展示已启用 Hook、未启用事件、global/project 配置路径，并提供打开配置文件和 Finder 定位。不存在配置文件时，主进程会创建空的 hooks 模板。

### 2026-05-15~17 Settings / Engine / Validation 前端增量

| 能力 | 前端入口 | 数据来源 |
|------|----------|----------|
| 模型配置 onboarding | `ModelOnboardingModal` 在登录/注册后引导配置 Provider API Key；`AuthModal` 可触发 signup-first 流 | `settings.ipc.ts` + `ModelSettings` |
| Agent Engine 选择 | `ModelSwitcher` 合并模型、reasoning effort 和 Native/Codex/Claude engine；engine 状态显示安装、运行、权限和风险说明 | `agentEngine.ipc.ts` + `sessionStore.updateSessionEngine()` |
| Capability Center | `CapabilityCenterSettings` 展示本地 registry、requirements、risk、install plan、disabled MCP draft 安装/删除和跳转设置动作 | `capability.ipc.ts` + `useCapabilityInventory()` |
| 记忆管理 | `MemoryTab` + `MemoryEntriesManager` 管理记忆条目、导入、注入状态；`KnowledgeMemoryPanel` 负责工作台里的 audit 视图 | `memory.ipc.ts` + `memoryEntryRuntime` |
| Workspace 设置 | `WorkspaceSettings` 管 recent directories、default open target、bridge/shell 状态和本地 workspace 行为 | `workspace.ipc.ts` + `settings.contract` |
| Automation 设置 | `AutomationSettings` 把 cron/hook/自动化入口收进设置面，避免聊天页堆低频控制项 | `settingsTabs.ts` |
| Data 设置 | `DataSettings` 展示 telemetry storage 与 collector health，保留调试快照/数据治理入口 | `telemetry.ipc.ts` + `data.ipc.ts` |
| In-App Validation | `InAppValidationPanel` 在右侧面板展示 iframe、步骤执行、pass/fail 和错误；`useInAppValidationBridge()` 接收 main 发起的验证请求 | `inAppValidation.ipc.ts` + `browserInteraction` contract |
| Browser Surface | `BrowserSurfacePanel` 从 Sidebar 打开，展示 managed browser/relay readiness 和当前浏览器工作面 | `desktop.ipc.ts` + `browserRelayService` |
| Admin 管理页 | `UserDashboardSettings` 和 `InviteCodesSettings` 只对 admin 可见；前端 `accessControl` 只负责入口可见性，后端 IPC guard 才是硬边界 | `admin.ipc.ts` + `adminGuard` |
| Update 设置 | `UpdateSettings` 展示 Tauri updater 状态；启动时只在需要处理的更新状态提示用户 | Tauri updater + `updatePrompt.ts` |

### Prompt Manager

`components/features/prompts/PromptManagerModal.tsx` 是 prompt override 的前端入口，由 Sidebar User Menu 打开。

| 区域 | 职责 |
|------|------|
| 左侧列表 | 调 `domain:prompt/list`，按 category 分组展示 prompt，override 状态用圆点标记 |
| 右侧详情 | 调 `domain:prompt/get`，同时展示默认文本和当前生效文本 |
| 底部动作 | `set/reset` 保存或恢复 override，保存目标为 `~/.code-agent/prompts-overrides/<id>.md` |
| 验证口径 | UI 文案明确"下一轮对话立即生效"，依赖 main 侧 `applyOverride()` + `dynamic()` |

### 附件系统

文件上传到消息展示的完整链路：

```
用户拖拽/选择文件
    → useFileUpload（解析文件类型、分类）
    → AttachmentBar（输入框上方预览）
    → 发送消息（MessageAttachment[]）
    → AttachmentPreview（消息气泡内展示）
        ├─ 图片 → 内联预览
        ├─ Excel → SpreadsheetBlock
        ├─ Word → DocumentBlock
        └─ 其他 → 文件卡片
```

### 聊天搜索 (ChatSearchBar)

`features/chat/ChatSearchBar.tsx` — 会话内消息搜索（`Cmd/Ctrl+F`）：
- 基于 `TraceProjection` 搜索所有 Turn/Node 内容
- 匹配结果高亮 + 上下翻页导航
- 通过回调通知 ChatView 滚动到匹配位置

### 上下文指示器 (ContextIndicator)

`features/chat/ContextIndicator.tsx` — 输入框上方的紧凑 token 用量条：
- 从 `appStore.contextHealth` 读取数据
- 仅在用量 > 50% 时显示
- 三级颜色：绿（正常）/ 黄（warning）/ 红（critical）

---

## 文件浏览器 (FileExplorer)

| 文件 | 职责 |
|------|------|
| `features/explorer/FileExplorerPanel.tsx` | 文件树 UI，多 Tab 支持，文件类型图标，通过 IPC 调用 `workspace.listFiles`；内联 New File / New Folder 直接在树内操作；点击文件调用 `openOrFocusTab` action |
| `stores/explorerStore.ts` | Zustand Store：Tab 管理、目录缓存（`dirContents`）、展开/折叠状态、文件选中 |

面板挂载在统一右侧工作面板内（由 `activeWorkbenchTab === 'files'` 命中），不再是独立分栏。切换 session 时 Explorer 自动跟随 `workingDirectory`，不需要手动 reload。

**原生文件选择器**：`workspace:selectDirectory` IPC 通过 `@tauri-apps/plugin-dialog` 调起系统原生选择器（Tauri 端）或走 domain API fallback（Web 端），renderer 不再自绘弹窗。

## 预览面板 (PreviewPanel)

`components/PreviewPanel.tsx` — 多 tab 预览器，基于 `appStore.previewTabs` 注册表渲染。

| 能力 | 实现 |
|------|------|
| 多 tab + LRU | `MAX_PREVIEW_TABS = 8`，超出按最近未使用淘汰；tab 顺序稳定 |
| 代码编辑 | ts/tsx/js/jsx/json/yaml/yml 用 **CodeMirror 6** 呈现，带语法高亮 |
| Markdown 编辑 | md/csv/tsv/txt 可切编辑模式（CodeMirror 6） |
| CSV/TSV 表格 | 表格视图，列宽自适应 |
| 图片 / PDF | base64 data URL 内嵌渲染，无需外部文件服务 |
| Reveal / Open | 头部按钮调 `@tauri-apps/plugin-opener` 在 Finder 中 reveal 或用系统默认应用打开 |

## Workspace Preview Panel

`components/WorkspacePreviewPanel.tsx` 是会话级 artifact preview workbench，不只是预览列表。它展示 preview item、正文和 Design PPT renderer；6/1 后产品级质量状态不再走旧 Delivery Review / Preview Feedback 前端链路，而是进入 `ArtifactIssue` / Admin Review Queue。

| Preview kind / 区域 | 职责 |
|------|------|
| `designBrief` / `questionForm` | Design Brief 链路的结构化意图和问卷预览 |
| `design_ppt` | `DesignPptPreview` 展示 slides、theme、iterations、截图网格、prompt/code path，并提供 Open PPTX / Edit code |
| Artifact quality | checker-level verifier 可作为证据来源，产品级 issue 由 `ArtifactIssueRepository` 和 admin review route 承载 |
| Acceptance 状态 | game/deck/dashboard verifier 不单独开页面；release gate 看 artifact issue / replay quality report |

## Live Preview 面板

`components/LivePreview/` 目录承载 Vite-only Live Preview V2：

| 组件 / 模块 | 职责 |
|------|------|
| `DevServerLauncher.tsx` | 选择/探测项目，启动 dev server，等待 ready，读取 logs |
| `LivePreviewFrame.tsx` | iframe 预览、bridge postMessage 校验、selection restore/stale 处理 |
| `TweakPanel.tsx` | spacing / color / fontSize / radius / align 五类 Tailwind 原子样式修改 |
| `src/shared/livePreview/protocol.ts` | `vg:ready / vg:select / vg:restore-selection / vg:selection-stale` 协议，0.3.0 增加 `className / computedStyle` |
| `src/shared/livePreview/tweak.ts` | TweakPanel 与 main IPC 共享的操作 DTO |

V2 不承诺 Next.js App Router 支持；原因见 ADR-012。

## Semantic Tool UI

工具调用展示不再只依赖工具名。当前 UI 读取 ToolCall 顶层的语义字段：

| 字段 / 组件 | 职责 |
|------|------|
| `shortDescription` | ToolHeader 和 grouped tool step 的主标题，来自模型 `_meta` 或 fallback generator |
| `targetContext` | `TargetContextIcon` 显示 Browser / Computer / MCP / app / file 等目标上下文 |
| `MemoryCitationGroup` | 折叠展示 memory citation 的 rationale 与来源 |
| `SessionDiffSummary` | 聚合当前 session 的文件变更数 |
| `LinkPreviewCard` | raw URL 渲染为 favicon chip |

---

## 备忘浮窗 (MemoFloater)

`features/memo/MemoFloater.tsx` — 全局热键唤起的快速输入浮窗：

- 监听 Tauri 事件：`memo:activate`（显示浮窗）、`memo:new_chat`（新建对话）、`memo:paste_context`（粘贴剪贴板为上下文）
- 发送消息通过 `iact:send` 自定义事件，创建会话通过 `sessionStore`
- 仅在 Tauri 模式下激活

---

## 状态管理 (Zustand)

```
stores/
├── sessionStore.ts         # 会话状态（messages, currentSession, 历史消息加载）
├── appStore.ts             # 全局 UI 状态（isProcessing, activeWorkbenchTab, previewTabs[LRU 8], contextHealth）
├── authStore.ts            # 认证状态
├── explorerStore.ts        # 文件浏览器状态（tabs, dirContents, expanded）
├── taskStore.ts            # 任务状态
├── uiStore.ts              # UI 偏好
├── sessionUIStore.ts       # 会话 UI 状态（含 sidebar workspace grouping 折叠状态）
├── modeStore.ts            # 模式状态
├── permissionStore.ts      # 权限请求状态
├── localBridgeStore.ts     # 本地桥接状态
├── skillStore.ts           # Skill 面板状态
├── evalCenterStore.ts      # 评测中心状态
├── captureStore.ts         # 桌面捕获状态
├── swarmStore.ts           # Multi-Agent 状态
├── dagStore.ts             # 工作流 DAG 状态（已无 DAGToggle 入口，保留供 TaskPanel 复用）
├── cronStore.ts            # 定时任务状态
├── statusStore.ts          # 状态栏
├── selectionStore.ts       # 选中状态
├── telemetryStore.ts       # 遥测状态
├── composerStore.ts        # 发送前临时上下文（workspace/routing/skills/connectors/MCP 选择）
├── messageActionStore.ts   # 消息气泡内联操作状态
└── turnExecutionStore.ts   # Turn 维度 ephemeral routing evidence buffer
```

---

## useAgent Hook 事件处理

```typescript
// hooks/useAgent.ts — 监听 IPC 事件: agent:event

case 'turn_start':     // 创建新的 assistant 消息
case 'stream_chunk':   // 流式追加文本到当前 turn
case 'tool_call_start':// 工具状态 → running
case 'tool_call_end':  // 通过 toolCallId 匹配，更新 result
case 'permission_request': // 显示内联 PermissionCard
case 'agent_complete':     // 解锁输入
```

---

## 2026-05-26~27 增量 — Alma 式渲染 + neo:// 深链 + Computer-use PiP

这一轮借鉴 alma 把聊天主链路的渲染与交互做了一批增量，覆盖消息渲染顺序、流式观感、应用内导航和控屏可视化。前端版本基准 v0.16.88。

| 能力 | 落点 | 说明 |
|------|------|------|
| **contentParts 交错渲染** | `MessageBubble/AssistantMessage.tsx`（`ContentPartsRenderer`） | 服务端 stream/message 事件携带 `contentParts`（`useConversationStreamEffects.ts` 透传），前端按原序遍历交错渲染「正文 / 工具调用」，连续 tool_call 自动分组。修复了 WebSearch 折叠块落到答案下方的顺序倒置。无 `contentParts` 时回退旧两段模式 |
| **流式动效 + 安静思考态** | `styles/global.css`（`.streaming-text` 动画）+ `StreamingIndicator.tsx` | 新内容块淡入上浮（`cubic-bezier(0.22,1,0.36,1)`），末块呼吸光标；StreamingIndicator 仅在工具真跑久（45s+）才升级为 `long-tool` 警示，健康长生成不再变色/告警；正文流式时光标由正文自带，状态槽隐去避免重复 |
| **回到底部浮按** | `TurnBasedTraceView.tsx` | `isAtBottom` 状态机：上滚离底→浮出箭头按钮，贴底自动隐藏；点击经 Virtuoso `scrollToIndex({align:'end'})` 跳到最后一条 |
| **内联图表** | `MessageBubble/MessageContent.tsx`（`ChartBlock` 路由） | 图表改为聊天内联渲染（` ```chart` / 命中 spec 的 ` ```json`），不再生成 HTML 文件。详见上文 Generative UI 章节 |
| **外链可点击（Tauri）** | `utils/platform.ts`（`openExternalLink`）+ `capabilities/default.json` | Tauri 下拦截 `<a>` 点击：http(s)→`opener.openUrl` 走系统浏览器、本地文件→`opener.openPath`；web 模式返回 false 让浏览器接管。Tauri capability 补 `opener:allow-open-url` |

### neo:// 深链卡片（WS2 — IACT 导航）

`neo://` 是应用内导航协议，让模型在回答里直接给出可点击的导航/动作卡片（IACT = inline action 契约）。

- **协议定义**：`src/main/prompts/identity.ts` 的 `CONCISENESS_RULES > <inline_actions>` 块。核心两类：`[label](neo://thread/{sessionId|new})` 打开/切换/新建会话；`[label](neo://settings/{tab})` 跳设置页（tab 经 `SETTINGS_TAB_IDS` 白名单校验）。另有 `!send / !add / !run / !open / !copy` 等内联动作。
- **渲染**：`MessageBubble/MessageContent.tsx` 的 `IACTNavCard` 解析 `neo://` head/arg，调 `useSessionStore` / `useAppStore` 执行导航，渲染为带图标的内联按钮；未识别链接退化为纯文本，不渲染破卡片。
- **净化白名单**：react-markdown v10 默认 `urlTransform` 会把 `neo://` 剥空，故加 `neoUrlTransform` 显式放行 `neo://`，其余仍走 `defaultUrlTransform`。

### Computer-use PiP 窗口（WS3 — 实时可视化）

agent 跑 computer-use（控屏）时，弹一个画中画窗口实时展示截图帧流，让用户看见 agent 在操作什么。

- **Rust 侧**（`src-tauri/src/pip.rs`）：三命令 `pip_show` / `pip_frame(dataUrl)` / `pip_hide`。窗口 320×220、右上角悬浮、透明无边框、`ignore_cursor_events`（穿透不拦交互）；macOS 设 NSWindow level 1000 + 所有 Space 可见，复用 appshots overlay 窗口范式。
- **Renderer 接线**（`hooks/useComputerUsePip.ts`，在 `App.tsx` 顶层与 `useAppshots` 并列挂载）：监听 `agent:event` 里带 `computerSurfaceSnapshot.screenshotPath` 的 `tool_call_end`（不依赖工具名）→ 首帧 `pip_show`、逐帧 `appshots_read_image_data_url` 转 dataURL 再 `pip_frame`；`agent_complete/cancelled/stream_end/error` 时 `pip_hide`。读图失败/非 Tauri 静默 no-op。

---

## 文件结构

```
src/renderer/
├── App.tsx                        # 根组件，PanelGroup 布局
├── components/
│   ├── ChatView.tsx               # 主聊天视图，集成搜索/Trace/输入
│   ├── Sidebar.tsx                # 会话列表 + 搜索
│   ├── TitleBar.tsx               # 标题栏
│   ├── PreviewPanel.tsx           # 预览面板
│   ├── DiffView.tsx               # Diff 视图
│   ├── CommandPalette.tsx         # 命令面板
│   ├── StatusBar/                 # 状态栏组件组
│   ├── PermissionDialog/          # 权限卡片
│   ├── features/
│   │   ├── chat/
│   │   │   ├── TurnBasedTraceView.tsx   # Turn-based 消息列表
│   │   │   ├── TurnCard.tsx             # 单 Turn 卡片
│   │   │   ├── TraceNodeRenderer.tsx    # Trace 节点渲染器
│   │   │   ├── ChatSearchBar.tsx        # 会话搜索
│   │   │   ├── ContextIndicator.tsx     # 上下文用量指示器
│   │   │   ├── ConversationTabs.tsx     # 多 Tab 对话
│   │   │   ├── ChatInput/              # 输入系统（见上文）
│   │   │   └── MessageBubble/          # 消息气泡 + Generative UI
│   │   ├── explorer/
│   │   │   └── FileExplorerPanel.tsx    # 文件浏览器
│   │   ├── memo/
│   │   │   └── MemoFloater.tsx          # 备忘浮窗
│   │   ├── evalCenter/                  # 评测中心
│   │   ├── lab/                         # 学习实验室
│   │   ├── workflow/                    # 工作流 DAG
│   │   ├── capture/                     # 桌面捕获
│   │   ├── background/                  # 后台任务
│   │   ├── memory/                      # 记忆学习
│   │   ├── sidebar/                     # 侧边栏功能
│   │   ├── voice/                       # 语音功能
│   │   └── settings/                    # 设置面板
│   │
│   ├── composites/                # 复合组件
│   └── citations/                 # 引用展示
│
├── hooks/
│   ├── useAgent.ts                # Agent 通信 Hook
│   ├── useTurnProjection.ts       # Message[] → TraceTurn[] 投影
│   ├── useKeyboardShortcuts.ts    # 全局快捷键
│   ├── useFileAutocomplete.ts     # 文件路径自动补全
│   ├── useVoiceInput.ts           # 语音输入
│   ├── useMemoryEvents.ts         # 记忆事件
│   ├── useTheme.ts                # 主题
│   ├── useRequireAuth.ts          # 登录拦截
│   └── ...
│
├── stores/                        # Zustand 状态（见上文）
├── contexts/                      # React Context（ConversationTabs）
├── services/                      # IPC 服务
└── utils/                         # 工具函数（platform, logger, resolveFileUrl）
```
