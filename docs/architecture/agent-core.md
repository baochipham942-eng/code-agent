# Agent 核心架构

> 本文档详细描述 Agent 的核心组件：AgentOrchestrator、AgentLoop、运行时模块、平台抽象层、记忆系统、上下文压缩等

## 数据流概览

```
┌─────────────────┐
│  用户输入需求     │ "帮我写一个贪吃蛇游戏"
└────────┬────────┘
         │
         ▼ [IPC / HTTP / SSE]
┌─────────────────────────────────────────────────────────────────────────────┐
│                 平台抽象层 (src/main/platform/)                              │
│  ipcRegistry → handlers Map → webServer 路由                                │
│  windowBridge → SSE 广播 / BrowserWindow 兼容                               │
└────────┬────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         AgentOrchestrator                                    │
│  1. 创建 User Message { id, role: 'user', content, timestamp }              │
│  2. 获取 ModelConfig (Provider + Model + API Key)                           │
│  3. Combo Recording: 自动记录工具调用序列                                    │
│  4. 路由决策: 意图分类 → 模型路由 → 创建 AgentLoop                          │
│  5. steer() 支持: 实时重定向运行中的 Loop                                   │
└────────┬────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                      AgentLoop (薄包装层, ~332 行)                           │
│  委托给 5 个运行时模块:                                                      │
│  ┌──────────────────┬──────────────────┬──────────────────┐                 │
│  │ ConversationRT   │ ToolExecEngine   │ ContextAssembly  │                 │
│  │ 主循环/计划模式   │ 工具执行/钩子     │ 消息构建/推理     │                 │
│  ├──────────────────┼──────────────────┼──────────────────┤                 │
│  │ StreamHandler    │ RunFinalizer     │ LearningPipeline │                 │
│  │ 流式响应处理      │ 会话结束/遥测     │ 持续学习          │                 │
│  └──────────────────┴──────────────────┴──────────────────┘                 │
│                                                                             │
│   onEvent({ type: 'agent_complete' })                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 平台抽象层

**位置**: `src/main/platform/`

**背景**: 所有 Electron 直接导入已替换为平台抽象层，使 Agent 核心可以在 Electron/Tauri/Web/CLI 四种运行时下工作。

**模块清单**:

| 模块 | 替代的 Electron API | 职责 |
|------|---------------------|------|
| `index.ts` | 统一导出 | `import { app, BrowserWindow, shell } from '../platform'` |
| `appPaths.ts` | `electron.app` | 路径解析（userData/home/temp 等）、版本/locale 查询 |
| `ipcRegistry.ts` | `electron.ipcMain` | Map-based handler 注册表，Web 模式下 webServer 从 handlers Map 路由 HTTP 请求 |
| `ipcTypes.ts` | Electron IPC 类型 | `IpcMain`, `IpcMainInvokeEvent`, `HandlerFn` 等类型定义 |
| `windowBridge.ts` | `electron.BrowserWindow` | `broadcastToRenderer()` 向渲染进程推送事件，Web 模式通过 SSE 广播 |
| `nativeClipboard.ts` | `electron.clipboard` | 剪贴板读写 |
| `nativeShell.ts` | `electron.shell` | `openExternal()`, `openPath()`, `showItemInFolder()` |
| `notifications.ts` | `electron.Notification` | 系统通知 |
| `globalShortcuts.ts` | `electron.globalShortcut` | 全局快捷键 |
| `miscCompat.ts` | 其余 Electron API | `dialog`, `safeStorage`, `screen`, `Menu`, `Tray` 等兼容 shim |

**使用方式**:
```typescript
// 旧: import { app } from 'electron';
// 新:
import { app, BrowserWindow, shell } from '../platform';
import type { IpcMain } from '../platform';
```

---

## AgentOrchestrator

**位置**: `src/main/agent/agentOrchestrator.ts`

**职责**:
- 管理对话消息历史（内存限制 `MAX_MESSAGES_IN_MEMORY`）
- 处理权限请求/响应
- 获取模型配置（支持 session 级别覆盖）
- 创建和启动 AgentLoop
- 处理代际切换
- **Combo 录制**: 每次 `sendMessage` 自动录制工具调用序列
- **实时转向**: `steer()` 支持运行中重定向
- **路由决策**: 两层意图分类 → Deep Research / Semantic Research / Auto Agent / 普通 Loop
  - **L1 正则快速路径**: taskRouter `analyzeTask()` 关键词匹配（深入研究/deep research/实现/重构等）
  - **L2 LLM 分类 fallback**: taskType 为 `'unknown'`（未被正则捕获）时调用 `classifyIntent()` (GLM-4-Flash, 3s 超时)
  - 正则确定性高但覆盖有限，LLM 分类处理模糊表达（"帮我看看这个行业"等）

**关键方法**:
```typescript
sendMessage(content: string, attachments?, options?): Promise<void>
  ├─ 创建 user message（支持 MessageAttachment）
  ├─ Combo recording: startRecording + markTurn
  ├─ 获取 ModelConfig（含 session override）
  ├─ 两层意图分类 → 路由决策（L1 正则 → L2 LLM fallback）
  └─ 创建 AgentLoop → run()

steer(newMessage: string): void
  ├─ 中断当前推理（abort controller）
  ├─ 注入新消息到 AgentLoop
  └─ 排队处理: 多条 steer 消息按序执行（pendingSteerMessages）

requestPermission(request): Promise<boolean>
  ├─ 检查 AUTO_TEST 模式
  ├─ 检查 autoApprove 设置
  └─ 发送权限请求事件，等待用户响应
```

**子模块** (`src/main/agent/orchestrator/`):

| 模块 | 职责 |
|------|------|
| `types.ts` | `AgentOrchestratorConfig` 定义 |
| `dagManager.ts` | DAG 可视化状态映射 |
| `modelConfigResolver.ts` | 模型配置解析、默认模型选择、权限级别 |
| `researchRunner.ts` | Deep Research / Semantic Research 执行 |
| `autoAgentRunner.ts` | Auto Agent 模式执行 |

---

## AgentLoop（运行时拆分架构）

**位置**: `src/main/agent/agentLoop.ts` (薄包装层, ~332 行)

**背景**: 原 4350+ 行的单体 AgentLoop 已拆分为 5 个运行时模块 + 3 个辅助模块。AgentLoop 本身仅负责初始化 `RuntimeContext` 并将所有公共 API 委托给对应模块。

### RuntimeContext

**位置**: `src/main/agent/runtime/runtimeContext.ts` (~151 行)

所有运行时模块共享的可变状态容器，包含：
- 模型配置、消息历史、事件回调
- 服务实例（CircuitBreaker、AntiPatternDetector、GoalTracker、NudgeManager）
- 可变状态（isCancelled、isInterrupted、needsReinference）
- Plan Mode 状态
- 工具执行状态、Token 追踪
- Tracing ID

### 运行时模块

| 模块 | 位置 | 行数 | 职责 |
|------|------|------|------|
| **ConversationRuntime** | `runtime/conversationRuntime.ts` | ~824 | 主循环、迭代控制、Plan Mode、cancel/interrupt/steer |
| **ToolExecutionEngine** | `runtime/toolExecutionEngine.ts` | ~873 | 工具执行（含并行）、权限检查、Circuit Breaker、Hook 集成 |
| **ContextAssembly** | `runtime/contextAssembly.ts` | ~1379 | 系统提示构建、消息组装、推理调用、上下文压缩、Thinking 模式、子代理上下文注入 |
| **StreamHandler** | `runtime/streamHandler.ts` | ~159 | 模型响应处理、Token 累加、事件发射 |
| **RunFinalizer** | `runtime/runFinalizer.ts` | ~480 | 会话结束处理、Trace 持久化、遥测、预算检查、TODO 解析 |
| **LearningPipeline** | `runtime/learningPipeline.ts` | ~337 | 持续学习、经验积累 |
| **MessageProcessor** | `runtime/messageProcessor.ts` | ~652 | 消息格式转换、steer 消息注入、contentParts 处理 |
| **ToolResultNormalization** | `runtime/toolResultNormalization.ts` | ~38 | 工具结果标准化 |

**模块间协作**:
```typescript
// AgentLoop 构造函数中的 wiring
this.conversationRuntime.setModules(toolEngine, contextAssembly, runFinalizer, learningPipeline);
this.runFinalizer.setModules(contextAssembly, learningPipeline);
this.toolEngine.setModules(contextAssembly, runFinalizer, conversationRuntime);
this.contextAssembly.setModules(runFinalizer);
```

**AgentLoop 公共 API**（全部委托）:
```typescript
class AgentLoop {
  run(userMessage: string): Promise<void>          // → ConversationRuntime
  steer(newMessage: string): void                   // → ConversationRuntime
  cancel(): void                                    // → ConversationRuntime
  interrupt(newMessage: string): void               // → ConversationRuntime
  setPlanMode(active: boolean): void                // → ConversationRuntime
  setEffortLevel(level: EffortLevel): void          // → ConversationRuntime
  setStructuredOutput(config): void                 // → ConversationRuntime
}
```

---

## 2026-05-15~17 Agent Engine 与接力运行

Agent Neo 现在把"谁来跑这一轮"拆成 engine 层。Native engine 继续走现有 `ConversationRuntime`；Codex CLI 和 Claude Code 通过受控 adapter 运行，并把输出归一回 session、TaskPanel 和 review 链路。

| 层 | 职责 | 文件 |
|----|------|------|
| Contract | 定义 `AgentEngineKind = native / codex_cli / claude_code`、安装状态、runtime 状态、capabilities、permission profile 和 session metadata | `src/shared/contract/agentEngine.ts` |
| Registry | 探测 `codex --version` / `claude --version`，生成 descriptor；Native engine label 是 Agent Neo | `src/main/services/agentEngine/agentEngineRegistry.ts` |
| Guard | 外部 engine 只允许 manual chat session、read-only profile、cwd 落在 workspace 内；read-only session、import session 和无 workspace 的 session 会被拒绝 | `src/main/services/agentEngine/agentEngineGuards.ts` |
| Adapters | Codex 走 `codex exec --json`，Claude 走 `claude -p --output-format stream-json --permission-mode plan`，事件流归一为文本、tool call、permission、task status、artifact ref、done/error | `codexCliAdapter.ts`、`claudeCodeAdapter.ts` |
| Persistence | `sessions.agent_engine` 记录当前 session 的 engine metadata；外部原始日志走 log path / output ref，不直接写进普通 messages | `SessionRepository`、`schema.ts` |
| Task 回带 | 外部 engine 的 cwd、命令摘要、日志路径、完成/失败状态写入 `BackgroundTaskLedger`，TaskPanel 与 Run Status Rail 展示 | `src/main/tasks/backgroundTaskLedger.ts`、`useRunWorkbenchModel.ts` |
| 历史导入 | Codex / Claude 历史 jsonl 可扫描、预览、标准化，供 review 或接力 | `agentEngineHistoryImport.ts` |

运行边界：
- Native Agent Neo 是唯一拥有完整工具/权限/trace/review 队列的默认 engine。
- 外部 engine 这一版作为受控接力能力，只给 read-only profile；需要写操作时回到 Native engine 或走显式后续设计。
- engine 选择属于 session state，前端通过 ModelSwitcher 操作，主进程通过 `agentEngine.ipc.ts` 校验后写回。

---

## 2026-04-27 运行时加固状态

这轮加固把 agent loop 从“能跑通”推进到“关键终态可解释、可中断、可恢复”。它仍不等于全量真实 app smoke 已覆盖，但 P1/P2 中的 active path blocker 已经有代码和定向测试闭环。

### Run lifecycle

`ConversationRuntime.run()` 现在有统一 terminal path。正常完成、异常失败、cancel、interrupt 都会形成 `RunTerminalInfo`，再交给 `RunFinalizer.finalizeRun()` 统一处理 trace、hooks、TODO、telemetry 和 terminal event。

| 状态 | 行为 |
|------|------|
| `completed` | 走普通 finalizer，发 `agent_complete` |
| `failed` | 带 error 进入 finalizer，保留 failure summary / trace end |
| `cancelled` | 走 cancel terminal，发 `agent_cancelled`，不再假装 complete |
| `interrupted` | 进入 finalizer，但保留 interrupt 语义，避免和自然完成混淆 |

`pause()` / `resume()` 保留在同一个 live loop 的等待与恢复路径里；这部分已有 unit 级约束，真实长 run pause/resume 仍列为 smoke 风险。

### TaskManager-owned chat run

desktop chat 的 `sendMessage` 和 `interruptAndContinue` 优先走 TaskManager-owned run。这样 renderer 看到的 task/session 状态更接近同一个 owner，减少“一边 running、一边 idle”的漂移。

关键文件：

- `src/main/app/agentAppService.ts`
- `src/main/task/TaskManager.ts`
- `tests/unit/app/agentAppService.lifecycle.test.ts`
- `tests/unit/task/TaskManager.persistence.test.ts`

### Run-level abort

cancel 从 inference controller 下沉到了工具层：

```
ConversationRuntime.cancel()
  -> ToolExecutionEngine.executeToolCalls(... abortSignal)
  -> ToolExecutor.execute(... abortSignal)
  -> ToolResolver.execute(... ProtocolToolContext.signal)
  -> Bash / http_request / protocol module
```

这条链路解决的是长工具执行已经开始后仍继续跑的问题。当前 unit/security 测试覆盖 Bash、http_request、ToolExecutor safety 和 protocol approval；真实 UI cancel 长命令还属于手工 smoke 项。

### Runtime state persistence

ContextAssembly 里的 compression state、persistent system context，以及 manual compact 生成的 compacted messages 都有 session-scoped 持久化路径：

- `src/main/agent/runtime/runtimeStatePersistence.ts`
- `src/main/agent/runtime/contextAssembly/compression.ts`
- `src/main/agent/runtime/contextAssembly/systemContextStack.ts`
- `src/main/ipc/contextHealth.ipc.ts`
- `src/main/services/core/repositories/SessionRepository.ts`

这让 reload 后的 context view 不再只依赖 live singleton。持久化对象的具体表结构见 [data-storage.md](./data-storage.md)。

### Replay / eval completeness

Eval 不再只看 final answer。`TelemetryQueryService` 会构建 structured replay，把 session trace identity、model calls、tool calls、events、permission/context evidence 组织成可读对象。`real-agent-run` eval gate 需要 `sessionId + replayKey + telemetryCompleteness`，缺 model decision、tool schema、tool call 或 replay key 会 fail/degraded。

关键文件：

- `src/main/evaluation/telemetryQueryService.ts`
- `src/main/testing/testRunner.ts`
- `packages/eval-harness/src/runner/ExperimentRunner.ts`
- `src/shared/contract/evaluation.ts`

### Artifact verifier + product closure quality runtime

5/19 之后，旧 `AcceptanceRunner` / Delivery Review / Preview Feedback 链路已随 evaluation 子系统清理下线。6/1 之后，agent 交付质量状态进入 `ArtifactIssue`、`EvalReplayQualityReport` 和 Admin Review Queue；game / deck / dashboard 这类 kind-specific verifier 负责采集真实文件、浏览器 smoke 或运行时 contract 证据。

| 模块 | 位置 | 职责 |
|------|------|------|
| Product closure contract | `src/shared/contract/productClosure.ts` | `ArtifactIssue`、`ArtifactEvidenceRef`、`EvalReplayQualityReport`、`AdminReviewQueueItem` |
| ArtifactIssueRepository | `src/main/services/core/repositories/ArtifactIssueRepository.ts` | 持久化 issue/evidence/quality report/admin review 决策 |
| Admin review route | `src/web/routes/adminReviewQueue.ts` | app-host 本地 review queue API |
| Game verifier | `src/main/agent/runtime/game/*` | game subtype checker、runtime evidence 和 repair issue codes |
| DeckVerifier | `src/main/agent/runtime/deck/DeckVerifier.ts` | deck schema / narrative probes |
| DashboardVerifier | `src/main/agent/runtime/dashboard/DashboardVerifier.ts` | HTML probes、browser visual smoke、interaction probes |
| Repair guard | `src/main/agent/runtime/repair/*` | 控制 repair scope、修复轮次和单调性 |

### Artifact verifier family

artifact 验收分成通用 runner 和 kind-specific verifier 两层。当前不提前抽统一 `ArtifactKindVerifier` 接口，原因见 ADR-016：deck 多为 in-memory schema / narrative 检查，dashboard 需要真实浏览器 smoke，game 有运行时行为证据，强行统一会制造假抽象。

| Kind | 运行时 | 说明 |
|------|--------|------|
| Game | `src/main/agent/runtime/gameArtifactValidator.ts` + `runtime/game/*` | subtype registry、Platformer/Runner/Breakout checker、skill loader、verb taxonomy、repair codes |
| Deck | `src/main/agent/runtime/deck/DeckVerifier.ts` | schemaProbe + declarative / imperative narrative probes，替代旧 `validateNarrative` |
| Dashboard / interactive app | `src/main/agent/runtime/dashboard/*` | HTML probes、browser visual smoke、interaction probes、state_change_on_click 反 Potemkin |
| Browser visual smoke | `src/main/agent/runtime/browser/visualSmoke.ts` | desktop/mobile viewport、console/page errors、canvas 非空、overflow 等探针 |
| Repair toolkit | `src/main/agent/runtime/repair/*` | scope guards、monotonicity tracker、repair cap、Best-of-N 支撑 |

---

## 2026-05-13 取消级联 + Runtime Steer + Context Health 溯源

这一轮把「取消怎么往下传」「运行中途怎么插话」「上下文 token 来自哪里」三件事补成可解释的闭环。它复用既有 `subagentExecutor`、`ConversationRuntime` 和 `ContextHealthService`，没有引入新的运行时。

### 取消级联（Cancellation Cascading）

`CancellationReason` 把取消原因分成两类，决定是否向兄弟 / 子 agent 穿透：

| 分类 | reason | 行为 |
|------|--------|------|
| CASCADE | `user-cancel` / `session-switch` / `parent-cancel` | 触发 `spawnGuard.cancelAll()`，父级取消向下穿透到全部子 agent |
| NON_CASCADE | `child-error` / `timeout` / `idle-timeout` / `budget-exceeded` | 只熔断单个 agent，兄弟不受影响 |

`initiateShutdown` 走四阶段优雅退出：

```
Phase 1 Signal   -> abortController.abort(reason)
Phase 2 Grace    -> 等待 5s 让 in-flight 工具收尾，成功则直接返回
Phase 3 Flush    -> 2s 内经 TeamManager 持久化 findings
Phase 4 Force    -> 返回 partial results
```

`subagentExecutor` 里的 idle watchdog 每 `IDLE_CHECK_INTERVAL`（5s）轮询，发现 `IDLE_TIMEOUT`（2 分钟）无 stream/progress 就 `abort('idle-timeout')`。父子信号通过 `createChildAbortController` 单向桥接：parent abortSignal 与内部 timeout 都汇入子控制器，子控制器 abort 不反向传播到 parent/sibling，正好对应 NON_CASCADE 语义。

关键文件：

- `src/shared/contract/cancellation.ts` — `CancellationReason`、`CASCADE_REASONS` / `NON_CASCADE_REASONS`
- `src/main/agent/shutdownProtocol.ts` — `initiateShutdown` 四阶段
- `src/main/agent/subagentExecutor.ts` — idle watchdog、`createChildAbortController` 桥接
- `src/shared/constants/timeouts.ts` — `CANCELLATION_TIMEOUTS`（`IDLE_TIMEOUT` / `IDLE_CHECK_INTERVAL` / `GRACEFUL_SHUTDOWN_GRACE` / `FLUSH_TIMEOUT`）

per-agent Stop UI 见 [multiagent-system.md](./multiagent-system.md) 的取消级联章节。

### Runtime Steer（运行中途转向）

用户在 agent 运行过程中插话不再打断当前轮次。`steer()` 调用 `messageProcessor.injectSteerMessage()`，把用户输入排队进当前轮次的消息历史并同步持久化到 SessionManager，置 `needsReinference=true` 让下一轮推理读取。guided UI 用 `RuntimeInputDelivery` 元数据把消息标记为 `queued_next_turn`，让用户知道输入已收到、会在本轮结束后生效。web host 的 follow-up 在 `/web/routes/agent.ts` 接收 `clientMessageId` 字段，保存时带上该 ID，让 web 端消息拥有稳定标识供 prompt rewind 溯源。

关键文件：`src/main/agent/runtime/conversationRuntime.ts`、`src/main/agent/runtime/messageProcessor.ts`、`src/web/routes/agent.ts`、`src/shared/contract/conversationEnvelope.ts`（`clientMessageId`）。

### Context Health Token 溯源

`TokenBreakdown` 在原有「消息结构维度」（systemPrompt / messages / toolResults / toolDefinitions）之外新增可选的 `bySource`，按产品来源拆分 token 占用：

```ts
interface SourceBreakdown {
  rules: number;
  skills: Record<string, number>;
  mcp: Record<string, number>;
  subagents: Record<string, number>;
  fileReads: number;
  conversation: number;
}
```

`ContextHealthService.recordSourceContribution(sessionId, source, tokens, mode)` 支持 `add`（累加，如每次 fileRead / MCP 结果）和 `set`（替换，如 skill mount）；`clearSourceContribution` / `resetSourceContributions` / `clearMcpServerAcrossSessions` 负责卸载与压缩后清零。更新经 200ms 防抖后通过 `context:health:event` 广播到 renderer。

上报点遍布主链路：skill mount/unmount（`sessionSkillService`）、SessionStart AGENTS.md 注入（`agentsHooks`）、fileRead（`read.ts`）、MCP 工具结果（`mcpInvoke`）、subagent 输出（`task.ts` / `spawnAgent.ts`）。renderer 侧 `ContextPanel` / `ContextHealthPanel` 的二级展开与卸载交互见 [workbench.md](./workbench.md)。

关键文件：`src/main/context/contextHealthService.ts`、`src/shared/contract/contextHealth.ts`、`src/renderer/components/ContextHealthPanel.tsx`。

---

## 子代理上下文注入（v0.16.55+）

**位置**: `src/main/agent/activeAgentContext.ts`

ContextAssembly 每轮推理前注入两类子代理信息：

1. **活跃子代理上下文** (`buildActiveAgentContext()`)：当有运行中子代理时，注入 `<active_subagents>` XML 块，包含每个 agent 的 id、role、status、task、已运行时长
2. **异步完成通知** (`drainCompletionNotifications()`)：子代理完成后，SpawnGuard 自动排队通知，contextAssembly 消费并注入 `<subagent_notification>` XML（含 output 摘要、工具调用数、迭代数、成本、耗时）

**SubagentExecutor 消息队列**：
- `send_input` 工具将消息推入子代理的 `messageQueue`
- SubagentExecutor 每轮迭代开始时 `drainMessages()`，将父 agent 消息注入为 `[Parent agent message]: ...`

---

## CompactionService 上下文压缩

**位置**: `src/main/context/compactionService.ts` + `src/main/context/survivorManifest.ts`

上下文压缩已经从旧 `autoCompressor + tokenOptimizer` 口径升级为服务化流程：先形成 compaction plan，再构建 survivor manifest，经过 hook、summary、audit、validation，最后把 compacted block 和 survivor items 注入后续上下文。

```
上下文使用率监控
      │
      ▼ usageRatio ≥ warningThreshold (60%)
┌─────────────────────────────────────────────────────┐
│ L1: Observation Masking                              │
│   清除旧 tool output，保留 tool call 骨架            │
│   目标: 降到 warningThreshold 以下即停               │
└─────────────────────┬───────────────────────────────┘
                      │ 仍然超标
                      ▼ usageRatio ≥ criticalThreshold (85%)
┌─────────────────────────────────────────────────────┐
│ L2: Truncate / Code Extract                          │
│   截断旧消息，保留最近 6 条完整                       │
│   代码块提取保留关键代码片段                          │
└─────────────────────┬───────────────────────────────┘
                      │ 仍然超标
                      ▼ usageRatio ≥ aiSummaryThreshold (90%)
┌─────────────────────────────────────────────────────┐
│ L3: AI Summary                                       │
│   调用 compact model 生成历史摘要                     │
│   支持 PreCompact Hook 提取关键信息                   │
│   注入数据指纹防止摘要后虚构数据                      │
└─────────────────────────────────────────────────────┘
```

### Survivor manifest

`SurvivorManifest` 保存压缩后仍必须让下一轮模型知道的事实：

| 类型 | 例子 |
|------|------|
| files | 被读/写/修改过的文件、摘要、digest、是否只保留 path |
| commands | 关键命令、退出码、短输出 |
| errors | 失败原因、错误类别、后续修复提示 |
| todos / open work | 未完成事项、待验证点、approval 状态 |
| artifacts | 生成物、preview item、artifact verifier 证据 |
| fingerprint | 防止 summary 后把旧数据当最新事实的校验锚点 |

### Audit / validation / hooks

| 模块 | 职责 |
|------|------|
| `compactionAuditRecorder.ts` | 记录压缩源、preserved/compacted 计数、survivor manifest 覆盖情况 |
| `compactionSummaryValidator.ts` | 检查 summary 是否遗漏 survivor items，必要时生成 repair instruction |
| `PreCompact` / `PostCompact` hooks | 允许用户 hook 在压缩前后提取或观察关键上下文 |
| `compactionSnapshotWriter.ts` | 压缩前后快照落 `compaction_snapshots`，供 debug 命令和设置页回看 |

旧的三层压缩策略仍是触发与降级思路，但当前架构事实源是 `CompactionService`，不是散落在 ContextAssembly 内的单体逻辑。

---

## Light Memory 系统

**位置**: `src/main/lightMemory/`

**设计理念**: File-as-Memory 架构，用 ~700 行代码替代旧的 13K+ 行 vector/embedding 记忆系统。核心洞察——模型本身就是最好的记忆引擎，让模型判断什么值得记、怎么组织、何时调用。

**模块组成**:

| 文件 | 职责 |
|------|------|
| `indexLoader.ts` | 加载 `~/.code-agent/memory/INDEX.md`，截断到 200 行（~500 tokens） |
| `memoryWriteTool.ts` | MemoryWrite 工具 — 模型主动写入记忆文件 |
| `memoryReadTool.ts` | MemoryRead 工具 — 模型按需读取记忆文件 |
| `sessionMetadata.ts` | 会话元数据追踪（借鉴 ChatGPT Session Metadata） |
| `recentConversations.ts` | 最近 15 条对话摘要（借鉴 ChatGPT Recent Conversations） |

**6 层上下文注入**:

```
┌─────────────────────────────────────────┐
│ L1: System Instructions (identity.ts)    │ 身份/规则/工具纪律
├─────────────────────────────────────────┤
│ L2: Session Metadata                     │ 使用频率、模型分布、活跃天数
├─────────────────────────────────────────┤
│ L3: Memory Index (INDEX.md)              │ 持久记忆索引（~500 tokens）
├─────────────────────────────────────────┤
│ L4: Recent Conversations                 │ 最近 ~15 条对话摘要
├─────────────────────────────────────────┤
│ L5: RAG (待废弃)                         │ 旧 vector search（兼容保留）
├─────────────────────────────────────────┤
│ L6: Current Session                      │ 当前对话上下文
└─────────────────────────────────────────┘
```

**记忆类型**:

| 类型 | 何时写入 | 何时读取 |
|------|----------|----------|
| `user` | 学到用户角色/偏好/专长 | 个性化响应时 |
| `feedback` | 用户纠正做法 | 执行相似任务前 |
| `project` | 学到项目上下文（代码/git 无法推导的） | 理解任务背景时 |
| `reference` | 学到外部资源位置 | 查找外部信息时 |

**存储路径**: `~/.code-agent/memory/`（INDEX.md + 类型化 .md 文件 + session-stats.json + recent-conversations.md）

---

## 身份系统 (Identity)

**位置**: `src/main/prompts/identity.ts`

**组成部分**:

| 导出常量 | 内容 | Token 估算 |
|----------|------|------------|
| `IDENTITY` | 核心身份声明 + 安全规则（3 条 IMPORTANT） | ~100 |
| `CONCISENESS_RULES` | 简洁输出要求 + IACT 内联交互语法 | ~200 |
| `TASK_GUIDELINES` | Thinking 引导、任务执行流程、Recon-Before-Action、One-Shot Script | ~200 |
| `TOOL_DISCIPLINE` | 工具参数纪律 + 并行调用指导 | ~100 |
| `MEMORY_SYSTEM` | Light Memory 使用说明（类型/写入门控/读取/维护） | ~150 |

**Generative UI 注入** (`src/main/prompts/generativeUI.ts`):

身份系统现在包含 Generative UI 提示注入，指导模型生成交互式可视化内容：
- `chart` 代码块: bar/line/area/pie/radar/scatter 图表
- `generative_ui` 代码块: 完整 HTML 交互式内容

---

## 统一遥测系统

**位置**: `src/main/telemetry/`

**背景**: 提交 `ca5e2591` 实现了统一 Trace 持久化，覆盖 App/CLI/Web 三种运行模式（不再仅限 App）。

**组件**:

| 组件 | 位置 | 职责 |
|------|------|------|
| `TelemetryCollector` | `telemetryCollector.ts` | 事件采集、缓冲、TelemetryAdapter 工厂 |
| `TelemetryStorage` | `telemetryStorage.ts` | SQLite 持久化（CLI 模式下 DB 不可用时静默跳过） |
| `intentClassifier` | `intentClassifier.ts` | 意图分类（3s 超时）+ 结果评估 |
| `systemPromptCache` | `systemPromptCache.ts` | 系统提示缓存，避免重复构建 |

---

## System Prompt 分层架构（Pi 借鉴 ④，2026-05-28）

借鉴 Pi 的多文件 prompt 分层模型，Agent Neo 支持用户在项目级 / 全局级目录提供三种 system prompt 文件，按语义独立组合。

### 三种文件 + 语义

| 文件名 | 语义 | 注入策略 |
|--------|------|----------|
| `SYSTEM.md` | **custom replace identity** | 只替换默认 identity prompt；后续 workdir / runtime mode / session metadata / memory / repo map / deferred tools / append 仍**照常注入** |
| `APPEND_SYSTEM.md` | **append after defaults** | 在所有默认层之后追加（用于补充规则、加 reminder） |
| `FULL_SYSTEM.md` | **full replace, short-circuit** | 短路 `buildCachedDynamicSystemPrompt` 所有默认层，**直接 return**；用于真接管场景（custom 不能解决全局 memory 渗透问题时） |

**查找顺序**（同名文件项目级覆盖全局级，互相短路不合并）：
1. `<workingDir>/.code-agent/<NAME>.md`
2. `~/.code-agent/<NAME>.md`

**优先级**（三类可同时存在，消费者按下面顺序决策）：
- `fullReplace` 命中 → 完全接管，跳过 custom + append + 所有默认层
- `custom` 命中 → 替换 identity，append 与默认层照常注入
- 都未命中 → 走默认 identity + 默认层

### 关键实现

- `src/main/prompts/projectSystemPrompt.ts`：文件查找 / 读取 / 兜底（不存在返回 null，IO 错误 warn 一行）
- `src/main/agent/runtime/contextAssembly/messageBuild.ts`：
  - `buildCachedDynamicSystemPrompt` 命中 `fullReplace` 时直接 `return`
  - **cache key 加 `fullReplace` 维度**，独立于 `userQuery`（commit `715e20f3` 闭环 E 风险：固定 ctx + userQuery，只改 SYSTEM.md 或 FULL_SYSTEM.md 必须使 cacheKey 变化）

### 为什么有 FULL_SYSTEM.md（D 风险闭环）

`SYSTEM.md` 只替换 identity prompt，**但后续 workdir / runtime mode / session metadata / memory / repo map / deferred tools / append 照常注入** — 全局 memory 仍会渗透到回复。custom 不是真接管。

`FULL_SYSTEM.md` 是 D 风险（Codex audit Round 1 留下）的最终闭环：加载后**短路所有默认层**，给用户提供"完全接管 system prompt"的逃生口。

### 验收

- `projectSystemPrompt.test.ts` +6 cases（命中 / 全局兜底 / 项目覆盖 / 三层独立 / 空文件 / 缺失）
- `messageBuild.cacheKey.test.ts` +6 cases（同时闭环 E 风险）
- 端到端验证记录：[docs/audits/](../audits/)（commit `4c2299af`）

### 相关 Commits

- `5f51b16c` — feat(prompts): project-level SYSTEM.md / APPEND_SYSTEM.md（Pi 借鉴 ④ Phase 1-3）
- `715e20f3` — feat(prompts): FULL_SYSTEM.md 短路所有默认层（Phase 3.5 — D 风险闭环）
- `4c2299af` — docs(audit): system md e2e validation

**TelemetryAdapter**: 由 `TelemetryCollector.createAdapter(sessionId)` 创建，注入到 AgentLoop 的 RuntimeContext 中，通过统一接口收集 Turn/ModelCall/ToolCall/Timeline 事件。

**错误分类** (`classifyError`): 自动归类为 `file_not_found` / `permission_denied` / `timeout` / `syntax_error` / `edit_not_unique` / `rate_limit` / `network_error` / `command_failure` / `context_overflow` / `path_hallucination` / `unknown`。

---

## Combo Skills

**位置**: `src/main/services/skills/comboRecorder.ts`

**设计理念**: 借鉴 FloatBoat 的 Combo Skills 概念，从对话中自动录制工具调用序列，生成可复用的 SKILL.md。

**工作流程**:

```
用户对话开始
      │
      ▼ sendMessage() 触发 startRecording + markTurn
┌─────────────────────────────────────────────┐
│ ComboRecorder 监听工具调用事件               │
│  • 记录每个 ToolCall: name, args, success    │
│  • 按 Turn 分组                             │
│  • 预览输出（截断到 200 字符）               │
└─────────────────────────────────────────────┘
      │
      ▼ turns ≥ 2 && steps ≥ 3
┌─────────────────────────────────────────────┐
│ 生成 ComboSuggestion                        │
│  suggestedName / Description / toolNames    │
└─────────────────────────────────────────────┘
      │
      ▼ 用户确认
┌─────────────────────────────────────────────┐
│ 导出为 SKILL.md (参数化模板)                 │
└─────────────────────────────────────────────┘
```

**核心类型**:
- `ComboStep`: 单个工具调用记录（toolName, args, success, duration）
- `ComboTurn`: 一轮对话（userMessage + steps[]）
- `ComboRecording`: 完整录制（sessionId + turns[]）
- `ComboSuggestion`: 录制完成后的建议（name, description, toolNames）

---

## Turn-Based 消息流架构

> 详见 ADR: [001-turn-based-messaging.md](../decisions/001-turn-based-messaging.md)

**设计来源**: 借鉴 Vercel AI SDK 和 LangGraph 的最佳实践

**核心原则**:
- 每轮 Agent Loop 迭代对应一条前端 assistant 消息
- 后端驱动消息创建（通过 `turn_start` 事件）
- 使用 `turnId` 关联同一轮的所有事件

**事件流程**:

```
turn_start → stream_chunk* → stream_tool_call_start? → tool_call_end → turn_end
    |                                                                       |
    v                                                                       v
创建新 assistant 消息                                                标记本轮完成
```

**事件类型说明**:

| 事件 | 触发时机 | 携带数据 | 前端处理 |
|------|----------|----------|----------|
| `turn_start` | 迭代开始 | `{ turnId, iteration }` | 创建新 assistant 消息 |
| `stream_chunk` | 文本流式输出 | `{ content, turnId }` | 追加到目标消息 |
| `stream_tool_call_start` | 工具调用流式开始 | `{ index, id, name, turnId }` | 添加工具调用卡片 |
| `tool_call_end` | 工具执行完成 | `{ toolCallId, success, output }` | 显示执行结果 |
| `turn_end` | 迭代结束 | `{ turnId }` | 可选的 UI 更新 |

**contentParts 支持**: ModelResponse 现在支持 `contentParts` 数组，精确区分 `text` 部分和 `tool_call` 部分在响应中的位置，由 MessageProcessor 转换为消息格式。

---

## 任务复杂度分析系统

**位置**: `src/main/planning/TaskComplexityAnalyzer.ts`

**功能**: 在 AI 执行前自动检测任务复杂度，注入相应的执行策略提示。

```
用户输入 → 复杂度分析 → 注入提示 → AI 执行
              ↓
      "create snake game"
              ↓
      Detected: SIMPLE (85%)
              ↓
      AI 收到: "Skip planning, use write_file NOW"
```

**复杂度分类**:

| 复杂度 | 检测指标 | 建议行为 | 工具调用次数 |
|--------|----------|----------|--------------|
| **SIMPLE** | "create a"、短消息、单文件任务 | 跳过规划，直接 `write_file` | 1-3 次 |
| **MODERATE** | "add feature"、"fix bug" | 简短规划（3-5 项） | 5-10 次 |
| **COMPLEX** | "refactor"、"migrate"、多步骤 | 完整规划，分阶段执行 | 10-30+ 次 |

---

## 规划系统 (Planning System)

**位置**: `src/main/planning/`

**组件结构**:

```
planning/
├── PlanManager.ts           # 计划持久化管理
├── HooksEngine.ts           # 生命周期钩子引擎
├── ErrorTracker.ts          # 错误追踪 (3-Strike Rule)
├── FindingsManager.ts       # 发现管理
├── TaskComplexityAnalyzer.ts # 任务复杂度分析
├── PlanningService.ts       # 统一服务入口
└── types.ts                 # 类型定义
```

**HooksEngine 钩子**（规划系统内部，v0.16.60 起桥接到用户 HookManager）:

| 钩子 | 触发时机 | 功能 |
|------|----------|------|
| `onSessionStart` | 会话开始 | 检查未完成计划，重置计数器 |
| `preToolUse` | 工具执行前 | 注入错误历史，提醒当前任务 |
| `postToolUse` | 工具执行后 | 2-Action 规则，更新进度提醒 |
| `onStop` | AI 准备停止 | 验证计划完成度，决定是否强制继续 |
| `onError` | 发生错误 | 记录错误，检查 3-Strike 规则 |

**用户 Hook 系统**（`src/main/hooks/hookManager.ts`）:

19 种事件类型，分为 decision（可阻止/修改）和 observer（只读）两种模式：

| 稳定性 | 事件 | 模式 |
|--------|------|------|
| stable | PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, PostExecution, PreCompact, SessionStart, SessionEnd, SubagentStop | mixed |
| experimental | SubagentStart, PermissionRequest, TaskCreated, TaskCompleted, PermissionDenied, PostCompact, StopFailure | mixed |
| internal legacy | Setup, Notification | observer |
| observer-only | PostToolUse, PostToolUseFailure, PostExecution, SessionStart, SessionEnd, SubagentStop, TaskCreated, TaskCompleted, PermissionDenied, PostCompact, StopFailure | observer |

- Observer hook 正常执行但 block/modify 结果被静默忽略
- Observer-only 事件自动将 decision hook 降级为 observer
- Trigger history buffer（最近 50 条）供 Hook Settings 与聊天 `hook_activity` timeline 使用
- CLI 模式 v0.16.74 起默认启用 Hook，不再只由 planning mode 打开
- DecisionHistory 独立记录权限决策（50 条，8 种结果类型）

---

## Anti-pattern Detection

**位置**: `src/main/agent/antiPattern/detector.ts`

**功能**: 检测 AI 陷入无限读取循环的情况。

**检测规则**:

| 阶段 | 阈值 | 触发条件 | 警告内容 |
|------|------|----------|----------|
| **创建前** | 5 次 | 连续 5 次 read 操作 | "停止阅读，立即创建！" |
| **创建后** | 10 次 | 写入后连续 10 次 read | "任务可能已完成，停止过度验证！" |

**解决的问题**:
- AI 创建文件后陷入无限验证循环
- AI 在创建任务中过度研究而不动手
- Stop Hook 过于激进导致的强制继续

---

## Plan Mode (规划模式)

> 借鉴自 Claude Code v2.0

**目的**: 为复杂实现任务提供结构化的规划流程，让 AI 先探索、设计，再由用户审批后执行。

### 工作流程

```
用户请求复杂任务
      │
      ▼
┌─────────────────┐
│ enter_plan_mode │ ← AI 主动调用（Gen3+）
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│          规划阶段                    │
│  • 使用 read_file, glob, grep 探索  │
│  • 理解现有架构和模式               │
│  • 设计实现方案                     │
└────────┬────────────────────────────┘
         │
         ▼
┌─────────────────┐
│ exit_plan_mode  │ ← 提交计划供审批
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────┐
│          用户审批                    │
│  • 确认执行 → 开始实现              │
│  • 修改计划 → 返回规划阶段          │
│  • 取消 → 结束                      │
└─────────────────────────────────────┘
```

### 触发条件

| 条件 | 推荐动作 |
|------|----------|
| 新功能实现 | 进入 Plan Mode |
| 多文件修改 (>3 个) | 进入 Plan Mode |
| 架构决策 | 进入 Plan Mode |
| 需求不明确 | 进入 Plan Mode |
| 单行修复 | 直接执行 |
| 明确具体指令 | 直接执行 |

### 状态管理

**ConversationRuntime** 维护 Plan Mode 状态：

```typescript
// RuntimeContext 中的状态
isPlanModeActive: boolean;
planModeActive: boolean;
autoApprovePlan: boolean;
```

状态通过 `RuntimeContext` 在所有运行时模块间共享。

---

## ModelRouter

**位置**: `src/main/model/ModelRouter.ts`

**支持的模型提供商**:

| Provider | 模型 | 特性 |
|----------|------|------|
| Kimi | kimi-k2.5 | 主力模型 |
| DeepSeek | deepseek-chat, deepseek-reasoner | 成本优先 |
| OpenAI | gpt-4o, gpt-4o-mini | 备选 |
| Claude | claude-sonnet-4, claude-opus-4 | 高级推理 |
| Groq | llama-3.3-70b | 快速推理 |
| 智谱 | glm-4-plus, glm-4v-plus | 中文优化、视觉理解 |
| 通义千问 | qwen-max, qwen-coder-plus | 代码专用 |
| Moonshot | moonshot-v1-128k | 超长上下文 |

---

## DAG 任务调度系统

**位置**: `src/main/scheduler/`

基于有向无环图的并行任务调度系统，用于协调多代理和工作流执行。

### 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                       DAG Scheduler                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     │
│  │ Task A       │────→│ Task B       │────→│ Task D       │     │
│  │ (architect)  │     │ (coder)      │     │ (tester)     │     │
│  └──────────────┘     └──────────────┘     └──────────────┘     │
│         │                                         ↑              │
│         │             ┌──────────────┐            │              │
│         └────────────→│ Task C       │────────────┘              │
│                       │ (reviewer)   │                           │
│                       └──────────────┘                           │
│                                                                  │
│  并行执行: A → (B, C 并行) → D                                   │
└─────────────────────────────────────────────────────────────────┘
```

### 核心组件

| 组件 | 位置 | 职责 |
|------|------|------|
| **DAGScheduler** | `DAGScheduler.ts` | 调度器核心，管理 DAG 执行生命周期 |
| **TaskStateManager** | `TaskStateManager.ts` | 任务状态机，处理状态转换 |
| **DependencyResolver** | `DependencyResolver.ts` | 依赖分析和拓扑排序 |
| **ResourceLimiter** | `ResourceLimiter.ts` | 并发控制和资源限制 |

### 任务状态机

```
┌─────────┐
│ pending │ ← 初始状态
└────┬────┘
     │ 依赖满足
     ▼
┌─────────┐
│  ready  │ ← 可执行
└────┬────┘
     │ 开始执行
     ▼
┌─────────┐     ┌───────────┐
│ running │────→│ completed │ ← 成功
└────┬────┘     └───────────┘
     │
     ├────────→ failed     ← 失败
     ├────────→ cancelled  ← 取消
     └────────→ skipped    ← 跳过（依赖失败）
```

### 失败策略

| 策略 | 行为 | 适用场景 |
|------|------|----------|
| `fail-fast` | 任一失败立即停止 | 关键流程 |
| `continue` | 失败后继续无依赖任务 | 容错流程 |
| `retry-then-continue` | 重试 N 次后继续 | 网络/临时故障 |

### 可视化 (React Flow)

**位置**: `src/renderer/components/features/workflow/`

- **DAGVisualization.tsx**: DAG 图形展示
- **TaskNode.tsx**: 任务节点组件
- **useDAGLayout.ts**: 自动布局 Hook

实时展示任务执行状态，支持节点交互和状态过滤。

---

## Nudge 机制

**位置**: `src/main/agent/nudgeManager.ts`

Nudge 是一种非侵入式的提示机制，用于引导 AI 完成任务而不是过早停止。

### P1 Nudge - 只读停止检测

**触发条件**: AI 在没有执行任何写操作的情况下准备停止

### P2 Checkpoint 验证

**触发条件**: 任务完成时验证文件修改是否与任务目标一致

### P3 文件完成追踪

| 状态 | 含义 |
|------|------|
| `created` | 文件已创建 |
| `modified` | 文件已修改 |
| `verified` | 文件已验证 |
| `completed` | 任务完成 |

---

## Checkpoint 系统

**位置**: `src/main/services/FileCheckpointService.ts`

文件版本快照系统，支持任务级别的回滚。

### 核心功能

| 功能 | 描述 |
|------|------|
| `createCheckpoint()` | 创建当前文件状态快照 |
| `rewindFiles()` | 回滚到指定检查点 |
| `getModifiedFiles()` | 获取检查点后修改的文件列表 |
| `cleanup()` | 清理过期检查点 |

### 使用场景

1. **任务开始前**: 自动创建检查点
2. **任务失败时**: 回滚到检查点
3. **用户请求撤销**: 恢复到指定检查点

---

## Subagent 系统

**位置**: `src/main/agent/subagent/` 相关模块

### 4 层架构

```
┌─────────────────────────────────────────────┐
│ Layer 1: 核心定义 (builtInAgents.ts)        │
│   - 角色名称、描述、能力                    │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│ Layer 2: 上下文注入 (contextInjector.ts)    │
│   - System Prompt 模板                      │
│   - 工具权限配置                           │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│ Layer 3: 生命周期 (subagentPipeline.ts)     │
│   - 创建、执行、销毁                       │
└─────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────┐
│ Layer 4: 消息追踪 (parentToolUseId)         │
│   - 父子关系追踪                           │
│   - 结果聚合                               │
└─────────────────────────────────────────────┘
```

### Cowork 框架

子代理间协作框架，支持：
- **串行协作**: A → B → C
- **并行协作**: A, B, C 同时执行
- **混合协作**: A → (B, C 并行) → D

---

## 循环依赖消除

**工具**: madge（静态分析）
**结果**: 114 → 0 循环依赖

关键手段：
- 平台抽象层替代 Electron 直接导入
- 运行时模块拆分消除 AgentLoop 巨型单体
- 延迟导入（`require()`）打破初始化顺序依赖
- 服务注册表 + getter 模式替代直接 import 单例

---

## 依赖注入容器

**位置**: `src/main/core/container.ts`

轻量级 DI 容器，管理服务生命周期和依赖关系。

### 生命周期

| 类型 | 说明 |
|------|------|
| `Singleton` | 全局单例，首次获取时创建 |
| `Factory` | 每次获取创建新实例 |
| `Transient` | 临时实例，不缓存 |

### 生命周期管理

**位置**: `src/main/core/lifecycle.ts`

统一管理应用启动和关闭时的服务初始化/销毁顺序。

```typescript
// 启动顺序
await lifecycleManager.startup([
  'config',      // 1. 配置
  'database',    // 2. 数据库
  'auth',        // 3. 认证
  'agent'        // 4. Agent
]);

// 关闭顺序（自动反转）
await lifecycleManager.shutdown();
```
