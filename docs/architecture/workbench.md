# Chat-Native Agent Workbench 架构

> 稳定态架构文档。
>
> 产品背景、Phase 级实施顺序、逐文件 slice 拆分请看 `docs/plans/2026-04-16-chat-native-agent-workbench-plan.md` 以及 `docs/plans/2026-04-1{6,7}-*-implementation-spec.md`。
> Accio 对标分析见 `docs/analysis/2026-04-16-accio-vs-code-agent-core-differences.md`。
> 架构决策见 [ADR-011](../decisions/011-chat-native-workbench.md)。
> 2026-04-26 后的实现补充：Workbench B+ 信息架构、Live Preview V2-A/B、Browser/Computer productionization、Activity Providers、Semantic Tool UI、Hook Activity 与 Prompt Rewind 已写入本文。

## 0. 它解决什么

`code-agent` 的能力本身不弱，弱在入口。2026-04-16 以前，用户用到 workspace、skills、MCP、connector、routing、browser 这些能力时，每一类都在不同的侧面板或设置页里。聊天只是一个空白输入框。

Workbench 把这些能力收成聊天主链路的一部分。它不改 orchestration 引擎，只做四件事：

1. 聊天发送是 `ConversationEnvelope`，携带 workspace / routing / capability 选择
2. 输入框上方的 `InlineWorkbenchBar` 把选择点放在离文本最近的地方
3. 关键审批（swarm launch）用内联卡片拉回聊天流，而不是侧面板
4. 每个 turn 内投影出 `workbench_snapshot / capability_scope / blocked / routing / hook_activity / artifact` 执行解释
5. 用户需要回到某条历史提示词时，用 Prompt Rewind 恢复文件 checkpoint、隐藏旧尝试，把原提示词重新放回输入框

目标是让"选择"、"执行"、"解释"这三步都在聊天主链路里闭环，而不是分散在 sidecar 里。

## 1. 5 条概念流

Workbench 是一个整合功能，不是一条线性 phase。代码层面可以按 5 条并列的概念流来理解，每一条都在 `0a6e215e` 这个整合 commit 里关账了 Phase 1-2 的最小闭环。

| 流 | 做了什么 | 关账边界 | Backlog |
|----|----------|----------|---------|
| **A. 主体** | `ConversationEnvelope` + `InlineWorkbenchBar` + 内联 `LaunchRequestCard` | workspace / routing / skills / connectors / MCP 进入主发送链 | — |
| **B. Execution Clarity** | Turn 级 timeline：`workbench_snapshot` / `blocked` / `routing_evidence` / `artifact_ownership` | Direct routing 持久化后可 replay | — |
| **C. Artifact issue、session 复用与本地 preset/recipe** | `UnifiedTraceIdentity` + `ArtifactIssue` + admin review queue + `session-backed reuse` + 本地命名 preset/recipe store | 质量问题进入复盘链路；历史 session 可回灌当前 workbench；session 可保存成本地命名 preset 并回灌 composer；preset 可组合成本地 recipe | recipe 管理 UI / 执行编排、完整 preset/recipe 管理、issue triage / apply |
| **D. Direct Routing (@agent)** | `@agent` mention → messageMetadata → 主进程持久化 → fanout | renderer optimistic + 主进程持久化再分发；失败回滚；replay fallback 可重建 | — |
| **E. Browser/Desktop 显式入口** | `browserSessionMode / executionIntent` 进入 envelope，workbench badge 区分 `managed / desktop` | in-app managed browser 已有 session/profile/account/artifact/lease/proxy/TargetRef；Computer Surface 有 background AX / CGEvent 受控验证；acceptance suite 覆盖生产化基线 | remote browser pool、external CDP/profile、extension bridge、CAPTCHA/anti-bot 分流 |
| **F. Live Preview / Visual Edit** | dev server 启动、iframe source grounding、selectedElement 进入 envelope、TweakPanel 原子样式修改 | Vite-only V2-A/B 已交付：DevServerLauncher + protocol 0.3.0 + TweakPanel；Next.js V2-C 已按 ADR-012 延期 | partial HMR MutationObserver、V3 批注/多选、Next 支持重新评估 |
| **G. Semantic Tool UI** | `_meta.shortDescription / targetContext / rationale` 从 prompt/schema/parser 进入 ToolCall，再投影到 trace UI | 工具调用可读标题、target icon、memory citation、session diff summary、raw URL chip 已接入；SessionRepository 有 fallback shortDescription | 更高质量 target/rationale 生成、跨 provider 稳定性评估 |
| **H. Hook Activity + Prompt Rewind** | Hook trigger history 汇入 turn timeline；用户可从历史 user prompt 回退并恢复文件 checkpoint | 聊天 TurnCard 展示 hook 执行摘要；`session_rewinds` 保留审计，active transcript 只显示未 rewind 消息；输入框回填原 prompt/attachments | rewind UI 的批量历史管理、跨设备冲突可视化 |
| **I. Session Quality + Strategy** | 模型策略、记忆注入、能力使用、工具调用和交付质量进入 turn quality；Replay Audit 复用同一证据 | `TurnQualityStrip`、模型决策 trace、记忆忽略/归档、session media asset 导航已进入会话页 | 跨 session 聚合趋势、团队级质量面板 |

## 2. 关键数据结构

稳定态的核心契约分布在 `src/shared/contract/` 里。以下是 workbench 真正承载语义的几个文件，不是所有扩展过的契约。

### 2.1 ConversationEnvelope

**文件**：`src/shared/contract/conversationEnvelope.ts`

聊天发送的消息外壳。`agent:send-message` IPC 和 `appService.sendMessage()` 都接这个类型。

```ts
interface ConversationEnvelope {
  content: string;
  sessionId?: string;
  attachments?: MessageAttachment[];
  options?: AppServiceRunOptions;
  context?: {
    workingDirectory?: string | null;
    routing?: { mode: 'auto' | 'direct' | 'parallel'; targetAgentIds?: string[] };
    selectedSkillIds?: string[];
    selectedConnectorIds?: string[];
    selectedMcpServerIds?: string[];
    browserSessionMode?: 'managed' | 'desktop' | null;
    executionIntent?: { preferBrowserSession?: boolean; preferDesktopContext?: boolean };
  };
}
```

规则：

- `ConversationEnvelope.context` 是**消息级上下文**，不是全局设置快照。切 workspace 只影响下一条消息，不改全局。
- 旧 `string` payload 和 `{ content, attachments, sessionId }` object payload 仍由 `agent.ipc.ts` 的 `normalizeEnvelope()` 兼容。
- 发送链向 user message 写入 `metadata.workbench` 作为可持久化投影。

### 2.2 WorkbenchMessageMetadata

**文件**：同上 + `src/shared/contract/message.ts`

只挂在 `user` 消息的 `metadata.workbench` 上，不挂 assistant/tool/system。这样解释层和执行层不会混。

```ts
interface MessageMetadata {
  workbench?: {
    workingDirectory?: string | null;
    routingMode?: 'auto' | 'direct' | 'parallel';
    targetAgentIds?: string[];
    selectedSkillIds?: string[];
    selectedConnectorIds?: string[];
    selectedMcpServerIds?: string[];
    browserSessionMode?: 'managed' | 'desktop' | null;
    directRoutingDelivery?: {
      requestedTargets: string[];
      deliveredTargets: string[];
      missingTargets?: string[];
    };
  };
}
```

`directRoutingDelivery` 是 Direct routing 的 replay 兜底——runtime event 消失后，turn timeline projection 仍能据此重建证据。

### 2.3 TurnTimeline

**文件**：`src/shared/contract/turnTimeline.ts`

Turn 内执行解释节点。消费者是聊天 trace renderer，也允许 `TaskPanel` 等 sidecar 后续复用这层 DTO。

```ts
type TurnTimelineNodeKind =
  | 'workbench_snapshot'
  | 'capability_scope'
  | 'blocked_capabilities'
  | 'routing_evidence'
  | 'hook_activity'
  | 'artifact_ownership';

interface TurnTimelineNode {
  id: string;
  kind: TurnTimelineNodeKind;
  timestamp: number;
  tone: 'neutral' | 'info' | 'warning' | 'success' | 'error';
}
```

Trace 层只新增一种 wrapper 节点 `turn_timeline`，不同种类通过 `kind` 区分。这样 `TraceNodeRenderer` 只有一个新入口，不会被每个 slice 各加一遍分支。

`hook_activity` 来自 HookManager 的 trigger history，按 session 和当前 turn 归并，字段包含 event、action、hookCount、durationMs、modified、errorCount 和 toolName。聊天卡片用它解释"本轮运行前后到底触发了哪些自动化"，不再只让用户去日志里找。

### 2.4 SessionWorkspace 派生

**文件**：`src/shared/contract/sessionWorkspace.ts` + `src/main/app/workbenchTurnContext.ts`

Session 维度的 workbench provenance：哪条消息用了哪些能力、最近一次 direct routing 分发到哪里、历史 session 的 workbench 快照。用于：

- Sidebar 的 `Resume` / `Reopen Workspace` 按钮
- 历史 session 回灌当前 composer（Phase 5 session-backed reuse）
- Replay 在 live event 缺席时做 fallback；产品级质量队列走 ArtifactIssue / Admin Review Queue

### 2.5 Artifact Issue / Admin Review Queue

**文件**：`src/shared/contract/productClosure.ts` + `src/main/services/core/repositories/ArtifactIssueRepository.ts` + `src/web/routes/adminReviewQueue.ts`

把生成物质量和 replay/eval gate 接到主产品。`ArtifactIssue` 带稳定 `UnifiedTraceIdentity`、severity、status、evidence refs 和 admin review 决策；Admin Review Queue 是从 issue 派生的本地控制面。旧 session review queue / failure asset draft 不再是当前产品级数据面。

### 2.6 Prompt Rewind

**文件**：`src/shared/contract/appService.ts` + `src/shared/contract/message.ts`

Prompt Rewind 采用 session 级修正语义，和 fork 分支语义分开。它的目标是把 active transcript 回到某条用户提示词之前，同时把旧尝试保留为可审计数据。

```ts
type MessageVisibility = 'active' | 'rewound';

interface PromptRewindResult {
  success: true;
  sessionId: string;
  rewindId: string;
  draft: { content: string; attachments?: MessageAttachment[] };
  activeMessages: Message[];
  hiddenMessageCount: number;
  filesRestored: number;
  filesDeleted: number;
}
```

规则：

- `rewindToPrompt` 只接受 active user message；session 正在 running 时拒绝执行。
- `SessionRepository.applyPromptRewind()` 把锚点消息及之后的 active 消息标成 `visibility='rewound'`，普通 `getMessages()` 默认过滤它们。
- `session_rewinds` 记录 anchor prompt、hidden ids、checkpoint message、files restored/deleted 和 errors，供审计、同步、replay 查询。
- 文件恢复复用 `FileCheckpointService.getFirstCheckpointAtOrAfter()` + `rewindFiles()`，没有 checkpoint 时只做消息层回退。

### 2.7 Turn Quality and Model Strategy

**文件**：`src/shared/contract/turnQuality.ts` + `src/shared/contract/modelDecision.ts`

Turn Quality 是会话页解释层的最新补充。它把本轮 agent 行为拆成五个维度：strategy、memory、capability、tooling、delivery。Chat live UI 和 replay audit 都读同一份结构，避免 live 看一套、复盘看另一套。

```ts
interface TurnQualitySummary {
  memory: TurnQualityMemorySummary;
  strategy: TurnQualityStrategySummary;
  capabilities?: TurnQualityCapabilitySummary;
  score: TurnQualityScoreSummary;
  agentScorecard?: AgentQualityScorecard;
  warnings?: string[];
}
```

关键规则：

- `TurnQualityStrip` 只展示 summary，不在 renderer 重新计算策略或分数。
- 记忆条目可在当前 session 忽略，也可归档为 memory entry 状态变更；这两个动作都走 IPC / store，不直接改 UI 局部状态冒充持久化。
- 模型策略来自运行时 `ModelDecision`，字段覆盖 task class、cost policy、speed policy、tool policy、provider identity、provider health、fallback trace 和 tool-token diagnostics。
- Settings 的 `TaskStrategySettingsPanel` 负责长期策略；ChatInput 的模型策略推荐只做当前 composer 的建议和反馈。
- Routing 的当前会话入口在 `InlineWorkbenchBar`，Live Preview 的低频入口在 `SessionActionsMenu`，不要把未挂载的 `AbilityMenu` 当作当前产品入口。

## 3. 数据流

### 3.1 发送链（普通 Auto / Parallel）

```
ChatInput.handleSubmit()
  → composerStore.buildContext()
  → ConversationEnvelope {content, context}
  → useAgent.sendMessage(envelope)
    → optimistic user message（已带 metadata.workbench）
    → ipc.invoke('agent:send-message', envelope)
      → agent.ipc.ts normalize
      → agentAppService.sendMessage(envelope)
        → 如有 workingDirectory：orchestrator.setWorkingDirectory()
        → 组装 MessageMetadata.workbench
        → agentOrchestrator.sendMessage(content, attachments, options, messageMetadata)
          → 持久化 user message (含 metadata.workbench)
```

### 3.2 Direct Routing（@agent）

```
@agent mention → resolveDirectRouting()
  → useAgent 先写 optimistic user message（带 directRoutingDelivery）
  → ipc.invoke('swarm:send-user-message', {sessionId, messageId, timestamp, metadata})
    → swarm.ipc.ts
      → buildPersistedUserMessage()
      → sessionManager.addMessageToSession()  // 先持久化
      → 持久化成功 → teammateService.onUserMessage() + swarmEventEmitter.userMessage()
      → 持久化失败 → 返回 {delivered: false, persisted: false}
  ← renderer 回滚 optimistic message，明确提示未写入
```

**要点**：renderer 的 optimistic 只是体验优化，主进程持久化才是真相源。持久化成功是 fanout 的前提。

### 3.3 Turn Timeline 投影

```
messages + metadata.workbench
  + useWorkbenchCapabilities()     ← live capability state
  + useSwarmStore()                ← parallel routing evidence
  + turnExecutionStore             ← auto routing evidence + direct live buffer

  → useTurnProjection()            ← 只切 turn（保持纯净）
  → useTurnExecutionClarity()      ← enrichment: 注入 4 类 timeline node
  → TraceNodeRenderer              ← 渲染 turn_timeline 节点
```

`turnExecutionStore` 是一个很小的 renderer-only ephemeral buffer，不做持久化。它承担 live execution clarity，不是 Direct routing 的唯一事实来源（那个是 `metadata.directRoutingDelivery`）。

### 3.4 Prompt Rewind 流程

```
User message action: 回到这条提示词
  → ChatView 打开确认态
  → domain:session / rewindToPrompt {sessionId, userMessageId}
    → AgentApplicationService 校验 TaskManager 当前状态不是 running
    → Database.getMessageById() 读取 active user anchor
    → FileCheckpointService.getFirstCheckpointAtOrAfter(anchor.timestamp)
    → checkpoint 存在时 rewindFiles(sessionId, checkpoint.messageId)
    → SessionManager.applyPromptRewind()
      → messages.visibility = 'rewound'
      → insert session_rewinds audit row
      → refresh session cache + emit session updated
  ← ChatView setMessages(activeMessages)
  ← ChatInput.setDraft(anchor content + attachments)
```

Web 模式的 `src/web/webServer.ts` 有同名 `rewindToPrompt` action，逻辑与 Tauri IPC 对齐，方便桌面和 Web 预览共用同一产品语义。

## 4. 与 TaskPanel / SwarmMonitor 的分工

| 面板 | 承担什么 | 不承担什么 |
|------|----------|-------------|
| **聊天主链路（workbench）** | 当前 turn 的选择、blocked reason、routing evidence、artifact ownership | 全量 debug console、历史 swarm trace、完整 agent lifecycle 面板 |
| **Run Status Rail** | 后台任务、队列、活跃 session、swarm chip 和进度的轻量全局提示 | 不展示完整任务详情，不替代 TaskPanel |
| **TaskPanel** | task-first 状态工作面：当前动作、检查项、产物、approval、outputs、context、MCP、memory、capability sheet、swarm orchestration | 不重新解释每个底层工具调用，不和聊天 trace 各算一套状态 |
| **Workspace Preview** | artifact preview、design_ppt renderer、Prompt Apps、Gallery、生成物打开和检查入口 | 不充当任意文件浏览器，也不绕过 artifact issue / admin review queue，不复活旧 Delivery Review / Preview Feedback |
| **SwarmMonitor** | agent run 详情、run aggregation、SwarmTraceHistory | 不反向作为 turn-level 解释源 |
| **Eval Center** | Replay、failure attribution、跨 session 复盘 | 不独立维护 trace identity，和主产品共享同一 `session:<sessionId>` |

**禁止事项**：

1. 聊天主链路和 TaskPanel 不能各算一套 `blocked reason` 或 `artifact owner`；必须复用 `workbenchBlockedReasons.ts` / `artifactOwnership.ts`。
2. TaskPanel 复用聊天 turn timeline 时，只复用 DTO 和纯 builder，不复用聊天 React 组件。
3. 任何 `auto routing` 证据必须经 main process 的结构化 `routing_resolved` 事件，不允许 renderer 解析 notification 文案。

### 4.0.1 Run Status Rail + task-first TaskPanel（2026-05-09~10）

`ChatView` 顶部挂 `TaskStatusBar`，只在后台任务、队列或 Agent Team 活跃时出现。它从 `taskStore / sessionStore / appStore / swarmStore` 聚合 running/queued、活跃 session、swarm chip 和进度，用户点击后跳 session 或打开 TaskPanel / Agent Team。

TaskPanel 当前以 `TaskMonitor` 为主体，通过 `useRunWorkbenchModel` 和 `taskRailPresentation` 把当前 turn、task、swarm、approval、outputs、context 等来源合成一个 task-first rail。它的职责是把“系统正在做什么、卡在哪里、产物在哪里、需要我审什么”讲清楚，不暴露每个工具调用的内部噪音。

### 4.0.2 Workspace Preview Review（2026-05-07~10，2026-06-01 更新）

Workspace Preview 从 design brief 预览扩展成 artifact review workbench：

| 区域 | 说明 |
|------|------|
| preview item list | 文档、表格、消息草稿、日程、网页截图、diff、文件产物和 design_ppt artifact |
| Design PPT preview | 展示 slides、theme、iterations、截图网格、prompt/code path，并提供 Open PPTX / Edit code |
| Artifact verification | 由具体 game/deck/dashboard verifier 采集真实证据；旧 `delivery_review` queue 已下线 |
| Artifact quality evidence | 由具体 game/deck/dashboard verifier 采集真实证据；质量问题通过 `ArtifactIssue` / `EvalReplayQualityReport` 进入 admin review queue；旧 `delivery_review` queue / Preview Feedback 已下线 |

game/deck/dashboard checker 可以继续作为证据来源，但产品级状态以 artifact issue / admin review queue 为准，不再额外开一套 Delivery Review 页面。

### 4.1 右侧 sidecar 物理整合（v0.16.60-65）

**职责分工不变，物理宿主统一**：TaskPanel / SkillsPanel / FileExplorerPanel / PreviewPanel 共享同一右侧面板宿主，由 `WorkbenchTabs` 顶栏切换，不再各自独立抢宽度。

| 层 | 位置 | 说明 |
|----|------|------|
| Store | `src/renderer/stores/appStore.ts` | `activeWorkbenchTab: 'task' \| 'skills' \| 'files' \| null` + `previewTabs: PreviewTab[]`（独立 LRU 注册表，`MAX_PREVIEW_TABS = 8`） |
| Action | `appStore.openWorkbenchTab(id)` / `closeWorkbenchTab(id)` | 单一入口；legacy `show*Panel` 已迁移完成并移除 |
| 顶栏 | `src/renderer/components/WorkbenchTabs.tsx` | tab bar，X 关闭后切到幸存 tab |
| 宿主 | `src/renderer/App.tsx` | 按 `activeWorkbenchTab` 条件渲染 Task/Skills/Files，`isPreviewActive` 并行渲染 Preview |

**解读**：这一轮不改 ADR-011 定义的主链路语义，只解决 sidecar 的信息架构问题——此前 Task/Skills/Preview/Files 各有独立 toggle（CloudTaskToggle / TaskListToggle / DAGToggle / ObservabilityToggle），多开时互相挤压、心智成本高。整合后右侧只有一个面板位，用户选哪个 tab 它就渲染哪个。

**死代码清理**：与此同步移除 `CloudTaskToggle` / `TaskListToggle` / `DAGToggle` / `ObservabilityToggle` 及 orphan state；TitleBar 只保留 File / Skills / Task 三个 toggle 入口。

### 4.2 Workbench B+ 信息架构收拢（2026-04-26）

B+ 的目标是把“每条消息都可能改”的动作留在 ChatInput，把“配一次跑一阵”的动作移到 Settings / 会话动作 / User Menu。它不改 `ConversationEnvelope` 的执行语义，只改前台入口密度。

| 改动 | 当前口径 | 关键文件 |
|----|----|----|
| ChatInput `+` 菜单 | `/` 命令、附件、Code/Plan/Ask 收进 `InputAddMenu`，输入区只保留发送相关高频控制 | `src/renderer/components/features/chat/ChatInput/InputAddMenu.tsx` |
| 模型 + effort 胶囊 | `ModelSwitcher` 同时显示模型和 reasoning effort，effort 不再单独占一个 toolbar item | `src/renderer/components/StatusBar/ModelSwitcher.tsx` |
| Routing / Browser 设置归位 | `SettingsModal` 新增 “对话”tab，承载 Routing 与 Browser 默认偏好 | `src/renderer/components/features/settings/tabs/ConversationSettings.tsx` |
| Live Preview 入口迁出输入框 | Live Preview 作为 session/workspace 级工具，从 ChatInput 迁到会话动作和 DevServerLauncher | `src/renderer/components/SessionActionsMenu.tsx` |
| TitleBar 瘦身 | Eval / Lab / Cron / Agent Flow / Desktop 等全局工具进入 Sidebar User Menu，TitleBar 不再堆 12 个入口 | `src/renderer/components/Sidebar.tsx`、`src/renderer/components/TitleBar.tsx` |
| WorkbenchTabs `+` | 右侧 Task/Skills/Files 关闭后可在 tab bar 原地重开 | `src/renderer/components/WorkbenchTabs.tsx` |

判断边界：这轮把能力放回对应心智层。ChatInput 负责本轮发送，Settings 负责默认偏好，SessionActions 负责当前会话工具，Sidebar User Menu 负责全局中心页面。

### 4.3 Live Preview V2-A/B 与 V2-C 延期

Live Preview 已从 “手填 URL 打 iframe”推进到 Vite-only MVP：

| 块 | 状态 | 说明 |
|----|----|----|
| V2-A DevServerManager | 已交付 | 探测本地项目、启动 dev server、等待 ready、读取 logs、关闭 tab 自动 stop；webServer dispose 做兜底 |
| V2-B TweakPanel | 已交付 | bridge protocol 0.3.0 回传 `className / computedStyle`；TweakPanel 支持 spacing/color/fontSize/radius/align 5 类 Tailwind 原子修改；`applyTweak` IPC 到 `tweakWriter` |
| V2-C Next.js App Router | 已延期 | React 19 移除 `_debugSource`，Next 15+ 默认 React 19；按 ADR-012，V2 不再承诺 Next click-to-source |

关键数据流：

```
DevServerLauncher
  -> devServerManager.start()
  -> LivePreviewFrame(liveDev tab)
  -> bridge vg:select / vg:restore-selection / vg:selection-stale
  -> appStore.selectedElement
  -> composerStore.buildContext().livePreviewSelection
  -> visual_edit 或 TweakPanel applyTweak
```

V2 当前完成定义：自动起 Vite/CRA dev server、点击源码定位、选中态进 envelope、HMR restore、TweakPanel 原子样式改写。Next、非 Vite 框架、partial HMR MutationObserver 不写成已完成。

### 4.4 Browser / Computer Workbench 生产化基线

Browser/Computer 当前已经超过“工具存在”层，进入 workbench productionization 基线。验收文档是 `docs/acceptance/browser-computer-workbench-smoke.md`。

| 对象 | 已落能力 | 边界 |
|----|----|----|
| Managed BrowserSession | `sessionId / profileId / profileMode / workspaceScope / artifactDir / lease / proxy / accountState / externalBridge` 进入 `ManagedBrowserSessionState` | 仍是 in-app managed browser 优先，不做 remote pool / external profile / extension bridge |
| Profile / AccountState | persistent 兼容旧 profile，isolated 可清理；支持 storageState import/export 与 cookie/localStorage/sessionStorage summary | 不展示 cookie value / storage raw value |
| Snapshot / TargetRef | DOM/a11y snapshot 带 `snapshotId`，interactive element 带 `targetRef`；stale ref 返回 recoverable metadata | TargetRef 只保证当前 snapshot/短 TTL，不承诺跨页面长期稳定 |
| Artifact | download/upload 进入 managed browser artifact 区，暴露 name/hash/mime/size/session 摘要 | 不把本地真实路径或文件内容写进 trace/export |
| Computer Surface | `foreground_fallback`、`background_ax`、`background_cgevent` 三类面向不同风险级别；AX/CGEvent 都有临时 native target smoke | 前台 fallback 是当前前台 app/window 动作，必须保持人工确认语义 |
| Proof timeline | Browser/Computer/Screenshot 结果写入 `EvidenceRef` proof timeline，并通过 replay、trajectory、markdown export 和 sidebar evidence summary 复用 | Proof 只证明已观察/已执行/需接管的事实，不给登录、MFA、CAPTCHA 或支付路径自动授权 |
| Agent Pointer | `AgentPointerEvent` 从 Browser/Computer tool call、workbench trace 和 CUA bridge 派生，renderer 通过 `AgentPointerOverlay` 展示 Neo 的虚拟鼠标位置和阶段 | Pointer 是 app 内可视反馈，不声明系统光标所有权，不保留拖尾式动效 |
| Recovery summary | background task、PTY、subagent restart 后进入 recovery plan，session review 可区分 live、recovered、dead-log-only 和 interrupted | Recovery plan 给 review/retry 建议，不自动重启旧进程 |
| Acceptance | `acceptance:browser-computer-all` 串起 system Chrome/CDP、workflow、benchmark、UI、app-host、background AX/CGEvent | 外部网站、真实账号、反 bot/CAPTCHA 不纳入自动 smoke |

### 4.5 Activity Providers 与 prompt 注入边界

`screen-memory` 不再只等于 OpenChronicle。当前统一成三层：

| 层 | 职责 | 文件 |
|----|----|----|
| ActivityProvider | 描述来源、生命周期、capture source、privacy boundary。OpenChronicle 是 daemon provider；Tauri Native Desktop 是 bundled provider | `src/shared/contract/activityProvider.ts`、`src/main/services/activity/activityProviderRegistry.ts` |
| ActivityContextProvider | 把 OpenChronicle、Tauri native desktop、audio、screenshot-analysis 归一成 `ActivityContext`，保留 sources、evidenceRefs、token budget hint | `src/shared/contract/activityContext.ts`、`src/main/services/activity/activityContextProvider.ts` |
| ActivityPromptFormatter | 控制注入形态：legacy separate blocks 或 unified block；注入失败不阻塞 agent run | `src/main/services/activity/activityPromptFormatter.ts`、`src/main/agent/runtime/conversationRuntime.ts` |

边界：activity context 只提供理解上下文，不授予桌面动作权限。截图、窗口标题、URL、音频、screenshot analysis 都必须带来源和隐私状态。

### 4.6 Semantic Tool UI

工具调用展示的最新路径是：

```
prompt builder 要求 _meta
  -> provider shared schema 给每个 tool inputSchema 注入 _meta
  -> parser 抽出 _meta 写入 ToolCall 顶层并删除执行参数
  -> SessionRepository 对缺失 shortDescription 的 ToolCall 生成 fallback
  -> useTurnProjection / TraceNodeRenderer / ToolHeader 消费语义字段
```

当前已接入的展示层：

- `ToolHeader` 优先显示 `shortDescription`，MCP 工具可把 server 名作为主标题，`targetContext` 显示 Browser / Computer / MCP / app 图标
- `MemoryCitationGroup` 把 memory 引用折叠成 rationale + source chips
- `SessionDiffSummary` 聚合当前 session 文件变更
- `LinkPreviewCard` 把 raw URL 渲染为 favicon chip
- `enableSemanticToolUI` feature flag 保留一键回退旧 UI 的通道

### 4.7 Workbench 诊断面板群（2026-05-13~14）

聊天主链路工作台新增一批诊断面板，让用户在不离开聊天的前提下看清「上下文 token 从哪来」「记忆里存了什么」「桌面活动采到什么」「Computer 工具为什么失败」。

| 面板 | 职责 | 关键文件 |
|------|------|---------|
| Context Health | workbench 新增 `context` tab，`ContextPanel` 挂载 `ContextHealthPanel`：一级展开按消息结构、二级展开按产品来源（rules/skills/mcp/subagents/fileReads/conversation），Skills/MCP/Subagents 可嵌套折叠；每项提供跳转（联动 SkillsPanel highlight）和 ✕ 卸载（MCP 走 `setServerEnabled` IPC，skill 走 unmount）。数据模型见 [agent-core.md](./agent-core.md) | `src/renderer/components/ContextPanel.tsx`、`ContextHealthPanel.tsx` |
| Knowledge Memory Audit | 展示数据库 memory + 轻记忆文件 + 种子候选；`memory.ipc.ts` 的 `MemoryAuditRequest` / `serializedAuditMemory` 负责序列化，`formatValueForDisplay` 把工具偏好、编码风格等 metadata 格式化供 UI 展示 | `src/renderer/components/features/knowledge/KnowledgeMemoryPanel.tsx`、`src/main/ipc/memory.ipc.ts` |
| Activity Entry | 从 OpenChronicle / Tauri native desktop / audio / screenshot-analysis 多源采集活动快照，`ActivityNativeSnapshot` / `ActivityPanelModel` 描述展示模型，受 char limit 隔离和敏感数据守护约束 | `src/renderer/components/features/activity/ActivityPanel.tsx`、`src/main/services/activity/activityContextProvider.ts` |
| Computer-use Diagnostics | `ComputerUseTarget` / `ComputerUseActionTraceSummary` / `ComputerUseFailureExplanation` 追踪渲染状态、权限、失败原因；main 侧 `computerSurface.ts` 提供权限上下文和操作追踪 | `src/renderer/utils/computerUseWorkbench.ts`、`src/main/services/desktop/computerSurface.ts` |
| Time Capability | 把 MCP / DAG scheduler / service / interaction 等超时策略集中到 `timeouts.ts`，workbench 可查询当前 timeout 配置，避免魔法数字散布 | `src/shared/constants/timeouts.ts` |
| Workspace Assets | `WorkspacePreviewPanel` 露出 Document / Spreadsheet / PPT / HTML 等工作区产物，`memoryActivityNavigation.ts` 的 `MemoryActivityFocus` 支持快速导航活动中提及的文件 | `src/renderer/components/WorkspacePreviewPanel.tsx`、`src/renderer/utils/memoryActivityNavigation.ts` |

边界：诊断面板是观测与控制面，不改变 agent 运行语义；卸载类操作（MCP server / skill）才会真正影响下一轮上下文构建。

### 4.8 Agent Neo 右侧验证与接力面（2026-05-15~17）

这轮新增的右侧面板围绕"看得见当前执行、看得见验证、看得见接力"展开。

| 面板 / 卡片 | 职责 | 关键文件 |
|------|------|---------|
| Browser Surface | 托管浏览器/relay 状态从工具输出上移到右侧工作面，展示 readiness、session 状态和浏览器连接面 | `src/renderer/components/features/browser/BrowserSurfacePanel.tsx`、`src/main/services/infra/browserRelayService.ts` |
| Agent Pointer Overlay | Browser/Computer surface 的虚拟鼠标反馈层，展示当前动作位置、阶段和最近轨迹记录 | `src/renderer/components/workbench/AgentPointerOverlay.tsx`、`src/renderer/stores/agentPointerStore.ts`、`src/shared/utils/agentPointer.ts` |
| In-App Validation | HTML artifact 验证面板，iframe 中执行 interaction steps 并显示 pass/fail，配合 `validate_html_in_app` 工具形成可见验收轨迹 | `src/renderer/components/features/inAppValidation/InAppValidationPanel.tsx`、`src/renderer/hooks/useInAppValidationBridge.ts` |
| HandoffCard | 长任务或外部 engine 接力时，把 handoff proposal 呈现在 TaskPanel 里，用户可判断是否继续、复盘或换 engine | `src/renderer/components/TaskPanel/HandoffCard.tsx`、`src/main/handoff/*` |
| Agent Engine 状态卡 | TaskPanel 投影外部 engine 的 ledger status、输出引用和权限 profile，避免把 Codex/Claude 执行伪装成普通 Native turn | `src/renderer/hooks/useRunWorkbenchModel.ts`、`src/renderer/types/runWorkbench.ts` |

边界：这些面板改变的是可见性和可操作性；外部 engine 的权限仍由 main guard 控制，In-App Validation 只验证本地/生成 HTML。

## 5. 落点地图（看 workbench 从哪里入）

### 5.1 Contract 层

- `src/shared/contract/conversationEnvelope.ts` — 发送外壳 + user message metadata 投影
- `src/shared/contract/message.ts` — `MessageMetadata.workbench`
- `src/shared/contract/turnTimeline.ts` — turn 内解释节点 DTO
- `src/shared/contract/sessionWorkspace.ts` — session 维度 workbench provenance
- `src/shared/contract/reviewQueue.ts` — review/replay 回流契约
- `src/shared/contract/appService.ts` — `PromptRewindResult` 和 `rewindToPrompt` facade 契约
- `src/shared/contract/message.ts` — `MessageVisibility` / `hiddenByRewindId` / `hiddenAt`
- `src/shared/contract/trace.ts` — 扩展 `swarm_launch_request` / `turn_timeline` 节点类型
- `src/shared/contract/desktop.ts` — managed browser session、Computer Surface、Workbench action trace
- `src/shared/contract/activityContext.ts` / `activityProvider.ts` — activity context 和 provider 归一契约
- `src/shared/livePreview/protocol.ts` / `tweak.ts` — Live Preview bridge 与 TweakPanel 共享协议
- `src/shared/contract/browserInteraction.ts` — In-App Validation 与 visualSmoke 共用的交互步骤 DSL
- `src/shared/contract/agentEngine.ts` — session engine metadata 与外部 engine 运行状态
- `src/shared/contract/backgroundTask.ts` — Task ledger / notification / output ref 合同

### 5.2 Main Process

- `src/main/app/agentAppService.ts` — envelope → orchestrator 接入点
- `src/main/ipc/session.ipc.ts` — `rewindToPrompt` domain action
- `src/main/app/workbenchTurnContext.ts` — turn 维度 workbench context 组装
- `src/main/agent/agentOrchestrator.ts` — `sendMessage / interruptAndContinue` 接 `messageMetadata`；发出结构化 `routing_resolved` 事件
- `src/main/ipc/agent.ipc.ts` — `normalizeEnvelope()` 兼容 legacy payload
- `src/main/ipc/swarm.ipc.ts` — `swarm:send-user-message` 持久化先于 fanout
- `src/main/tools/workbenchToolScope.ts` — 当前 turn capability 硬作用域
- `src/main/tools/vision/browserWorkbenchIntent.ts` — browser/desktop workbench intent
- `src/main/services/core/repositories/ArtifactIssueRepository.ts` — artifact issue / quality report / admin review 持久化
- `src/web/routes/adminReviewQueue.ts` — app-host admin review queue API
- `src/main/services/core/repositories/SessionRepository.ts` — message visibility filter + `session_rewinds`
- `src/main/services/checkpoint/fileCheckpointService.ts` — rewind anchor checkpoint lookup
- `src/main/evaluation/telemetryQueryService.ts` — trace identity + replay fallback
- `src/main/services/infra/devServerManager.ts` — Live Preview V2-A dev server lifecycle
- `src/main/tools/livePreview/tweakWriter.ts` / `tailwindCategories.ts` — V2-B Tailwind 原子改写
- `src/main/services/infra/browserService.ts` / `browserProvider.ts` — managed browser provider/session/profile/artifact
- `src/main/services/infra/browserRelayService.ts` — Browser Surface relay readiness
- `src/main/services/inAppValidationService.ts` — main → renderer 的 HTML 验证请求桥
- `src/main/services/agentEngine/*` — Codex / Claude / Native engine 检测、guard、adapter、history import
- `src/main/tasks/backgroundTaskLedger.ts` — shell/PTy/external engine 统一 task ledger
- `src/main/services/activity/activityContextProvider.ts` / `activityPromptFormatter.ts` — activity context 构造与 prompt 注入

### 5.3 Renderer

- `src/renderer/stores/composerStore.ts` — 发送前临时上下文选择
- `src/shared/contract/workbenchPreset.ts` / `src/renderer/stores/workbenchPresetStore.ts` — 命名 preset/recipe 契约 + 本地 preset 资产库
- `src/renderer/stores/turnExecutionStore.ts` — turn 维度 ephemeral routing evidence buffer
- `src/renderer/hooks/useAgent.ts` — envelope 发送链 + direct routing 解析
- `src/renderer/hooks/useTurnProjection.ts` — turn 基础切分
- `src/renderer/hooks/useTurnExecutionClarity.ts` — turn timeline enrichment
- `src/renderer/hooks/useWorkbenchCapabilities.ts` / `useWorkbenchInsights.ts` — 共享 capability 模型
- `src/renderer/utils/turnTimelineProjection.ts` — 4 类 timeline node 的构造规则
- `src/renderer/utils/workbenchCapabilityRegistry.ts` / `workbenchQuickActions.ts` — capability registry + 最短路径动作
- `src/renderer/utils/workbenchBlockedReasons.ts` / `artifactOwnership.ts` — 共享 builder（跨聊天/TaskPanel 复用）
- `src/renderer/components/features/chat/InlineWorkbenchBar.tsx` — 输入框上方能力栏
- `src/renderer/components/features/chat/SessionWorkspaceBar.tsx` — 当前 session 的 workspace / provenance 条
- `src/renderer/components/features/swarm/LaunchRequestCard.tsx` — 聊天内联启动卡（TaskPanel 与 trace 共用）
- `src/renderer/components/workbench/WorkbenchCapabilitySheetLite.tsx` — 统一 capability detail sheet
- `src/renderer/components/features/chat/TraceNodeRenderer.tsx` — 新增 `turn_timeline` 节点渲染
- `src/renderer/components/features/chat/ChatInput/InputAddMenu.tsx` — ChatInput B+ 低频动作入口
- `src/renderer/components/features/chat/ChatInput/index.tsx` — `setDraft()` 供 prompt rewind 回填输入框
- `src/renderer/components/features/chat/TurnCard.tsx` — Hook Activity banner
- `src/renderer/components/ChatView.tsx` — prompt rewind 确认、IPC 调用与 active messages 回写
- `src/renderer/components/features/settings/tabs/ConversationSettings.tsx` — Routing / Browser 默认偏好
- `src/renderer/components/LivePreview/DevServerLauncher.tsx` / `TweakPanel.tsx` — Live Preview V2 前台
- `src/renderer/components/citations/MemoryCitationGroup.tsx` — memory citation 折叠展示
- `src/renderer/components/features/chat/SessionDiffSummary.tsx` — session 级文件变更摘要

### 5.4 测试锚点

- `tests/renderer/stores/composerStore.test.ts`
- `tests/renderer/stores/turnExecutionStore.test.ts`
- `tests/renderer/hooks/useTurnExecutionClarity.test.ts`
- `tests/renderer/utils/turnTimelineProjection.test.ts`
- `tests/unit/tools/livePreview/tweakWriter.test.ts`
- `tests/unit/tools/livePreview/tailwindCategories.test.ts`
- `tests/unit/services/infra/browserServiceProfileResolver.test.ts`
- `tests/renderer/utils/browserComputerActionPreview.test.ts`
- `tests/unit/services/activityContextProvider.test.ts`
- `tests/unit/services/activityPromptFormatter.test.ts`
- `scripts/devServerManager-smoke.mts`
- `scripts/devServerManagerIpc-smoke.mts`
- `scripts/tweakWriter-smoke.mts`
- `scripts/acceptance/browser-computer-suite.ts`
- `tests/renderer/utils/workbenchCapabilityRegistry.test.ts`
- `tests/renderer/utils/workbenchQuickActions.test.ts`
- `tests/renderer/components/traceNodeRenderer.launchRequest.test.ts`
- `tests/renderer/components/turnCard.hookActivity.test.ts`
- `tests/unit/ipc/swarm.ipc.test.ts`
- `tests/unit/evaluation/telemetryQueryService.test.ts`
- `tests/unit/services/ArtifactIssueRepository.test.ts`
- `tests/unit/contract/productClosure.test.ts`
- `tests/unit/app/agentAppService.lifecycle.test.ts`
- `tests/unit/services/SessionRepository.runtimeState.test.ts`
- `tests/unit/repositories/sessionRepositoryFts.test.ts`
- `tests/e2e/review-queue.e2e.spec.ts`

## 6. Backlog（不在当前产品口径内）

下列项目**明确还没产品化**。要在 PRD 里提 workbench 能力时，不要把它们写成"已完成"。

1. **Connector lifecycle 管理面**：native connector 已有 `enable / retry / explicit probe / repair permissions / disconnect / remove` 最小闭环、设置页 lifecycle 按钮和 toolScope gate。还没做非 native connector 路径、完整权限修复向导和跨 connector 的统一管理面。skill 挂载 / MCP 重连的最短路径动作已落，但不等于所有 capability 生命周期完成。
2. **Artifact issue 资产沉淀**：当前质量问题能写成 `ArtifactIssue` 并进入 admin review queue，但还没做 richer triage、批量处理、asset apply/export 和归因后的真实资产流转。
3. **命名 preset / recipe 资产库**：已有 `historical session → current session` 的 workbench reuse，也已有本地命名 preset 的保存和应用；recipe contract/store 已支持从 presets 生成、hydrate、upsert、delete、list。还没做 recipe 管理 UI / 多步执行编排、搜索/分享/版本化管理，preset UI 也仍停在 Sidebar 右键菜单的最小入口。
4. **Browser/Desktop readiness 与 artifact consistency**：browser/desktop 已有显式 mode 区分、基础 readiness 展示和有限 smoke。剩余是权限修复路径、collector 状态一致性、artifact 展示/恢复一致性，以及更完整的验收覆盖。
5. **Long-session robustness**：长会话 trace 渲染、capability registry 派生开销、TaskPanel + 聊天区双渲染的重复成本，未专门优化。

当前优先单独开题的是 1 的非 native/统一管理面、2 的 triage / asset apply，以及 3 的 recipe 管理 UI / 执行编排。browser/desktop 只按 readiness 与 artifact consistency backlog 滚动补，不新开 Browser Use / Computer Use phase。

## 7. 常见误解

- **"workbench 是重写 swarm 引擎"** — 不是。Workbench 不改 `CoworkContract / launch builder / swarm runtime`，只改它们的产品暴露方式。
- **"Direct routing 是 renderer-only 短路"** — 不是。renderer 先写 optimistic，但主进程 `swarm:send-user-message` 会先持久化再 fanout。失败回滚，不假装成功。
- **"Auto routing 靠解析 notification 文案"** — 不是。主进程发出结构化 `routing_resolved` 事件，renderer 写进 `turnExecutionStore`。
- **"Phase 1-6 都还没开始"** — 错。Phase 1-2 已关账，Phase 3 有基础骨架、native connector 最小 lifecycle 和设置页入口；Phase 4/5 已有最小闭环；Phase 6.1/6.2 已落，6.3/6.4 有 failure asset draft、preset 资产化和 recipe store。剩下的是 backlog，不是主实现。

## 8. 外部参考

- 设计稿（保留原始切法）：`docs/plans/2026-04-16-chat-native-agent-workbench-plan.md`
- Phase 1 实施规格：`docs/plans/2026-04-16-phase1-chat-native-workbench-implementation-spec.md`
- Phase 2 实施规格：`docs/plans/2026-04-17-phase2-execution-clarity-implementation-spec.md`
- 下一阶段路线图：`docs/plans/2026-04-17-chat-native-workbench-next-phase-roadmap.md`
- Accio 对标分析：`docs/analysis/2026-04-16-accio-vs-code-agent-core-differences.md`
- 决策记录：[ADR-011](../decisions/011-chat-native-workbench.md)
