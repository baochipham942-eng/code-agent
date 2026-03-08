# Agent 核心架构

> 本文档详细描述 Agent 的核心组件：AgentOrchestrator、AgentLoop、规划系统

## 数据流概览

```
┌─────────────────┐
│  👤 用户输入需求   │ "帮我写一个贪吃蛇游戏"
└────────┬────────┘
         │
         ▼ [IPC: agent:send-message]
┌─────────────────────────────────────────────────────────────────────────────┐
│                         主进程 - AgentOrchestrator                          │
│  1. 创建 User Message { id, role: 'user', content, timestamp }              │
│  2. 获取 ModelConfig (DeepSeek API Key, Model ID)                           │
│  3. 创建 AgentLoop 实例                                                     │
└────────┬────────────────────────────────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                              AgentLoop.run()                                │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│   ┌─── 迭代 N ────────────────────────────────────────────────────────┐    │
│   │                                                                   │    │
│   │  1️⃣ INFERENCE 阶段                                               │    │
│   │     buildModelMessages() → ModelRouter.inference()                │    │
│   │                                                                   │    │
│   │  2️⃣ 响应处理分支                                                 │    │
│   │     ┌─ type === 'text' ──────────────────────────────────────┐   │    │
│   │     │ • 创建 assistantMessage → onEvent → BREAK              │   │    │
│   │     └────────────────────────────────────────────────────────┘   │    │
│   │     ┌─ type === 'tool_use' ──────────────────────────────────┐   │    │
│   │     │ • 执行工具 → 创建 toolMessage → CONTINUE               │   │    │
│   │     └────────────────────────────────────────────────────────┘   │    │
│   │                                                                   │    │
│   └───────────────────────────────────────────────────────────────────┘    │
│                                                                             │
│   onEvent({ type: 'agent_complete' })                                      │
└─────────────────────────────────────────────────────────────────────────────┘
```

## AgentOrchestrator

**位置**: `src/main/agent/AgentOrchestrator.ts`

**职责**:
- 管理对话消息历史
- 处理权限请求/响应
- 获取模型配置
- 创建和启动 AgentLoop
- 处理代际切换

**关键方法**:
```typescript
sendMessage(content: string): Promise<void>
  ├─ 创建 user message
  ├─ 添加到历史
  ├─ 获取 ModelConfig
  ├─ 创建 AgentLoop
  └─ 运行 loop

requestPermission(request): Promise<boolean>
  ├─ 检查 AUTO_TEST 模式
  ├─ 检查 autoApprove 设置
  └─ 发送权限请求事件，等待用户响应
```

## AgentLoop

**位置**: `src/main/agent/AgentLoop.ts`

**核心循环**:
```typescript
while (!isCancelled && iterations < 50) {
  iterations++;

  // 1. 推理
  response = await inference();

  // 2. 处理响应
  if (response.type === 'text') {
    // Stop Hook 验证 → 创建助手消息 → 发送事件 → BREAK
  }

  if (response.type === 'tool_use') {
    // Pre-Tool Hook → 执行工具 → Anti-pattern Detection → Post-Tool Hook
    // 创建工具结果消息 → CONTINUE
  }
}
```

**增强功能**:
1. **任务复杂度分析** - 在 `run()` 开始时自动检测任务类型
2. **Anti-pattern Detection** - 检测连续读操作，防止无限循环
3. **Planning Hooks** - 集成规划系统的生命周期钩子
4. **Turn-Based Message Model** - 基于行业最佳实践的消息流架构

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

**实现位置**:

| 文件 | 职责 |
|------|------|
| `AgentLoop.ts` | 生成 turnId，发送 turn_start/turn_end 事件 |
| `useAgent.ts` | 处理事件，使用 turnId 定位和更新消息 |
| `types.ts` | 定义 AgentEvent 类型（含 turnId） |

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

**位置**: `AgentLoop.ts` 内置

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

### 工具定义

**enter_plan_mode** (`src/main/tools/gen3/enterPlanMode.ts`)
- 输入: `reason` (可选) - 进入规划的原因
- 输出: 规划阶段指导
- 副作用: 设置 `planModeActive = true`

**exit_plan_mode** (`src/main/tools/gen3/exitPlanMode.ts`)
- 输入: `plan` (必填) - Markdown 格式的实现计划
- 输出: 计划展示 + 确认提示
- 副作用: 设置 `planModeActive = false`
- 元数据: `requiresUserConfirmation: true`

### 状态管理

**AgentLoop** 维护 `planModeActive` 状态：

```typescript
class AgentLoop {
  private planModeActive = false;

  setPlanMode(active: boolean) {
    this.planModeActive = active;
  }
}
```

状态通过 `ToolContext` 传递给工具：

```typescript
interface ToolContext {
  setPlanMode?: (active: boolean) => void;
  emitEvent?: (type: string, data: unknown) => void;
  // ...
}
```

### 可用代际

Plan Mode 从 **Gen3** 开始可用，覆盖 Gen3-Gen8。

---

## ModelRouter

**位置**: `src/main/model/ModelRouter.ts`

**支持的模型提供商**:

| Provider | 模型 | 特性 |
|----------|------|------|
| DeepSeek | deepseek-chat, deepseek-reasoner | 主要使用 |
| OpenAI | gpt-4o, gpt-4o-mini | 备选 |
| Claude | claude-sonnet-4, claude-opus-4 | 高级推理 |
| Groq | llama-3.3-70b | 快速推理 |
| 智谱 | glm-4-plus, glm-4v-plus | 中文优化、视觉理解 |
| 通义千问 | qwen-max, qwen-coder-plus | 代码专用 |
| Moonshot | moonshot-v1-128k | 超长上下文 |

---

## DAG 任务调度系统 (v0.16+)

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

## Nudge 机制 (v0.16.11+)

**位置**: `src/main/agent/AgentLoop.ts`

Nudge 是一种非侵入式的提示机制，用于引导 AI 完成任务而不是过早停止。

### P1 Nudge - 只读停止检测

**触发条件**: AI 在没有执行任何写操作的情况下准备停止

```typescript
// 检测逻辑
if (hasOnlyReadOperations && isAboutToStop) {
  injectNudge("你似乎只进行了探索，还没有实际修改。请继续完成任务。");
}
```

### P2 Checkpoint 验证

**触发条件**: 任务完成时验证文件修改是否与任务目标一致

```typescript
// 验证逻辑
const modifiedFiles = getModifiedFilesSinceCheckpoint();
if (!modifiedFiles.includes(expectedFile)) {
  injectNudge("你修改的文件似乎与任务目标不符，请检查。");
}
```

### P3 文件完成追踪

**触发条件**: 追踪每个文件的完成状态

| 状态 | 含义 |
|------|------|
| `created` | 文件已创建 |
| `modified` | 文件已修改 |
| `verified` | 文件已验证 |
| `completed` | 任务完成 |

---

## Checkpoint 系统 (v0.16.11+, v0.16.42 修复)

**位置**: `src/main/services/checkpoint/fileCheckpointService.ts`

文件版本快照系统，在 Write/Edit 工具执行前自动保存原文件内容，支持 Esc+Esc 触发的 Rewind 回滚。

### 架构

```
ToolExecutor.execute()
  → fileCheckpointMiddleware（拦截 Write/Edit，使用 tool.name 规范名）
    → FileCheckpointService.createCheckpoint()
      → SQLite file_checkpoints 表

RewindPanel (Esc+Esc)
  → checkpoint:list / checkpoint:preview / checkpoint:rewind (IPC)
    → FileCheckpointService.rewindFiles()  （文件恢复）
    → DatabaseService.deleteMessagesFrom() （消息截断）
    → Orchestrator.setMessages()           （内存同步）
    → 前端 setMessages() 刷新             （UI 同步）
```

### 核心功能

| 功能 | 描述 |
|------|------|
| `createCheckpoint()` | Write/Edit 执行前自动保存原文件内容 |
| `rewindFiles()` | 回滚到指定消息之前的文件状态 |
| `getCheckpoints()` | 获取 session 的所有检查点 |
| `cleanup()` | 清理过期检查点（7 天 / 启动时自动执行） |
| `deleteMessagesFrom()` | Rewind 时截断对话消息（DB + 内存 + 前端） |

### 数据库表结构

```sql
CREATE TABLE file_checkpoints (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  message_id TEXT NOT NULL,
  file_path TEXT NOT NULL,
  original_content TEXT,     -- null 表示文件原本不存在
  file_existed INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
```

### 限制

| 项目 | 值 |
|------|------|
| 单文件上限 | 1MB（大文件跳过） |
| 每 session 上限 | 50 个检查点（FIFO 淘汰） |
| 保留期 | 7 天 |
| 监控工具 | Write、Edit（Bash 不在监控范围） |

### 使用场景

1. **Write/Edit 执行前**: middleware 自动创建检查点
2. **Esc+Esc 触发 Rewind**: 文件恢复 + 消息截断 + UI 刷新
3. **启动时**: 自动清理过期检查点

---

## Subagent 系统优化 (v0.16.12+)

**位置**: `src/main/agent/subagent/`

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

### 复杂度分析与动态模式检测

```typescript
// 任务复杂度自动检测
const complexity = analyzeComplexity(userMessage);
// SIMPLE → 直接执行
// MODERATE → 简单规划
// COMPLEX → 完整规划 + 子代理分工
```

### Cowork 框架

子代理间协作框架，支持：
- **串行协作**: A → B → C
- **并行协作**: A, B, C 同时执行
- **混合协作**: A → (B, C 并行) → D

---

## 依赖注入容器 (v0.16+)

**位置**: `src/main/core/container.ts`

轻量级 DI 容器，管理服务生命周期和依赖关系。

### 生命周期

| 类型 | 说明 |
|------|------|
| `Singleton` | 全局单例，首次获取时创建 |
| `Factory` | 每次获取创建新实例 |
| `Transient` | 临时实例，不缓存 |

### 接口定义

```typescript
// 可初始化接口
interface Initializable {
  initialize(): Promise<void>;
}

// 可销毁接口
interface Disposable {
  dispose(): Promise<void>;
}
```

### 使用示例

```typescript
// 注册服务
container.register('database', DatabaseService, Lifecycle.Singleton);
container.register('logger', LoggerService, Lifecycle.Singleton);
container.register('agentLoop', AgentLoop, Lifecycle.Factory);

// 获取服务
const db = container.get<DatabaseService>('database');

// 初始化所有服务
await container.initializeAll();

// 销毁所有服务
await container.disposeAll();
```

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
