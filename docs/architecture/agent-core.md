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

## 子代理上下文注入（v0.16.55+）

**位置**: `src/main/agent/activeAgentContext.ts`

ContextAssembly 每轮推理前注入两类子代理信息：

1. **活跃子代理上下文** (`buildActiveAgentContext()`)：当有运行中子代理时，注入 `<active_subagents>` XML 块，包含每个 agent 的 id、role、status、task、已运行时长
2. **异步完成通知** (`drainCompletionNotifications()`)：子代理完成后，SpawnGuard 自动排队通知，contextAssembly 消费并注入 `<subagent_notification>` XML（含 output 摘要、工具调用数、迭代数、成本、耗时）

**SubagentExecutor 消息队列**：
- `send_input` 工具将消息推入子代理的 `messageQueue`
- SubagentExecutor 每轮迭代开始时 `drainMessages()`，将父 agent 消息注入为 `[Parent agent message]: ...`

---

## 三层上下文压缩

**位置**: `src/main/context/autoCompressor.ts` + `src/main/context/tokenOptimizer.ts`

当上下文使用率接近模型上限时，自动执行递进式压缩：

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

**配置默认值**:
```typescript
{
  warningThreshold: 0.6,     // L1 触发
  criticalThreshold: 0.85,   // L2 触发
  aiSummaryThreshold: 0.9,   // L3 触发
  targetUsage: 0.5,          // 压缩目标
  preserveRecentCount: 6,    // 保留最近 N 条不压缩
  triggerTokens: 100000,     // 绝对 token 阈值
}
```

**工具结果压缩** (`compressToolResult`):
- 独立于自动压缩，针对单次工具输出
- XLSX 结果: schema-aware 压缩（保留表头 + 采样行）
- 通用结果: 超过 token 阈值时截断或提取代码块

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

**HooksEngine 钩子**:

| 钩子 | 触发时机 | 功能 |
|------|----------|------|
| `onSessionStart` | 会话开始 | 检查未完成计划，重置计数器 |
| `preToolUse` | 工具执行前 | 注入错误历史，提醒当前任务 |
| `postToolUse` | 工具执行后 | 2-Action 规则，更新进度提醒 |
| `onStop` | AI 准备停止 | 验证计划完成度，决定是否强制继续 |
| `onError` | 发生错误 | 记录错误，检查 3-Strike 规则 |

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
