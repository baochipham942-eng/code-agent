# 前端架构

> Tauri 2.x + React 18 + Zustand + Tailwind CSS

## 平台

桌面端基于 **Tauri 2.x**（Rust），替代早期的 Electron 方案。Tauri 壳层（`src-tauri/src/host.rs`）负责：

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
| **CapabilitySuggestionStrip** | Skill/能力导购条 — 输入命中关键词时在输入框上方展示芯片：本地已安装走 `mount`（挂载到当前会话），未安装走 `install`（从推荐目录一键下载并挂载），见 (2026-06-03) skill 导购 |
| **ScheduleComposerCard** | `/schedule` 不带参数时出现的定时任务创建卡，提供模板填空和自定义描述，提交后仍走 `cron:generateFromPrompt -> createJob` |
| **GoalComposerCard** | `/goal` 不带参数时出现的目标合同创建卡，生成目标、验证和 todo seed |
| **ModelStrategyRecommendationStrip** | 根据任务、provider health 和可用模型给出模型策略建议，用户可接受或忽略 |
| **RoleDraftNotifications / RoleDraftCard** | 监听 `role_draft_pending` 事件，在输入框上方展示新建/修改角色确认卡；用户确认后调用 `domain:roles/confirmDraft` |
| **VoiceInputButton** | 语音输入按钮 |
| **SendButton** | 发送按钮 |
| **ReportStyleSelector** | 报告样式选择器 |
| **SuggestionBar** | 建议栏 |

当前 ChatInput 常驻项按 B+ 口径收敛为：`+`、权限模式、当前 agent、session memory、上下文用量、模型+effort+engine 胶囊、语音、发送。`InlineWorkbenchBar` 在输入区上方承载 Skills/MCP scope 和 Auto/Manual routing；Live Preview 属于低频 session action，入口在 `SessionActionsMenu`。

Prompt Rewind 需要把历史用户提示词重新放回输入框，所以 `ChatInputHandle` 暴露 `setDraft({ content, attachments })` 和 `focus()`；`ChatView` 在 `rewindToPrompt` 成功后调用它，并用返回的 `activeMessages` 刷新当前会话消息。

### 2026-06-18 输入推荐降噪与非流式工具顺序

| 能力 | 前端入口 | 数据来源 |
|------|----------|----------|
| Skill 推荐降噪 | `useSkillRecommendations` 只保留最相关的 2 个推荐；仍支持已安装挂载和未安装下载后挂载 | `skill:session/recommend`、`skill:catalog`、`skill:repo/download` |
| 能力建议降噪 | `CapabilitySuggestionStrip` 最多展示 3 个 capability chip；已在 Skill 推荐里出现的同名 skill 不再作为能力 chip 重复展示 | `workbenchCapabilityRegistry`、`buildCapabilitySemanticSuggestions()` |
| 搜索任务模型建议 | `modelStrategyRecommendation` 判断联网任务时，带 `tool` capability 的模型视为可通过 `WebSearch` 搜索；只有同时缺 `search` 和 `tool` 才提示换搜索模型 | `ModelDomainCapability`、当前模型 capability |
| 非流式工具顺序 | `AssistantMessage` 继续按 `contentParts` 交错渲染正文和工具；OpenAI-compatible / Claude 非流式 wrapper 现在会补齐同一合同，避免工具块倒挂到答案下方 | `ContentPartsRenderer`、provider wrappers |

边界：

- 推荐条是导购，不是必选任务路由；用户不点推荐，当前输入和发送行为不变。
- `contentParts` 是展示顺序合同；工具执行、审批和重试仍在主进程工具链路里处理。

### Settings 信息架构

2026-04-26 后，Settings 不再是平铺 tab 列表。`settingsTabs.ts` 定义稳定 tab id、默认 tab、分组顺序和 tab -> group 映射；`SettingsModal` 通过 `buildSettingsTabGroups()` 渲染分组导航，并支持从搜索或 store 里的 `settingsInitialTab` 直接跳转。

`SettingsLayout` 提供 `SettingsPage` / `SettingsSection` / `SettingsDetails` 三个轻量页面骨架。MCP 设置页优先展示可操作配置，把 Local Bridge、Native Connectors、运行状态和诊断信息收进结构化 section/details，避免把低频诊断淹没主要设置流。

v0.16.74 新增 `HooksSettings`：位于"能力与连接"分组，调用 `domain:hook/list` 展示已启用 Hook、未启用事件、global/project 配置路径，并提供打开配置文件和 Finder 定位。不存在配置文件时，主进程会创建空的 hooks 模板。

2026-06-13~15 后，Settings 的稳定分组是 `基础偏好 / 能力与连接 / 工作区与自动化 / 用户管理 / 记忆与隐私 / 系统`。`settingsIndex.ts` 和 `canAccessSettingsTab()` 共用同一套 tab registry，所以搜索跳转和侧栏可见性不会各算一套。模型页新增任务策略面板，语音输入、快捷键、隐私防线、插件、MCP、Skills、通道和记忆都在搜索索引里有明确关键词。

| 设置域 | 前端入口 | 关键契约 |
|------|----------|----------|
| 任务模型策略 | `ModelSettings` + `TaskStrategySettingsPanel` | fast/main/deep/vision 四档模型、fallback、规则开关写入 `settings.models.taskStrategy` |
| 语音输入 | `VoiceInputSettings` + `VoiceInputButton` | 只在启用且环境支持时展示；麦克风权限由用户点击后触发 |
| 快捷键 | `KeybindingsSettings` | 平台默认、冲突检测、系统保留组合键警告、全局热键总开关 |
| 隐私防线 | `PrivacySettings` | 权限边界、诊断包、凭证库存、语音转写和 Browser Relay 风险说明 |
| 能力与连接 | `CapabilityCenterSettings`、`PluginsSettings`、`MCPSettings`、`SkillsSettings`、`ChannelsSettings` | capability / plugin / MCP / skill / channel 都从 settings 进入管理和审计 |

### Turn Quality and Replay Audit

2026-06-13~15 后，聊天 turn 可以展示 `TurnQualitySummary`。前端只消费 shared contract，不重新打分。

| 层 | 文件 | 职责 |
|----|------|------|
| Live strip | `features/chat/TurnQualityStrip.tsx` | 在 turn 顶部显示总分、记忆注入、模型策略、agent、工具数量，并可展开明细 |
| Replay audit | `features/audit/ReplayAuditPanel.tsx` | 从 structured replay 读取同一套 memory/model/tool/score 证据，支持复盘而不是只看 live UI |
| Store actions | `sessionStore.ts` + `memory.ipc.ts` | 支持本会话忽略某条记忆、归档记忆，变更会反馈到当前 session |

边界：Turn Quality 是诊断和复盘入口，不是普通对话的阻断条件；真正的 release / CI 阻断仍由显式 gate 或测试脚本决定。

### 2026-06-17 预算、工具结果恢复和设计系统前端增量

| 能力 | 前端入口 | 数据来源 |
|------|----------|----------|
| 预算告警设置 | `BudgetSettings` 位于 Settings，支持启用、maxBudget、warning/block 阈值和 reset period；保存前做数值 sanitize | `domain:settings/getBudgetStatus`、`setBudgetConfig` |
| 预算状态展示 | `StatusBar` 用 `useBudgetStatus(sessionCost)` 拉预算状态；`CostDisplay` 按 warning/blocked/silent/none 决定颜色，并在 tooltip 展示用量/上限/百分比 | `useBudgetStatus.ts`、`CostDisplay.tsx` |
| 预算 toast | `BudgetAlertNotice` 订阅 `budget:alert`，warning 用 warning toast，blocked 用 error toast；文案强调收窄任务或调高上限 | `BudgetAlertNotice.tsx`、`BudgetService.setAlertListener()` |
| 工具失败 action | 失败工具结果统一展示复制错误和“从此重试”；从此重试复用消息级 fork path，拿不到 messageId 时只保留复制错误 | `toolExecutionPresentation.ts`、`ToolCallDisplay`、`messageActionStore` |
| 工具状态去噪 | auto-loaded retry 和同轮已恢复失败不再触发“工具报错”决策，避免内部加载机制把成功 turn 渲成失败 | `isAutoLoadedRetry()`、`summarizeToolLoopDecision()` |
| Bash 输出预览 | 已完成的长输出按头尾展示，中段显示省略行数；流式输出只显示最后几行；`\r` 进度帧和 backspace 在展示前折叠 | `ToolCallDisplay/bashOutputPreview.ts` |
| Bash 退出码提示 | Bash metadata 中 `exitCode !== 0` 时，成功标签会追加退出码和“判定可能不可靠”；非 Bash 工具不受影响 | `ToolCallDisplay/statusLabels.ts` |
| 设计系统 gate | UI 新增代码必须走 token、Button/IconButton 和 Modal primitive；hex、裸 button、手搓 modal 由 ratchet gate 守基线 | `docs/designs/design-system.md`、`scripts/check-design-system.mjs` |
| Modal primitive 迁移 | 真居中弹窗已按小批次迁到 `Modal` primitive，迁移测试以 `role=dialog`、`aria-modal`、标题和 footer 合同为回归点 | `CaptureAddDialog`、`DirectoryPickerModal`、`ExportModal`、`RewindPanel`、`PlanPanel`、`DevServerLauncher`、`UpdateNotification`、`SessionReplaySummaryDialog`、`ChannelModal` |

前端边界：

- 预算显示是运行成本提示，不直接停止用户输入或强制中断正在进行的模型请求。
- 工具“从此重试”是会话 fork，不是原 tool call 的字节级 replay。
- 设计系统 gate 的 baseline debt 仍可见；清理要按文件降棘轮，不做全 repo UI 大迁移。

### 2026-06-05 对话式角色、定时任务和模型设置前端增量

| 能力 | 前端入口 | 数据来源 |
|------|----------|----------|
| `/schedule` 空参模板创建 | 用户输入 `/schedule` 后，`ChatInput` 打开 `ScheduleComposerCard`；模板包含每日简报、缺陷扫描、周回顾、自定义 | `cronClient.generateFromPrompt()` + `cronClient.createJob()` |
| `/loop` 后台状态 | `LoopStatusBar` 显示当前 session 的 loop 状态；`TaskStatusBar` / TaskPanel 从 task ledger 看到后台 loop 任务 | `loopClient`、`taskStore`、`BackgroundTaskLedger` |
| 原生通知投递 | `App.tsx` 启动时主动请求通知权限，收到 `notification:show` 后调用 `postOsNotification()`；点击回调 best-effort 跳转 session | `osNotification.ts`、`notificationService`、legacy `notification:clicked` channel |
| 新建角色入口 | Roles 设置页「新建角色」和 slash 命令「新建角色」走 `startCreateRoleChat()`，创建新会话并写入 `/create-role` seed | `appStore.pendingRoleChatSeed`、`sessionStore.createSession()` |
| 修改角色入口 | Roles 详情页「对话式修改」走 `startEditRoleChat(roleId)`，创建新会话并写入 `/edit-role <roleId>` seed | `roles.ipc.ts`、`ChatView` seed 消费 |
| 角色确认卡 | `RoleDraftNotifications` 监听 `agent:event` 的 `role_draft_pending`，展示 roleId、description、category、tools 和完整定义展开 | `domain:roles/listDrafts/confirmDraft/rejectDraft` |
| 模型设置 provider-only 保存 | `ModelSettings` 的「保存」只保存 provider 连接、模型列表、高级配置；每行模型的「设为默认」才更新默认 provider/model | `buildProviderSettingsUpdate()`、`buildDefaultModelSettingsUpdate()` |

前端边界：

- 角色新建/修改的入口只负责起会话和发确定性 slash seed。真正的工具可见性、草稿入队和落盘安全闸在主进程。
- `ScheduleComposerCard` 不保存半成品，也不绕过模型解析；模板只是把用户填空拼回自然语言描述。
- provider 列表文案用「已可用 / 待添加 Key」，避免把"保存 provider"误读成"设为默认模型"。

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

`components/WorkspacePreviewPanel.tsx` 是会话级 artifact workbench，不只是预览列表。它展示 preview item、正文、Design PPT renderer、Prompt Apps 和 Gallery。旧 Delivery Review / Preview Feedback 侧栏已随 evaluation 子系统下线；6/1 后产品级质量状态进入 `ArtifactIssue` / Admin Review Queue。

| Preview kind / 区域 | 职责 |
|------|------|
| `designBrief` / `questionForm` | Design Brief 链路的结构化意图和问卷预览 |
| `design_ppt` | `DesignPptPreview` 展示 slides、theme、iterations、截图网格、prompt/code path，并提供 Open PPTX / Edit code |
| Artifact quality | kind-specific verifier 可作为证据来源，产品级 issue 由 `ArtifactIssueRepository` 和 admin review route 承载 |
| Artifact assets | 展示生成物资产和可打开文件，不再写入旧 review queue |
| Acceptance 状态 | game/deck/dashboard verifier 的用户入口在具体 runtime / TaskPanel task rail；release gate 看 artifact issue / replay quality report |

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
// hooks/agent/effects/* — 监听 IPC 事件: agent:event

useConversationStreamEffects(); // turn / stream / terminal
usePermissionQueueEffects();    // session/global 审批队列
useTaskProgressEffects();       // task progress / complete
useToolExecutionEffects();      // tool start/delta/end/progress
```

2026-07-18 起，permission、task progress、tool execution 三组 effect 把事件判定抽成纯函数核心，React hook 只保留 IPC 订阅和 store 依赖注入。这个边界用于锁住并发 session、晚到 terminal 和同名工具调用等容易被闭包时序掩盖的问题。

| 事件域 | 稳定身份与投影规则 | 失败边界 |
|--------|-------------------|----------|
| Permission | queue key 是 sessionId；无 sessionId/`global` 的请求进入独立 global 队列。当前 session 优先，但不得提前 shift 丢弃 global 项 | terminal 只清该 session；Esc 必须发 `AGENT_PERMISSION_RESPONSE=deny`，发送失败恢复卡片 |
| Task progress | 先按 event session scope 过滤，再更新对应 session 的 progress/complete 投影 | foreign session 的晚到事件不能覆盖当前会话 |
| Tool start/delta/end | `toolCallId` 是结果写回与 progress/timeout 清理的主键；stream placeholder 只有在“唯一、同名、未完成”时允许受限 fallback | 多个同名调用不得按名称或最近卡片猜测；无 id 匹配只记诊断 |
| Terminal | `agent_complete / agent_cancelled / error / stream_end` 按 session 收敛临时状态 | 无 sessionId 的 terminal 不做跨 session 清理 |

`appStore` 只保存待展示审批和队列投影，Host 仍拥有审批事实。renderer 清卡不等于拒绝；任何用户拒绝动作必须回到 Host IPC，避免服务端等待超时。

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

- **协议定义**：`src/host/prompts/identity.ts` 的 `CONCISENESS_RULES > <inline_actions>` 块。核心两类：`[label](neo://thread/{sessionId|new})` 打开/切换/新建会话；`[label](neo://settings/{tab})` 跳设置页（tab 经 `SETTINGS_TAB_IDS` 白名单校验）。另有 `!send / !add / !run / !open / !copy` 等内联动作。
- **渲染**：`MessageBubble/MessageContent.tsx` 的 `IACTNavCard` 解析 `neo://` head/arg，调 `useSessionStore` / `useAppStore` 执行导航，渲染为带图标的内联按钮；未识别链接退化为纯文本，不渲染破卡片。
- **净化白名单**：react-markdown v10 默认 `urlTransform` 会把 `neo://` 剥空，故加 `neoUrlTransform` 显式放行 `neo://`，其余仍走 `defaultUrlTransform`。

### Computer-use PiP 窗口（WS3 — 实时可视化）

agent 跑 computer-use（控屏）时，弹一个画中画窗口实时展示截图帧流，让用户看见 agent 在操作什么。

- **Rust 侧**（`src-tauri/src/pip.rs`）：三命令 `pip_show` / `pip_frame(dataUrl)` / `pip_hide`。窗口 320×220、右上角悬浮、透明无边框、`ignore_cursor_events`（穿透不拦交互）；macOS 设 NSWindow level 1000 + 所有 Space 可见，复用 appshots overlay 窗口范式。
- **Renderer 接线**（`hooks/useComputerUsePip.ts`，在 `App.tsx` 顶层与 `useAppshots` 并列挂载）：监听 `agent:event` 里带 `computerSurfaceSnapshot.screenshotPath` 的 `tool_call_end`（不依赖工具名）→ 首帧 `pip_show`、逐帧 `appshots_read_image_data_url` 转 dataURL 再 `pip_frame`；`agent_complete/cancelled/stream_end/error` 时 `pip_hide`。读图失败/非 Tauri 静默 no-op。

---

## 2026-06-03 增量 — 设置页系列重构 + Onboarding + 路由可视化

这一轮把设置页几大子页从「平铺 section」改造为「双 Tab / Master-Detail」结构，重做 Onboarding 让中转站用户不再卡死，并把模型路由决策在聊天流里可视化。

### 设置页双 Tab / Master-Detail 重构

| 子页 | 落点 | 结构 |
|------|------|------|
| **Skills** | `settings/tabs/SkillsSettings.tsx` → `SkillsInstalledTab.tsx` / `SkillsDiscoverTab.tsx` | 双 Tab：「已安装」按来源（内置/项目/用户/库）分组列表、每行 `primitives/Toggle.tsx` 全局启停；「发现安装」= 推荐仓库 + SkillsMP 搜索 + 自定义仓库平铺（角色场景包 + 按场景浏览）。砍掉 8 张统计卡片与双表格 |
| Skills 全局开关 | 后端 `disabledSkills` 黑名单语义（默认全开），IPC `skill:list` 回传 `enabled` 状态供 Toggle 展示；闸控点在工具调用/ToolSearch/斜杠命令/会话推荐 |
| **模型** | `settings/tabs/ModelSettings.tsx` → `ProviderListPanel.tsx` + `ProviderDetailSections.tsx` | Master-Detail：左 Provider 列表（已配置 ✓ / 未配置折叠 + 搜索 + 新增/中转站 + 诊断），右详情三段（① 连接 → ② 模型发现/启用 → ③ 高级折叠）。渐进披露：未配 Key 只显示连接段，配好后模型/高级段出现 |
| **Agent 引擎** | `settings/tabs/AgentEngineSettings.tsx`（新 tab，basics 分组紧跟模型 tab） | 外部 CLI 引擎（Codex/Claude Code）的模型目录从模型页尾拆为独立 tab，与 API Provider 配置概念分离；`settingsTabs.ts` 注册 `agentEngine` id + `settingsIndex.ts` 补搜索词条 |
| **MCP** | `settings/tabs/MCPSettings.tsx` + `McpDiscoverTab.tsx` | 双 Tab：「已连接」保留管理台原貌；「发现连接」按 6 用途分类展示推荐 server（免配置一键连接 / 需凭证打开预填编辑器 / 内置 server 启用），`McpServerEditor` 支持 `initialConfig` 预填 |
| **插件** | `settings/tabs/PluginsSettings.tsx` | 瘦身：已安装 + 插件市场提到主路径最前，治理信息（管理概览/可见性/完整性评估）降级为默认收起的 `SettingsDetails`，内容不删 |

推荐目录（skill/MCP）改为**云端下发优先**：`CloudConfig.skillCatalog/mcpCatalog` 经 IPC（`skill:catalog` / MCP `getCatalog`）下发，渲染层以内置 `skillCatalog.ts` / `mcpCatalog.ts` 为初始值/降级兜底，云端到达后覆盖；运营更新推荐只改 control-plane 环境变量无需发版。web 模式 IPC 不可用时保持内置不变。

聊天流 skill 导购：`ChatInput/useSkillRecommendations.ts`（输入防抖 500ms）调 `recommendSkills`，命中关键词且本地未安装时返回 `action='install'` 推荐，由 `CapabilitySuggestionStrip` 渲染为「挂载/安装」芯片，安装 = 下载来源仓库 + 自动挂载到当前会话，用户无需进设置页。

### Onboarding 重构

`onboarding/ModelOnboardingModal.tsx` 不再锁死 14 个官方直连 Provider：

- **中转站/自定义 Provider** 卡片：填 Base URL + Key，测试连接 + 在线发现模型后才保存（发现失败拒绝保存，避免落下不存在的 custom-model 占位），显示名自动取域名供 ModelSwitcher 读取。API endpoint 改为可编辑（支持 relay/gateway base URL）
- **跳过出口**：footer「跳过，稍后在设置里配置」+ 关闭按钮 / ESC；跳过直接路由到设置页（`App.tsx`），不置 `completedRef`，冷启动仍提示。修复了 relay 用户「官方端点不可达 + 弹窗关不掉 + 设置页被挡」的 dead-end
- 切换会话清空输入草稿（`ChatInput/useChatInputSessionScope.ts`），避免 `image.png` 等组件态跨会话泄漏；vision「模型不能读图」提示按 engine 感知，会话引擎是 Codex/Claude CLI 时隐藏（该提示只描述 Neo 原生模型行为）

### 模型路由可视化（ADR-019）

模型决策（`modelDecision`）随 stream 事件透传，前端在聊天流原位可视化：

| 组件 | 文件 | 职责 |
|------|------|------|
| **RouteTraceChip** | `features/chat/RouteTraceChip.tsx` | 路由 chip，由 `TraceNodeRenderer` 在节点 `node.modelDecision` 存在时渲染。按 6 类 `reason`（用户选择/角色档位/简单任务/计费跳过/视觉能力/可用性降级）配色与图标，显示 `requested -> resolved` 模型差异；降级类用 AlertTriangle |
| **FallbackBanner** | `features/chat/MessageBubble/FallbackBanner.tsx` | 降级横幅，原位插入聊天流。`useTurnProjection.ts` 把命中 `isModelFallbackNoticeContent` 的内容投影为 `subtype='model_fallback'` 节点，`TraceNodeRenderer` 渲染为「模型已降级 from -> to · reason」横幅，解析逻辑在 `fallbackNotice.ts` |

ModelSwitcher（`StatusBar/ModelSwitcher.tsx` + `modelRuntime.ts`）过滤未配置 API Key 的 provider：`apiKeyConfigured` 由 `configService.getSettings()` 动态注入（SecureStorage/env 任一有 key 即 true），没 key 的 provider 不进面板；local（Ollama）豁免，当前/默认 provider 走 `includeDisabledProviders` 豁免不会消失。并补齐 relay/中转站模型与未配置/混合模型的显示名处理。

---

## 2026-06-03 ~ 06-04 增量 — Swarm 讨论流 + 项目 header + 能力产品化 + 定点反馈

承接[多 Agent 协作批次](../specs/2026-06-04-swarm-project-space-and-capability-batch.md)的前端落点。

### Swarm 协作可见性（讨论流，P1-3）

把多 agent 协作过程做成时间线，让用户看到子代理"发现什么 / 决定什么 / 在干什么"。

| 组件 | 文件 | 职责 |
|------|------|------|
| **DiscussionStream** | `features/swarm/DiscussionStream.tsx` | 时间线讨论流，按 `SwarmContextUpdate.kind`（finding/decision/status/result）给图标，决策高亮，相对时间；收起态显近 3 条、展开全时间线 |
| **SwarmInlineMonitor** | `features/swarm/SwarmInlineMonitor.tsx` | 把 DiscussionStream 嵌入悬浮监控层 |
| **swarmStore** | `stores/swarmStore.ts` | `buildTimelineEntry()` 把 `swarm:context:update` 事件映射进 eventLog |

> ⚠️ `SwarmMonitor`（旧全屏面板）是死代码；可见性走 `SwarmInlineMonitor` 这条线。

### 项目 header（项目空间 P0-2，D5/D6）

`ProjectHeaderBar`（`renderer/.../ProjectHeaderBar.tsx`）在工作区顶部露当前项目：名称/状态、多 goal、入驻角色、跨 session 聚合产物。数据走 `domain:project` 的 `detail` / `artifacts` action；Workspace Preview 升项目维度（`renderer/utils/workspacePreview.ts` 的 `buildProjectArtifacts()` 跨 session 去重排序），不新增整页。

### 能力产品化（P2-1 / P2-2）

| 组件 | 文件 | 职责 |
|------|------|------|
| **RoleIcon** | `features/shared/RoleIcon.tsx` | 内置角色 curated lucide 图标查表（研究员→`Microscope`、数据分析师→`BarChart3`），无元数据回落 `UserCircle` |
| **RolesTab** | `features/settings/tabs/RolesTab.tsx` | 角色按 `SkillCategory` 分组渲染 icon + 名称；并露主动等级开关（role-proactivity 配置入口）|
| **SkillsInstalledTab** | `features/settings/tabs/SkillsInstalledTab.tsx` | 已安装内置技能 `groupBuiltinSkillsByCategory()` 按产物分类二次分组（复用既有七分类，不造 `SkillBundle`）|

### 定点反馈（locality-feedback，Layer B）

每面渲染产物加"点选→局部反馈"入口，反馈经 system prompt 的 `<live_preview_selection>` 块（Layer A 在主进程注入）触发模型自路由 `visual_edit`/`ppt_edit`/`excel_edit`。

- **网页（Phase 1）**：`LivePreview/LivePreviewFrame.tsx` 选中条加内联留言框（占位"这里改成…"，Enter 提交），`sendPrompt` 经 `composerStore.buildContext()` 自动带选区（file/line）。
- **PPT（Phase 2）**：`DesignPptPreview` 接入定点反馈栏，锚点编码进消息前缀（如 `[针对 deck.pptx 第 3 页]`），零扩 envelope。
- **表格（Phase 3）**：`SpreadsheetBlock` 加 cell 点击 + filePath，单元格定点反馈。

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
│   │   │   ├── RouteTraceChip.tsx        # 模型路由 chip（按 reason 配色）
│   │   │   ├── fallbackNotice.ts         # 降级横幅内容解析
│   │   │   ├── ChatInput/              # 输入系统（见上文）
│   │   │   └── MessageBubble/          # 消息气泡 + Generative UI（含 FallbackBanner）
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
