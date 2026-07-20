# Agent 核心架构

> 本文档详细描述 Agent 的核心组件：AgentOrchestrator、AgentLoop、运行时模块、平台抽象层、记忆系统、上下文压缩等

## 2026-07-11 Native Run 与 Goal 完成合同

Native Agent run 现在由独立 `runId` 拥有执行生命周期，`sessionId` 只承担会话与持久化身份。`RunContext` 冻结 workspace/cwd，`RunRegistry` 提供 session 唯一占用和 stale-owner-safe cleanup；控制、断线、本地工具与 Bridge 都绑定精确 RunHandle。完整链路见 [native-run-context.md](./native-run-context.md)。

Goal 完成链路新增一层可核验合同：

| 阶段 | 当前语义 | 关键文件 |
|------|----------|----------|
| deliverables 声明 | `declare_deliverables` 写入最终产物与 scratch 目录，允许显式覆盖并留下 trace | `runtime/declareDeliverablesGate.ts` |
| 闸 0 证据自证 | 核验产物真实存在、命令在本会话真实执行；纯软目标无证据时有界打回 | `runtime/goalEvidenceGate.ts` |
| 闸 1 verify | 验证失败与命令启动/终止基础设施失败分开；infra 问题进入降级链 | `goalVerifyGate.ts`、`runtime/goalCompletionGate.ts` |
| 闸 2 review | auth/provider unavailable 等没有产生评审结论时标记 unverifiable，不伪装成 review FAIL | `goalReviewGate.ts` |
| 修复止损 | gate repair 最多 2 次；artifact repair 达硬上限后中止 goal | `toolArtifactRepairPolicy.ts`、`shared/constants/agent.ts` |

模型脚手架通过 `scaffoldProfile.ts` 单点解析。strong 档可关闭重复 thinking 注入、把 audit nudge 间隔拉长一倍并使用 compact repair instruction；总开关默认关闭，关闭时恒为 standard，程序化证据/verify/review gate 不裁剪。

上下文组装同步做了 cache 经济性收口：会频繁变化的 advisory、git、active subagent、repair focus 等内容进入历史尾部 transient message，契约类 system 内容继续保留；工具表稳定排序。超过阈值的 active tool result 先完整 spill 到归档，再用无时间戳 placeholder 替换，归档失败时保留原文。决策与边界见 [ADR-032](./decisions/ADR-032-request-shape-prefix-stability.md)。

## 数据流概览

```
┌─────────────────┐
│  用户输入需求     │ "帮我写一个贪吃蛇游戏"
└────────┬────────┘
         │
         ▼ [IPC / HTTP / SSE]
┌─────────────────────────────────────────────────────────────────────────────┐
│                 平台抽象层 (src/host/platform/)                              │
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

**位置**: `src/host/platform/`

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

**位置**: `src/host/agent/agentOrchestrator.ts`

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

steer(newMessage: string, clientMessageId?, attachments?, metadata?): Promise<void>
  ├─ settled run 拒绝注入，由 steer lifecycle fence 转入 durable queued_inputs
  ├─ 中止当前 inference，把消息注入内存并请求下一轮 reinference
  └─ await SessionManager 落库后才 resolve；落库失败向调用方传播

requestPermission(request): Promise<boolean>
  ├─ 检查 AUTO_TEST 模式
  ├─ 检查 autoApprove 设置
  └─ 发送权限请求事件，等待用户响应
```

**子模块** (`src/host/agent/orchestrator/`):

| 模块 | 职责 |
|------|------|
| `types.ts` | `AgentOrchestratorConfig` 定义 |
| `dagManager.ts` | DAG 可视化状态映射 |
| `modelConfigResolver.ts` | 模型配置解析、默认模型选择、权限级别 |
| `researchRunner.ts` | Deep Research / Semantic Research 执行 |
| `autoAgentRunner.ts` | Auto Agent 模式执行 |

---

## AgentLoop（运行时拆分架构）

**位置**: `src/host/agent/agentLoop.ts` (薄包装层, ~332 行)

**背景**: 原 4350+ 行的单体 AgentLoop 已拆分为 5 个运行时模块 + 3 个辅助模块。AgentLoop 本身仅负责初始化 `RuntimeContext` 并将所有公共 API 委托给对应模块。

### RuntimeContext

**位置**: `src/host/agent/runtime/runtimeContext.ts` (~151 行)

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
  steer(newMessage: string, clientMessageId?, attachments?, metadata?): Promise<void> // → ConversationRuntime
  cancel(): void                                    // → ConversationRuntime
  interrupt(newMessage: string): void               // → ConversationRuntime
  setPlanMode(active: boolean): void                // → ConversationRuntime
  setEffortLevel(level: EffortLevel): void          // → ConversationRuntime
  setStructuredOutput(config): void                 // → ConversationRuntime
}
```

---

## 2026-06-17 Runtime governance / budget / compaction guard

6 月 16~17 日的新增运行时合同集中在“别让系统悄悄偏航”。它们不改变 AgentLoop 的主循环形态，而是在预算、工具结果、压缩和事件事实层补上可解释边界。

| 能力 | 当前合同 | 关键文件 |
|------|----------|----------|
| Budget alert runtime | `BudgetService` 按 reset period 聚合 token cost，配置包含 maxBudget、silent/warning/block 阈值和 resetPeriodHours；warning/blocked 只在跨入对应级别时向 UI listener 推一次，避免每次 `recordUsage` 刷屏 | `src/host/services/core/budgetService.ts` |
| Budget config hydration | 启动期用持久化 settings 初始化 BudgetService 单例；Settings 的 `getBudgetStatus/setBudgetConfig` 读写同一份配置，避免 UI 保存了但运行时单例仍用默认值 | `settings.ipc.ts`、`BudgetSettings.tsx`、`tests/unit/services/core/budgetStartupWiring.test.ts` |
| Tool required fields | 工具执行前检查 schema required 字段，缺字段时直接返回可被模型理解的 parse/required-field 反馈，让模型按 schema 重调，而不是进入 handler 后报模糊错误 | `src/host/tools/toolExecutor.ts` |
| Tool result recovery | auto-loaded retry 和已恢复失败不参与“工具报错”判定；真实失败有复制错误和从此重试 action，复用 session fork 路径 | `src/renderer/utils/toolExecutionPresentation.ts` |
| Bash result trust | Bash 长输出展示层保留头尾和最终进度帧；Bash metadata 里非 0 `exitCode` 会让 UI 标出“判定可能不可靠”，即使工具 result 被标成 success | `ToolCallDisplay/bashOutputPreview.ts`、`statusLabels.ts` |
| Compaction stuck guard | auto-compaction 成功插入 summary block 后重新估算 raw tokens；若连续多次仍超过绝对 token 或 warning ratio 阈值，则暂停 `_autoCompactPaused`，并注入 `<context-window-too-small>` 提示模型收窄范围 | `src/host/agent/runtime/contextAssembly/compression.ts` |
| AutoCompressor runtime state | `AutoContextCompressor` 只保留压力配置、token threshold、compaction 统计和 wrap-up；测试覆盖这组仍被生产消费的状态接口 | `tests/unit/context/autoCompressor.test.ts` |

边界：

- Budget alert 是可见性和提示，不是 provider 账单的实时硬拦截。真实成本仍受 provider usage、streaming timing 和价格目录影响。
- Tool required-field guard 只覆盖 schema 明确声明的 `required` 字段；语义错误仍由 handler、权限层或模型下一轮处理。
- Compaction stuck guard 和 `shouldWrapUp()` 是两条线：前者防反复无效压缩，后者按总 token budget 提醒收尾。

---

## 2026-06-12 Runtime hardening / learning loop / Max Mode

MiMoCode 对照之后，Agent runtime 增加了一批不依赖 UI 的运行时合同。它们的共同目标是把"模型应该自觉完成"改成"运行时能发现偏航并收口"。

| 能力 | 当前合同 | 关键文件 |
|------|----------|----------|
| 多级 Edit replacer | `MultiEdit` 的模糊替换先走 line-trimmed，再走 block anchor，再走 indentation-flexible；replace_all 不走高风险 fuzzy fallback，block anchor 对短锚点、截断块和超多候选 fail-closed | `src/host/tools/utils/editReplacers.ts`、`multiEdit.ts` |
| Doom loop guard | 同参重复、行动签名重复和空输出分别计数；重复到阈值后先注入 nudge，再在无法恢复时终止 run，避免无意义工具循环 | `src/host/agent/runtime/doomLoopGuard.ts` |
| Task gate | 模型准备停止前检查 Task/TaskManager mutation 后的未完成任务，按 owner 限制 main/subagent 重入次数，把"先收任务状态"变成运行时闸 | `src/host/agent/nudgeManager.ts`、`src/host/services/planning/taskStore.ts` |
| Goal impossible | `goal_complete` 的 impossible/aborted 不再被当成完成；强制最终解释走禁工具 final response，事件带真实 turns/tokensUsed | `src/host/agent/runtime/goalCompletionGate.ts`、`goalReviewGate.ts` |
| Retry and abort | 429/5xx/网络可重试，4xx/context overflow 不重试；`retry-after` 支持秒和 HTTP-date；sleep 可被 abort 打断 | `src/host/model/providers/retryStrategy.ts` |
| Max-step fallback | 步数耗尽时禁用工具，要求输出已完成/未完成/建议下一步三段式总结 | `src/host/agent/runtime/maxStepsFallback.ts` |
| Provider failure copy | `RUN_FAILED` 的 403/404/429/网络/并发限制被格式化成用户能操作的错误信息，不再只显示原始 provider 异常 | `src/renderer/hooks/agent/effects/useSessionLifecycleEffects.ts` |
| Checkpoint rebuild boundary | checkpoint writer 是后台 LLM 子代理路径；主循环插入重建边界前只短等 `REBUILD_FOREGROUND_WAIT_TIMEOUT_MS`，超时或没有明确成功结果即 fail-closed 回到 summary 压缩，避免前台 run 被长时间卡住或读 stale checkpoint | `contextAssembly/compression.ts`、`checkpointWriterService.ts`、`CHECKPOINT_WRITER` |

### History, memory and dream

`transcriptHistoryService` 为完整转录建立 FTS5 索引，索引粒度包括 `tool_input`、`tool_output`、`user_text`、`assistant_text` 和 `reasoning`。它和原有 `session_messages_fts` 分工不同：前者服务 agent 复盘和证据回查，后者服务普通会话搜索。

`History` 工具已经进入 deferred tool metadata，模型在需要"查以前怎么做过"时能被 ToolSearch/预加载路径发现。Memory packing 则用 SQLite FTS/BM25 补强本地召回，避免只靠最近窗口和应用层 token scoring。Dream consolidation 以 transcript FTS 的原始轨迹为证据，先验证再写 durable memory。

### Commands and provider variants

Slash command 现在有 `promptCommandService` 注册表，支持 frontmatter、`$ARGUMENTS`/位置参数模板、`.code-agent/commands/*.md` 文件式自定义命令和 MCP prompts 自动入表。主 prompt 不再只有单一通用版本，provider-family addendum 可以针对 Claude 系、GPT/国产系等失败模式做差异化约束，并通过 prompt A/B eval 验证。

### Max Mode

Max Mode 是显式开关：同一步先并发生成多个 propose-only 候选，再由 judge 选择赢家，最后只 replay 赢家的真实工具调用。候选与 judge 的 token/cost 作为 overhead 单独记账；取消会结算已发生 overhead 后退出；judge 输出只接受尾部锚定裁决，防止候选文本注入劫持赢家。

---

## 2026-05-15~17 Agent Engine 与接力运行

Agent Neo 现在把"谁来跑这一轮"拆成 engine 层。Native engine 继续走现有 `ConversationRuntime`；Codex CLI 和 Claude Code 通过受控 adapter 运行，并把输出归一回 session、TaskPanel 和 review 链路。

| 层 | 职责 | 文件 |
|----|------|------|
| Contract | 定义 `AgentEngineKind = native / codex_cli / claude_code`、安装状态、runtime 状态、capabilities、permission profile 和 session metadata | `src/shared/contract/agentEngine.ts` |
| Registry | 探测 `codex --version` / `claude --version`，生成 descriptor；Native engine label 是 Agent Neo | `src/host/services/agentEngine/agentEngineRegistry.ts` |
| Guard | 外部 engine 只允许 manual chat session、read-only profile、cwd 落在 workspace 内；read-only session、import session 和无 workspace 的 session 会被拒绝 | `src/host/services/agentEngine/agentEngineGuards.ts` |
| Adapters | Codex 走 `codex exec --json`，Claude 走 `claude -p --output-format stream-json --permission-mode plan`，事件流归一为文本、tool call、permission、task status、artifact ref、done/error | `codexCliAdapter.ts`、`claudeCodeAdapter.ts` |
| Persistence | `sessions.agent_engine` 记录当前 session 的 engine metadata；外部原始日志走 log path / output ref，不直接写进普通 messages | `SessionRepository`、`schema.ts` |
| Task 回带 | 外部 engine 的 cwd、命令摘要、日志路径、完成/失败状态写入 `BackgroundTaskLedger`，TaskPanel 与 Run Status Rail 展示 | `src/host/task/backgroundTaskLedger.ts`、`useRunWorkbenchModel.ts` |
| 历史导入 | Codex / Claude 历史 jsonl 可扫描、预览、标准化，供 review 或接力 | `agentEngineHistoryImport.ts` |

运行边界：
- Native Agent Neo 是唯一拥有完整工具/权限/trace/review 队列的默认 engine。
- 外部 engine 这一版作为受控接力能力，只给 read-only profile；需要写操作时回到 Native engine 或走显式后续设计。
- engine 选择属于 session state，前端通过 ModelSwitcher 操作，主进程通过 `agentEngine.ipc.ts` 校验后写回。

---

## 2026-06-05 会话自动化和角色创作运行时

这一批次给 `AgentOrchestrator.sendMessage()` 和 runtime 增加了两个新的运行边界：后台自动化轮次可以写入模型历史但不进入用户可见会话，特定 meta skill 可以硬收缩模型可见工具集，确保模型只能走草稿确认流程。

### `/loop` meta turns

`LoopController` 仍通过当前 session 的 orchestrator 逐轮 `sendMessage(buildTurnPrompt(state))`，但调用时传入：

```typescript
{
  mode: 'normal',
  historyVisibility: 'meta',
  deniedToolNames: ['AskUserQuestion', 'ask_user_question'],
}
```

运行时影响：

| 层 | 行为 |
|----|------|
| `RuntimeContext.historyVisibility` | 当前 run 被标为 meta，后续 message/event 写入会带 `isMeta` |
| `EventBatcher` / `StreamHandler` | `message_delta`、`message`、`stream_reasoning`、`turn_start` 透传 `isMeta`，避免 UI 把自动化轮次当普通 turn |
| `RunFinalizer` | summary 和 conversation judge 过滤 meta message 与 loop marker，避免 loop 内部提示词改写会话标题 |
| `toolRunPolicy` | 按 run 过滤禁用工具；后台 loop 禁止 `AskUserQuestion`，模型误调时注入 policy 反馈，超过 retry 上限后以 meta assistant message 结束 |

`LoopController` 同时把自身生命周期镜像到 `BackgroundTaskLedger`：

| 时机 | Task ledger 行为 |
|------|------------------|
| start | `upsertTask({ id: loopId, kind: 'loop', status: 'running', progress: 0/maxTurns })` |
| 每轮推进 | 更新 `progress.current`、`turn`、`lastTurnAt` |
| completed / failed / stopped | 映射为 `completed / failed / cancelled`，写 summary、duration、failure |
| 自然完成 / 失败 | `queueNotification()` 并调用 `notificationService.notifyTaskComplete(..., { force: true })` |

当前边界：loop 后台化是主进程内存运行 + ledger 镜像，尚未做 app 重启恢复。

### 对话式角色创建/修改

角色创建/修改走 skill-driven runtime：

```text
slash seed (/create-role 或 /edit-role <roleId>)
  -> skillInvocationResolver 命中 DIRECT_SLASH_PATTERN
  -> 注入 create-role / edit-role skill prompt
  -> 设置 skillToolBoundary + strictToolset
  -> deferredToolPreload 预加载 allowedTools 中的 propose_role
  -> 模型调用 propose_role
  -> role_draft_pending 事件
  -> renderer RoleDraftCard 用户确认
```

关键运行时约束：

| 约束 | 说明 |
|------|------|
| `strictToolset` | 仅 opt-in skill 生效。`filterToolDefinitionsByStrictSkillBoundary()` 把模型可见工具收缩到 allowedTools，防止模型直接用 `Edit/Write` 修改 `agents/*.md` |
| deferred allowedTools preload | active skill 的非 core allowedTools 会被加入本轮预加载列表，保证 `propose_role` 在 deferred-loading 模式下也对模型可见 |
| `propose_role` 只起草 | 工具调用 `enqueueRoleDraft()`，写入 `role-drafts/` 并 emit `role_draft_pending`，不写正式 agent 定义 |
| `editingRoleId` | 修改模式必须带现有角色 id；确认后只覆盖定义文件，不清空 `roles/<roleId>/` 资产 |

`strictToolset` 不改变普通 skill 的软边界语义。未声明 strict 的 skill 仍按 GAP-001：边界外工具可见，但调用时进入审批。

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

### 交付前 Critic（GAP-013，PR #196）

`deliveryCritic.ts` 实现 Generator-Critic 模式：交付前自动起一轮独立验证，发现 Critical 问题就阻塞交付。它建模在 `goalReviewGate` 的"闸 2"上，但语义相反——闸 2 是目标验收，出错 / 解析失败默认 FAIL（宁可多跑一轮）；critic 是附加质量门，**出错 / 解析失败 / 无明确 VERDICT 一律默认放行**（critic 误拦比漏检代价高，不能因它故障卡死正常交付）。每 run 最多跑一次，默认关闭，需 `CODE_AGENT_DELIVERY_CRITIC=1` 开启。critic 内部用只读工具 + `requestPermission` 自动放行。关键文件：`src/host/agent/deliveryCritic.ts`，常量 `DELIVERY_CRITIC`。

### 经验沉淀管线（GAP-005，阶段四）

`learningPipeline.ts` 从 no-op 壳重建为真正的经验沉淀管线。`runSessionEndLearning()` 在 `RunFinalizer.finalizeRun()` 结束时以 fire-and-forget 方式调用（不阻塞终态），从 `telemetry_tool_calls` 表提取两类模式：

| 模式 | 阈值 | 归一化键 | 产物 | 是否自动 |
|------|------|----------|------|----------|
| 失败模式 | 累计 ≥3 次（`FAILURE_PATTERN_THRESHOLD`） | toolName + errorCategory + 归一化错误消息（截断 100 字符） | 写入 Light Memory `failure-journal.md` | **全自动** |
| 成功工具序列 | n-gram（长度 2-4）出现 ≥3 次（`SUCCESS_PATTERN_THRESHOLD`） | 工具调用序列 | skill 草稿进 `~/.code-agent/skill-drafts/` 待确认队列 | **严禁自动入库**，emit 事件弹用户确认 |

- **失败侧**：写入 `failureJournal.ts`，新 session 由 messageBuild 注入 `<failure_journal>` 块（见上文 [上下文组装加固](#git-上下文-env-blockgap-010pr-194)）。journal 上限 30 条、每模式最多记 5 个来源 session。
- **成功侧**：`skillDraftQueue.ts` 把高频成功序列存为草稿（目录与 `skills/` 平级，避免被 discovery 扫描），emit `skill_draft_pending` 事件（`AgentEvent` union 新成员）弹用户确认，确认后才入库。草稿名还会过低价值过滤，`grep-read-edit`、`bash-bash-bash` 这类只描述工具序列的名字在写盘前直接拒绝。
- **事件通路**：`ctx.onEvent` → run SSE 流 → renderer `agent:event`（与 `suggestions_update` / `memory_learned` 同通路）。⚠️ `EventBus → EventBridge` 桥接在 webServer 架构下不会启动，learning 事件不能走该通路（commit 66c05b1e2 的修复点）。
- 常量集中在 `src/shared/constants/memory.ts` 的 `LEARNING_PIPELINE`。关键文件：`src/host/agent/runtime/learningPipeline.ts`、`src/host/lightMemory/failureJournal.ts`、`src/host/services/skills/skillDraftQueue.ts`。

### TaskManager-owned chat run

desktop chat 的 `sendMessage` 和 `interruptAndContinue` 优先走 TaskManager-owned run。这样 renderer 看到的 task/session 状态更接近同一个 owner，减少“一边 running、一边 idle”的漂移。

关键文件：

- `src/host/app/agentAppService.ts`
- `src/host/task/TaskManager.ts`
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

- `src/host/agent/runtime/runtimeStatePersistence.ts`
- `src/host/agent/runtime/contextAssembly/compression.ts`
- `src/host/agent/runtime/contextAssembly/systemContextStack.ts`
- `src/host/ipc/contextHealth.ipc.ts`
- `src/host/services/core/repositories/SessionRepository.ts`

这让 reload 后的 context view 不再只依赖 live singleton。持久化对象的具体表结构见 [data-storage.md](./data-storage.md)。

### Replay / eval completeness

Eval 不再只看 final answer。`TelemetryQueryService` 会构建 structured replay，把 session trace identity、model calls、tool calls、events、permission/context evidence 组织成可读对象。`real-agent-run` eval gate 需要 `sessionId + replayKey + telemetryCompleteness`，缺 model decision、tool schema、tool call 或 replay key 会 fail/degraded。

关键文件：

- `src/host/evaluation/telemetryQueryService.ts`
- `src/host/testing/testRunner.ts`
- `packages/eval-harness/src/runner/ExperimentRunner.ts`
- `src/shared/contract/evaluation.ts`

### Artifact verifier + product closure quality runtime

5/19 之后，旧 `AcceptanceRunner` / Delivery Review / Preview Feedback 链路已随 evaluation 子系统清理下线。6/1 之后，agent 交付质量状态进入 `ArtifactIssue`、`EvalReplayQualityReport` 和 Admin Review Queue；game / deck / dashboard 这类 kind-specific verifier 负责采集真实文件、浏览器 smoke 或运行时 contract 证据。

| 模块 | 位置 | 职责 |
|------|------|------|
| Product closure contract | `src/shared/contract/productClosure.ts` | `ArtifactIssue`、`ArtifactEvidenceRef`、`EvalReplayQualityReport`、`AdminReviewQueueItem` |
| ArtifactIssueRepository | `src/host/services/core/repositories/ArtifactIssueRepository.ts` | 持久化 issue/evidence/quality report/admin review 决策 |
| Admin review route | `src/web/routes/adminReviewQueue.ts` | app-host 本地 review queue API |
| Game verifier | `src/host/agent/runtime/game/*` | game subtype checker、runtime evidence 和 repair issue codes |
| DeckVerifier | `src/host/agent/runtime/deck/DeckVerifier.ts` | deck schema / narrative probes |
| DashboardVerifier | `src/host/agent/runtime/dashboard/DashboardVerifier.ts` | HTML probes、browser visual smoke、interaction probes |
| Repair guard | `src/host/agent/runtime/repair/*` | 控制 repair scope、修复轮次和单调性 |

### Artifact verifier family

artifact 验收分成通用 runner 和 kind-specific verifier 两层。当前不提前抽统一 `ArtifactKindVerifier` 接口，原因见 ADR-016：deck 多为 in-memory schema / narrative 检查，dashboard 需要真实浏览器 smoke，game 有运行时行为证据，强行统一会制造假抽象。

| Kind | 运行时 | 说明 |
|------|--------|------|
| Game | `src/host/agent/runtime/gameArtifactValidator.ts` + `runtime/game/*` | subtype registry、Platformer/Runner/Breakout checker、skill loader、verb taxonomy、repair codes |
| Deck | `src/host/agent/runtime/deck/DeckVerifier.ts` | schemaProbe + declarative / imperative narrative probes，替代旧 `validateNarrative` |
| Dashboard / interactive app | `src/host/agent/runtime/dashboard/*` | HTML probes、browser visual smoke、interaction probes、state_change_on_click 反 Potemkin |
| Browser visual smoke | `src/host/agent/runtime/browser/visualSmoke.ts` | desktop/mobile viewport、console/page errors、canvas 非空、overflow 等探针 |
| Repair toolkit | `src/host/agent/runtime/repair/*` | scope guards、monotonicity tracker、repair cap、Best-of-N 支撑 |

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
- `src/host/agent/shutdownProtocol.ts` — `initiateShutdown` 四阶段
- `src/host/agent/subagentExecutor.ts` — idle watchdog、`createChildAbortController` 桥接
- `src/shared/constants/timeouts.ts` — `CANCELLATION_TIMEOUTS`（`IDLE_TIMEOUT` / `IDLE_CHECK_INTERVAL` / `GRACEFUL_SHUTDOWN_GRACE` / `FLUSH_TIMEOUT`）

per-agent Stop UI 见 [multiagent-system.md](./multiagent-system.md) 的取消级联章节。

### Runtime Steer（运行中途转向）

用户在 agent 运行过程中插话不会取消整个 run。`ConversationRuntime.steer()` 先拒绝已经 settled 的 run；仍可转向时中止当前 inference，把消息注入内存并置 `needsReinference=true`，随后 **await** `messageProcessor.injectSteerMessage()` 的 SessionManager 落库。落库完成后 `steer()` 才 resolve，失败则向调用方传播，不能把未持久化输入报告为成功。`steerOrQueue()` 只在 `SteerRejectedError` / `SteerUnsupportedError` 时把原始 envelope 写入 durable `queued_inputs`，其他错误原样抛出；这条 lifecycle fence 避免 terminal settlement 后的晚到 steer 丢失。guided UI 用 `RuntimeInputDelivery` 元数据把消息标记为 `queued_next_turn`；web host 的 follow-up 接收并持久化 `clientMessageId`，为 prompt rewind 保留稳定标识。

关键文件：`src/host/agent/runtime/conversationRuntime.ts`、`src/host/agent/runtime/messageProcessor.ts`、`src/host/runtime/steerQueueFence.ts`、`src/web/routes/agent.ts`、`src/shared/contract/conversationEnvelope.ts`（`clientMessageId`）。

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

关键文件：`src/host/context/contextHealthService.ts`、`src/shared/contract/contextHealth.ts`、`src/renderer/components/ContextHealthPanel.tsx`。

---

## 子代理上下文注入（v0.16.55+）

**位置**: `src/host/agent/activeAgentContext.ts`

ContextAssembly 每轮推理前注入两类子代理信息：

1. **活跃子代理上下文** (`buildActiveAgentContext()`)：当有运行中子代理时，注入 `<active_subagents>` XML 块，包含每个 agent 的 id、role、status、task、已运行时长
2. **异步完成通知** (`drainCompletionNotifications()`)：子代理完成后，SpawnGuard 自动排队通知，contextAssembly 消费并注入 `<subagent_notification>` XML（含 output 摘要、工具调用数、迭代数、成本、耗时）

**SubagentExecutor 消息队列**：
- `send_input` 工具将消息推入子代理的 `messageQueue`
- SubagentExecutor 每轮迭代开始时 `drainMessages()`，将父 agent 消息注入为 `[Parent agent message]: ...`

---

## 模型路由决策（ADR-019，2026-06-03）

ContextAssembly 每轮推理前要决定"这一轮用哪个模型"。此前存在两套互不感知的选择系统 + 两条引擎行为不一致 + adaptive 标志泄漏，[ADR-019](../decisions/019-auto-mode-scope.md) 把它收口成单一决策入口。

### 单一决策入口 resolveModelDecision

**位置**: `src/host/model/modelDecision.ts`

所有路由决策（主聊天 adaptive / subagent 角色分层）的唯一出口，输出结构化 `ModelDecision`，UI trace / 日志 / 成本统计统一消费同一个对象。两条推理引擎（aiSdk / legacy `modelRouter`）的 simple 路由都经此决策，引擎只负责执行层的 API key 解析。三条硬规则：

1. **subagent 永远剥离 adaptive**：角色分层是确定性映射，不被 adaptive 覆盖（修复 `...ctx.modelConfig` spread 泄漏）。
2. **simple → 免费档仅 `payg` 生效**：包月 / 未知 provider 不做省钱路由（计费门控，见下）。
3. **永不向上**：所有切换只会切到免费档，不会切到更贵的模型。

`runEngineInference` 在 aiSdk 路径调用 `resolveMainChatModelDecision`：决策为 `simple-task-free` 时解析免费模型的 apiKey、跨 provider 清 baseUrl、失败回退默认模型、401/403 永久禁用免费模型；无论是否改路由都发 `model_decision` 事件供 UI 消费（`src/host/agent/runtime/contextAssembly/inference.ts`）。

### 计费语义四分类

替代不可维护的"价格感知路由"。`BillingMode` = `free` / `plan` / `payg` / `unknown`，区分"市场价"（全局常量）与"用户的计费方式"（用户配置）。`resolveProviderBillingMode()` 优先读用户设置，缺省时普通 provider 取 `payg`、动态 custom provider 取 `unknown`。详见 [模型配置指南](../guides/model-config.md#计费语义四分类adr-019-决策-42026-06-03)。

### 角色档位去硬编码

subagent 角色映射到抽象档位（`fast` / `balanced` / `powerful`），`resolveTierModelConfig()` 在运行时按用户已配置的 provider 解析：主力档 = 用户默认模型（不硬编码厂商）；fast / balanced 档的内置推荐只在用户配了对应 key 时使用，否则降级到用户默认模型。保证分发给没配特定厂商 key 的用户也不会让 subagent 直接坏掉（`getSubagentModelConfig` → `agentDefinition.ts`）。

### model_decision 透传与可视化

`ModelDecision` 经 `model_decision` 事件透传到 trace / 消息，renderer 据此渲染 RouteTraceChip（收起式路由 chip）、FallbackBanner（降级横幅原位插入聊天流）、subagent 任务卡常驻模型标签。契约见 `src/shared/contract/modelDecision.ts`，UI 见 `src/renderer/components/features/chat/`。

---

## 上下文组装加固（极客时间差距修复，2026-06-02）

这一轮把 ContextAssembly 的"注入什么、注入多少、超额怎么办"补成可解释的闭环。详见 [极客时间差距修复 spec](../specs/2026-06-02-geektime-gap-remediation.md)。

### Git 上下文 env block（GAP-010，PR #194）

env block 在新 session 注入当前 git 状态，让"继续昨天的活"无需手动报告分支。`getGitContext()` 采集当前分支、最近若干 commit、working tree dirty 文件数，拼进 env 上下文块。分支 / commit / dirty 是易变信息，按目录维度做 TTL 缓存（`gitContextCache`），repo 检测结果单独缓存（`gitRepoCache`）避免重复 `execSync`；非 git 目录直接跳过。关键文件：`src/host/agent/messageHandling/contextBuilder.ts`。

### 工具结果落盘（GAP-009，PR #194）

超阈值的工具输出不再被直接截断丢弃，而是先落盘再截断。所有截断点（bash 30K chars / MCP 50K chars / L1 budget 2000 tokens）在截断前调用 `spillToolResult()`，把完整输出写入 session 临时目录 `~/.code-agent/tmp/<session>/tool-results/`，上下文里只保留摘要 + 文件路径提示，agent 可用 Read / Grep 零成本回查完整内容，不必重跑命令。

- **best-effort**：落盘失败绝不影响工具结果本身（返回 null，调用方跳过提示）
- **防重复**：已带 `SPILL_NOTICE_MARKER` 落盘提示的内容跳过二次落盘；该 marker 同时让 CompactionService 的 `compressToolResult` 在压缩后保留落盘提示
- **路径消毒**：sessionId / toolName 经 `sanitizeSegment` 过滤，防 `..` 遍历

关键文件：`src/host/utils/toolResultSpill.ts`，常量 `TOOL_RESULT_SPILL`（`src/shared/constants.ts`）。

### 工具结果归档 + 自动回水（spill 演进，2026-06-24）

GAP-009 的"落盘后截断"进一步升级为**可寻址归档 + 按需回水**，让被预算裁掉的大工具结果既不占上下文、又能零成本找回原文：

- **归档引用（ArchiveRef）**：超预算的工具结果落盘时生成稳定句柄 `tool_result:<session>:<tool>:<…>:<hash12>`，挂在 `CompressionState` 的 `budgetedResults` 上（`compressionState.ts` / `layers/toolResultBudget.ts`），并随 survivor manifest 一起带过压缩边界（`survivorManifest.ts`），压缩后下一轮仍能定位原文。
- **回读工具 `read_tool_result_archive`**：agent 可用 ArchiveRef 分页读归档原文（`offset`/`limit`，默认 1/2000、上限 5000 行，行号对齐 Read 格式），结果走 `createVirtualArtifact` 落虚拟产物、不二次膨胀上下文。文件：`src/host/tools/modules/file/toolResultArchive.ts`(+`.schema.ts`)，经 `tools/modules/index.ts` 注册，MCP 侧在 `mcpToolRegistry.ts` 暴露。
- **自动回水（archiveHydration）**：组装下一轮上下文时，若最近一条用户消息在要原始证据（"完整输出 / 原始结果 / raw evidence / full output"等模式）或直接引用了某个 archive id，则把对应归档内容**自动注回**上下文（上限 `MAX_AUTO_HYDRATE_CHARS`=24K），agent 无需显式调工具即可拿到原文。文件：`src/host/agent/runtime/contextAssembly/archiveHydration.ts`，接入 `compression.ts` / `messageBuild.ts` / `context/compactionService.ts`。

相比纯 spill（只留路径提示、靠 Read/Grep 回查），归档把"哪段结果、属于哪个工具调用、内容指纹"结构化，并在用户明确要原文时自动补回，省一轮工具往返。归档读写入口：`src/host/utils/toolResultSpill.ts` 的 `findToolResultArchiveRef` / `readToolResultArchive`。

### System prompt 预算动态化 + 块优先级（GAP-023，PR #196）

原 system prompt 预算是固定 6000 tokens，重记忆 / 大窗口模型下会把能力发现块挤掉。本轮改为三件事：

1. **预算动态化**：`getSystemPromptBudget(model)` 返回 `max(SYSTEM_PROMPT_BUDGET.MIN_TOKENS, 模型窗口 × WINDOW_RATIO)`（即下限 6000，否则取窗口 10%）；`CODE_AGENT_MAX_SYSTEM_PROMPT_TOKENS` 可强制抬到上限。
2. **块优先级排序**：能力发现块（available plugins / skills / deferred-tools）先于锦上添花块（session metadata / memory hint / recent conversations）追加，预算吃紧时优先保住"模型知道自己有哪些能力可用"——修复重记忆环境下 deferred 工具发现机制静默失效的问题。
3. **丢弃可见化**：runtime ctx 新增 `droppedPromptBlocks`（dynamic prompt 缓存命中时也会恢复），预算跳过 + required 块裁剪两条路径都经 `recordDroppedPromptBlock` 去重记录；该字段流入 `ContextHealthState`，UI 的 `ContextHealthPanel` 新增橙色"被丢块"警告区，不再只有 debug log。

`appendPromptBlockWithinBudget` / `appendPromptBlockWithinBudgetWithStatus` 是统一的预算守门入口，`required` 块在超额时裁剪 base prompt 而非丢弃。关键文件：`src/host/agent/runtime/contextAssembly/messageBuild.ts`、`shared.ts`、`src/host/context/contextHealthService.ts`。

### Failure Journal 注入（GAP-005，阶段四）

新 session 组装时，`buildFailureJournalBlock()` 从 Light Memory 的 `failure-journal.md` 读取最近的失败模式，注入 `<failure_journal>` 块（最多 `INJECTION_MAX_ENTRIES`=15 条，按 lastSeen 取最新），让 agent 开局就知道"哪些操作历史上反复失败"。该块同样走预算守门，会被记入 context health 的块统计（`blockType: 'failure_journal'`）。journal 的产生侧见下文 [学习管线](#经验沉淀管线gap-005阶段四)。关键文件：`src/host/agent/runtime/contextAssembly/messageBuild.ts`、`src/host/lightMemory/failureJournal.ts`。

---

## 上下文压缩生产链路

**位置**: `src/host/context/compressionPipeline.ts`、`src/host/context/contextPressureController.ts`、`src/host/context/compactionService.ts`

线上链路由三段组成。`ContextAssembly` 每轮先运行 `CompressionPipeline` 生成非破坏性的 API projection；若投影后的上下文仍达到 L5 压力线，只上报 `autocompact-needed`。`checkAndAutoCompress()` 再把这个信号、绝对 token 阈值和百分比 warning 交给 `ContextPressureController` 统一裁决，选择 checkpoint rebuild 或调用 `CompactionService` 生成并提交 handoff summary。

| 层级 | 触发 | 当前行为 |
|------|------|----------|
| L0 Active Tool Result Prune | 默认启用；单条已消费 tool result `>4096` tokens | 先完整归档，再用确定性的 archive pointer 替换正文；fresh result 首轮豁免 |
| L1 Tool Result Budget | **always** | 单条已消费 tool result 上限 2000 tokens，超限时先归档再 head+tail 截断；最后一条 assistant 之后、模型尚未看过的 fresh result 进入 L1 保护集合，首轮不截断 |
| L2 Snip | projected usage `>=50%` | 对超过保留轮次的可裁内容做 snip |
| L3 Microcompact | post-snip usage `>=60%` | 按主线程、cache hotness 和 idle 时间做 deterministic microcompact |
| L4 Context Collapse | post-micro usage `>=75%` | 有 summarizer 时折叠至少 3 条的 span；缺 summarizer 显式记录 skip marker |
| L5 Autocompact signal | final projected usage `>=85%` | 只上报 `autocompact-needed`，不在 Pipeline 内直接改写历史 |

`ContextPressureController` 的决策优先级是 Pipeline 85% 信号、绝对 token 阈值、百分比 warning。执行 summary compaction 时，`CompactionService` 先解析 safe span：默认边界把 latest user instruction 留在 preserved side；默认或显式边界都不能拆开工具调用与结果，未闭合 tool call 同样保留。`compact-current` 自动生成的显式 anchor 先在 IPC 层钳到 latest user，再交给服务层的工具协议边界。安全规则最终留下少于 2 条可压消息时显式返回 `no_safe_compaction_span`；通过检查后才构建 survivor manifest，运行 hooks、summary、audit 和 validation，最后提交 compaction block。

旧 `AutoContextCompressor.checkAndCompress()` 三层入口及其独占 helper 已删除；`AutoContextCompressor` 只保留生产链路仍消费的配置、token threshold、统计和 wrap-up 状态。压缩执行统一走 `CompressionPipeline + ContextPressureController + CompactionService`，决策见 [ADR-045](./decisions/ADR-045-context-compression-single-architecture.md)。

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

压缩层级、阈值和生产调用关系以 `compressionPipeline.ts`、`contextPressureController.ts` 与 `contextAssembly/{messageBuild,compression}.ts` 为事实源；`CompactionService` 负责安全摘要与提交，不等同于整条压缩管线。

---

## Light Memory 系统

**位置**: `src/host/lightMemory/`

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

**位置**: `src/host/prompts/identity.ts`

**组成部分**:

| 导出常量 | 内容 | Token 估算 |
|----------|------|------------|
| `IDENTITY` | 核心身份声明 + 安全规则（3 条 IMPORTANT） | ~100 |
| `CONCISENESS_RULES` | 简洁输出要求 + IACT 内联交互语法 | ~200 |
| `TASK_GUIDELINES` | Thinking 引导、任务执行流程、Recon-Before-Action、One-Shot Script | ~200 |
| `TOOL_DISCIPLINE` | 工具参数纪律 + 并行调用指导 | ~100 |
| `MEMORY_SYSTEM` | Light Memory 使用说明（类型/写入门控/读取/维护） | ~150 |

**Generative UI 注入** (`src/host/prompts/generativeUI.ts`):

身份系统现在包含 Generative UI 提示注入，指导模型生成交互式可视化内容：
- `chart` 代码块: bar/line/area/pie/radar/scatter 图表
- `generative_ui` 代码块: 完整 HTML 交互式内容

---

## 统一遥测系统

**位置**: `src/host/telemetry/`

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

- `src/host/prompts/projectSystemPrompt.ts`：文件查找 / 读取 / 兜底（不存在返回 null，IO 错误 warn 一行）
- `src/host/agent/runtime/contextAssembly/messageBuild.ts`：
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

**位置**: `src/host/services/skills/comboRecorder.ts`

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

**位置**: `src/host/planning/TaskComplexityAnalyzer.ts`

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

**位置**: `src/host/planning/`

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

**用户 Hook 系统**（`src/host/hooks/hookManager.ts`）:

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

**Stop hook 完成闸 + PostToolUse 自修复**（GAP-006+014，PR #196）：

对齐 Claude Code 的 hook 协议，让 hook 不只是观察，还能驱动 agent 继续工作和自修复。详见 [极客时间差距修复 spec](../specs/2026-06-02-geektime-gap-remediation.md)。

- **Stop hook 完成闸**：Stop hook 返回 block 时 agent 不直接停，而是继续工作（把 block 的 reason 当作未完成信号回灌）。`stopHookActive` 标记防止重入死循环，`STOP_HOOK.USER_MAX_RETRIES` 作为安全阀限制强制继续的次数。
- **CC 兼容协议**：`scriptExecutor` 解析 hook 脚本 JSON 输出的 `decision`（`block`）/ `reason` 以及 `additionalContext`（兼容顶层字段与 CC 的 `hookSpecificOutput.additionalContext` 嵌套格式）。
- **PostToolUse 上下文注入**：PostToolUse hook 输出的 `additionalContext` 被注入下一轮上下文，让 hook 能基于工具结果给 agent 追加指令（如"刚改的文件有 lint 错，先修"）。
- 关键文件：`src/host/hooks/hookManager.ts`、`src/host/hooks/scriptExecutor.ts`、`src/host/agent/runtime/messageProcessor.ts`、`runtimeContext.ts`。

**配置未知字段告警**（GAP-007，PR #192）：hooks 配置解析器遇到未知 / 拼错的字段时输出 warning 而非静默忽略，避免用户写错 key 后 hook 不生效却无任何提示。关键文件：`src/host/hooks/configParser.ts`。

---

## Anti-pattern Detection

**位置**: `src/host/agent/antiPattern/detector.ts`

**功能**: 检测 AI 陷入无限只读循环的情况，是[反循环防御三层](../ARCHITECTURE.md)（见「2026-06-06 ~ 06-07 新增模块」章节）中的 **L2**。

**检测规则**（连续**只读操作**计数，写工具 / Bash / `markSemanticProgress` 清零）：

| 阶段 | 阈值 | 触发条件 | 处置 |
|------|------|----------|------|
| **创建前警告** | 5 次 | 写入前连续 5 次只读 | 软提示 "停止重复阅读/搜索，用已有证据作答" |
| **创建后警告** | 10 次 | 写入后连续 10 次只读 | 软提示 "任务可能已完成，停止过度验证" |
| **HARD_LIMIT** | 15 次 | 连续 15 次只读 | preflight 阻断该工具 + `activateForceFinalResponse`，把"基于已有证据直接输出结论"作为工具结果回灌，强制模型收尾 |

**只读工具范围**（`loopTypes.ts` 的 `READ_ONLY_TOOLS`）：`read_file`/`Read`、`glob`、`grep`、`list_directory`，以及联网读取 `web_fetch`/`WebFetch`/`web_search`/`WebSearch`。
> ⚠️ 2026-06-07 修复：`WebSearch`/`WebFetch` 之前漏在集合外（模型实发 PascalCase），导致弱模型反复联网重搜时 L2 完全不计数，run 被中断后 0 条 assistant 落库 → 空白"待处理"会话。新增无界只读工具时务必同步登记（PascalCase + snake_case 别名都加）。详见 [troubleshooting.md「普通对话里反复 WebSearch 不收敛」](../guides/troubleshooting.md)。

**L3 — 语义重搜检测**（`src/host/agent/runtime/stagnationDetector.ts` 的 `pushAndDetectToolSpam`）：L2 按"只读 op 数"计数抓不住"换关键词重搜同一意图"（args 变→旧 fingerprint 变），L3 改按**工具名**计数——同一检索类工具（WebSearch/WebFetch/ToolSearch）在 6 次窗口内 ≥4 次即注入一次软提示，引导用现有结果作答或如实说明限制。L2（防"读不停"）与 L3（防"换词重搜"）正交互补。

**解决的问题**:
- AI 创建文件后陷入无限验证循环
- AI 在创建/研究任务中过度读取或反复联网重搜而不收尾
- 弱模型拿到可用结果仍自我怀疑、无限重搜成空白会话

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

**位置**: `src/host/model/ModelRouter.ts`

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

**位置**: `src/host/scheduler/`

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

**位置**: `src/host/agent/nudgeManager.ts`

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

**位置**: `src/host/services/FileCheckpointService.ts`

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

**位置**: `src/host/agent/subagent/` 相关模块

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

**位置**: `src/host/core/container.ts`

轻量级 DI 容器，管理服务生命周期和依赖关系。

### 生命周期

| 类型 | 说明 |
|------|------|
| `Singleton` | 全局单例，首次获取时创建 |
| `Factory` | 每次获取创建新实例 |
| `Transient` | 临时实例，不缓存 |

### 生命周期管理

**位置**: `src/host/core/lifecycle.ts`

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
