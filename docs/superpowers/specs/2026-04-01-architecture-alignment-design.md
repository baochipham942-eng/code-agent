# Code Agent 架构对齐设计规格

> 将 CA 核心路径的实现深度从 30-40% 提升到 100%，对齐成熟 code agent 架构，同时利用多模型优势做差异化增强。

## 约束与边界

- **范围**：架构对齐 + 核心功能对等 + 多模型差异化增强
- **不做**：Cloud control plane / bridge transport / CCR v2 等依赖 Anthropic 基础设施的部分（CA 用 Supabase 已有自己的方案）
- **交付节奏**：4 个里程碑，每个 5-6 大步，逐步交付
- **验证标准**：每个 step 完成后 `npm run typecheck` 通过 + commit

## 差距总览

| 能力面 | 当前深度 | 目标 | 里程碑 |
|--------|---------|------|--------|
| 上下文管理 | 30% | 100% | M1 |
| Agent Loop 恢复 | 40% | 100% | M1 |
| Prompt 装配 | 40% | 100% | M2 |
| 多 Agent 运行时 | 50% | 100% | M2 |
| 权限矩阵 | 50% | 100% | M3 |
| 事件系统 | 40% | 100% | M3 |
| 会话连续性 | 70% | 100% | M3 |
| Provider 适配 | 70% | 100% | M4 |
| Operator Surface | 50% | 100% | M4 |
| 多模型路由（差异化） | 70% | 超越 | M4 |

## 里程碑依赖

```
M1 (Token + Context + Loop)
  ↓ 提供投影架构和精确 token 计数
M2 (Prompt + Multi-Agent)
  ↓ 提供 prompt 矩阵和子 agent 运行时
M3 (Permissions + Events + Continuity)
  ↓ 提供权限竞争和事件持久化
M4 (Multi-Model + Operator)
  ↑ 整合 M1-M3 所有基础设施
```

---

## M1：关键路径端到端 — Token + 上下文投影 + Loop 恢复

**目标**：上下文管理从"原地变异"升级为"投影优先"，主循环从"一次性重试"升级为"多分支决策"。

### M1-S1：精确 Token 计数

**现状**：`tokenEstimator.ts` 用字符比例启发式（CJK=2.0, 英文=3.5），误差 10-30%。
**目标**：引入 `js-tiktoken`，误差 <1%。

变更清单：
- `src/main/context/tokenEstimator.ts`：替换核心算法，接口不变（`estimateTokens(text): number`）
- 保留 LRU 缓存（200 条），缓存真实 token 数
- 新增 `countTokensExact(messages[]): number`，给上下文决策层用
- 按模型族选择 tokenizer：cl100k_base（OpenAI/Anthropic），其他 provider 用近似映射
- `src/shared/constants.ts`：新增 `TOKENIZER_MAP` 常量，禁止在业务代码中硬编码 tokenizer 名

验证标准：
- 单测：对比启发式 vs tiktoken 结果，确认误差 <1%
- 集成：现有 autoCompressor 逻辑在精确 token 数下仍正常工作

### M1-S2：上下文投影架构（核心架构变更）

**现状**：`autoCompressor` 直接删除/修改消息历史。
**目标**：transcript 不可变 + 压缩状态独立存储 + 查询时投影。

架构：

```
Transcript (append-only, immutable)
    ↓
CompressionState (commit log + snapshot)
    ↓ query-time projection
API View (model actually sees)
```

新增文件：
- `src/main/context/projectionEngine.ts`：投影引擎核心
  - `projectMessages(transcript, compressionState): Message[]` — 从 transcript + state 生成 API 视图
  - 按层叠加压缩操作：每层的 commits 按序应用到 transcript 副本上
  - 纯函数，无副作用
- `src/main/context/compressionState.ts`：双持久化
  - `CommitLog`：append-only 操作序列（`{layerId, operation, targetMessageIds, timestamp}`）
  - `Snapshot`：当前状态快照（`{snippedIds, collapsedSpans, budgetedResults}`），last-wins
  - `applyCommit(commit)` → 更新 snapshot + 追加 log
  - `reset()` → 清空 snapshot + 记录 reset commit（防止旧 session 污染）

改造文件：
- `src/main/context/autoCompressor.ts`：从直接修改消息 → 写入 compressionState 操作
- `src/main/agent/agentLoop.ts`：主循环调用链改为 `projectionEngine.projectMessages()` 生成最终消息数组

关键约束：
- Transcript 永不修改（append-only）
- CompressionState 可 reset（新 session / resume 时重建）
- 投影结果不缓存（每次查询重新投影，保证一致性）
- 旧的 `autoCompressor.compress()` 方法保留，内部改为写入 compressionState

### M1-S3：六层压缩管线

在投影架构上实现六层递进压缩，每层写入 compressionState 而非直接修改消息：

| 层 | 名称 | 触发条件 | 行为 | 新建/改造 |
|----|------|---------|------|-----------|
| L1 | tool-result budget | 每次工具返回 | 单个工具结果超 budget 时截断/摘要 | 新建 `toolResultBudget.ts` |
| L2 | snip | token 占比 ≥50% | 标记非关键消息为 snipped（保留 metadata，移除 content） | 新建 `snip.ts` |
| L3 | microcompact | token 占比 ≥60% | cache-aware 细粒度压缩，主线程走 cached 路径 | 新建 `microcompact.ts` |
| L4 | contextCollapse | token 占比 ≥75% | 选择消息 span → 用模型生成摘要 → 替换 span 为摘要节点 | 新建 `contextCollapse.ts` |
| L5 | autocompact | token 占比 ≥85% | 现有 ai_summary 策略保留 | 改造 `autoCompressor.ts` |
| L6 | overflow recovery | API 返回 overflow | 紧急 drain 所有 staged compressions + reactive compact | 新建 `overflowRecovery.ts` |

管线协调器：
- 新建 `src/main/context/compressionPipeline.ts`
  - `evaluateAndCompress(transcript, state, currentTokens, maxTokens): CompressionState`
  - 按层评估触发条件，触发后写入 state
  - 支持 feature gate 逐层开关（`ENABLE_SNIP`, `ENABLE_MICROCOMPACT`, `ENABLE_CONTEXT_COLLAPSE`）

L1 tool-result budget 规则：
- 默认 budget：单个工具结果 ≤ 2000 tokens
- 超 budget 时：代码类结果保留头尾 + 省略中间；文本类结果截断 + 追加 `[truncated]`
- 配置：`TOOL_RESULT_BUDGET` 常量，按工具类型可差异化

L2 snip 规则：
- 标记条件：消息距当前 ≥10 轮 + 非工具调用 + 非用户消息
- snip 后保留：role、timestamp、`[snipped: {original_tokens} tokens]` 占位
- 不 snip：最近 5 轮所有消息、包含代码块的 assistant 消息

L3 microcompact 规则：
- 两条路径：
  - `cached`：缓存热时，cache-safe 删除（只删不改动缓存前缀覆盖的部分）
  - `time-based`：缓存冷时（空闲 >5min），更激进的结果压缩
- 仅主线程执行（避免 fork 子 agent 状态污染）
- 依赖 M1-S5 的缓存边界定义；实现时 S5 可与 S3 并行开发，microcompact 的 `cached` 路径通过 `getCachePrefix()` 接口获取边界位置

L4 contextCollapse 规则：
- Span 选择：连续 ≥3 轮的工具调用+结果 → 候选 span
- 摘要生成：调用压缩专用模型（M4 配置，默认 DeepSeek/GLM Flash）
- 替换：span 替换为 `{role: 'system', content: '[collapsed: N turns] summary...'}`
- Drain policy：摘要完成后清除 span 的原始 commits

L5 autocompact：保留现有 `ai_summary` 策略，作为兜底层。

L6 overflow recovery：
- 触发：API 返回 `ContextLengthExceededError` 或 413
- 行为：依次 drain L2→L3→L4→L5 所有 staged compressions → reactive compact → 如仍不够 → 转交主循环 fallback 分支

### M1-S4：主循环多分支决策

**现状**：overflow → compress 一次 → 重试 → 失败。
**目标**：每轮迭代结束时显式决策。

决策树：

```
iteration_end:
  ├─ continue      (正常，token 预算充足)
  ├─ compact       (token 压力 ≥ 阈值，触发下一层压缩)
  ├─ continuation  (stop_reason=max_tokens → 追加"继续"指令)
  ├─ fallback      (当前模型不可用/overflow → 切换 fallback 模型)
  └─ terminate     (预算耗尽/连续失败 ≥3 → 优雅终止)
```

变更清单：
- `src/main/agent/agentLoop.ts`：每轮结束调用 `decideNextAction(loopState): LoopAction`
- 新建 `src/main/agent/loopDecision.ts`：
  - `LoopAction = 'continue' | 'compact' | 'continuation' | 'fallback' | 'terminate'`
  - `decideNextAction(state: LoopState): { action: LoopAction, reason: string, params?: any }`
  - 决策输入：`{stopReason, tokenUsage, errorType, consecutiveFailures, budgetRemaining}`
- Continuation 协议：检测 `stop_reason: max_tokens` → 追加 `{role: 'user', content: 'Continue from where you stopped. Do not restate or apologize.'}` → 重新调用
- Fallback 路由：从 `PROVIDER_FALLBACK_CHAIN` 选择，按失败原因过滤（overflow → 选窗口大的，rate_limit → 选同能力不同 provider）
- Fallback 接口预留：`loopDecision.ts` 的 fallback 分支通过 `FallbackStrategy` 接口调用，M1 阶段使用简单的 `PROVIDER_FALLBACK_CHAIN` 顺序策略，M4-S2 替换为 `adaptiveRouter.selectFallback()` 的智能策略
- 错误分类层：新建 `src/main/model/errorClassifier.ts`
  - `classifyError(error): ErrorClass`（`overflow | rate_limit | auth | unavailable | unknown`）
  - API adapter 规范化错误 → 主循环按类型决策

Terminate 条件：
- 连续同类错误 ≥3 次
- Token 预算耗尽（`budgetRemaining ≤ 0`）
- 用户中断
- 所有 fallback 模型均不可用

### M1-S5：缓存稳定性层

变更清单：
- `src/main/prompts/builder.ts`：引入 `SYSTEM_PROMPT_DYNAMIC_BOUNDARY`
  - 缓存前缀（稳定）：identity + tool definitions + constitution
  - 动态段（逐轮变化）：memory entries + rules + contextual reminders + system context
- `src/main/context/projectionEngine.ts`：投影时保持缓存前缀字节不变
  - 压缩操作只影响动态段和 user/assistant 消息
  - 不修改 system prompt 缓存前缀覆盖的部分
- 新增 `src/main/prompts/cacheBreakDetection.ts`：
  - `detectCacheBreak(prevPrompt, currPrompt): { broken: boolean, reason: string }`
  - 追踪：system prompt 变化、schema 变化、model 切换、cache_control 变化
  - 日志警告：cache break 时记录原因

### M1-S6：/context 可观察命令

变更清单：
- CLI：新增 `/context` 命令（`src/cli/commands/context.ts`）
- Web UI：新增 Context 面板（`src/renderer/components/ContextPanel.tsx`）
- 展示内容：
  - API 真实视图：经过 `projectionEngine.projectMessages()` 处理后的消息列表
  - Token 分布：system prompt / user messages / assistant / tool results 各占 token 数和百分比
  - 压缩状态：当前处于哪一层、各层触发次数、已压缩比例、剩余预算
  - Deferred tools：已注册但未在当前 prompt 中展开的工具列表
- IPC handler：`src/main/ipc/context.ipc.ts`

---

## M2：Prompt 矩阵 + 多 Agent 子运行时

**目标**：Prompt 从静态单例升级为多入口矩阵；子 Agent 从沙箱容器升级为完整子运行时。

### M2-S1：Prompt 多入口 Profile

**现状**：`buildPrompt()` 启动时构建一次，所有入口共用 `SYSTEM_PROMPT` 单例。
**目标**：四种入口各有独立装配路径。

Profile 定义：

| 入口 | Profile | 缓存策略 | 特征 |
|------|---------|---------|------|
| Interactive（REPL/Web） | `interactive` | 稳定前缀，逐轮动态段 | 完整 substrate + 全部 overlay |
| One-shot（CLI run/exec） | `oneshot` | 单次缓存 | 早期 flatten，合并 overlay 到 substrate |
| Subagent | `subagent` | 不匹配父 prompt 字节 | 专用 prompt + 精简 rules/memory |
| Fork child | `fork` | 复用父缓存 | 字节一致继承 forkContextMessages |

变更清单：
- `src/main/prompts/builder.ts`：
  - 删除 `SYSTEM_PROMPT` 单例
  - 新增 `buildPrompt(profile: PromptProfile, context: PromptContext): string`
  - `PromptProfile = 'interactive' | 'oneshot' | 'subagent' | 'fork'`
  - `PromptContext = { rules, memory, skills, agentFrontmatter, parentPrompt, forkMessages }`
- `src/main/agent/agentLoop.ts`：初始化时根据入口类型选择 profile
- `src/main/prompts/profiles/`：每种 profile 的 overlay 组合规则

### M2-S2：五层叠加系统

```
L1: Base Substrate    — identity + tool definitions + system reminders
L2: Mode Overlay      — coordinator / subagent / plan / research 角色切换
L3: Memory Overlay    — memory entries + rules (即使有 custom prompt 也保留)
L4: Append Overlay    — CLI --append / SDK / teammate 注入
L5: Context Projection — systemContext (追加) + userContext (前置 meta message)
```

变更清单：
- 新建 `src/main/prompts/overlayEngine.ts`：
  - `applyOverlays(substrate: string, overlays: OverlayConfig[]): string`
  - 每层独立可开关，profile 定义哪些层参与
- Profile → overlay 映射：
  - `interactive`：L1 + L2 + L3 + L4 + L5（全部）
  - `oneshot`：L1（flatten L2-L5 进 substrate）
  - `subagent`：L1 + L2 + slim-L3（跳过 L4）
  - `fork`：跳过装配，直接继承父 prompt
- L3 关键规则：当 `customSystemPrompt !== undefined` 时，仍保留 memory overlay（不跳过）

### M2-S3：子 Agent 完整上下文重建

**现状**：子 agent 拿到静态 `availableTools[]` + 独立 ModelRouter，无 hooks/skills/MCP 继承。
**目标**：`spawnSubagent()` 完整重建子运行时。

变更清单：
- 改造 `src/main/agent/subagentExecutor.ts`：
  - 新增 `buildChildContext(config, parentContext): AgentContext`
  - 子 agent 上下文包含：prompt（subagent profile）、toolPool（filtered）、permissions（derived）、hooks（inherited）、skills（resolved）、mcpConnections（inherited）、memory（slim）
- 权限继承规则：
  - 父 `bypassPermissions` → 子继承（不被子 mode 覆盖）
  - 父 `acceptEdits` → 子继承
  - 子可以收窄但不能放宽父权限
- Memory 精简：
  - 只读 agent → slim 版 rules + 最近 5 条 memory entries
  - 写入 agent → 完整 memory access
- MCP 继承：子 agent 继承父的 MCP connections，但不新建连接

### M2-S4：子 Agent 生命周期状态机

**现状**：超时控制 + 完成/失败二态。
**目标**：正式状态机 + 持久化。

状态机：

```
pending → registered → running → stopped ⟶ resumed → running
                         ↘ failed                      ↘ failed
                         ↘ cancelled
```

变更清单：
- 新建 `src/main/agent/agentTask.ts`：
  - `AgentTask` 类：`{id, status, agentType, abortController, pendingMessages, transcript, sidecarMetadata}`
  - `sidecarMetadata`：`{agentType, worktreePath, parentSessionId, spawnTime, model, toolPool}`
- 持久化：
  - Transcript：`{sessionDir}/agents/{agentId}/transcript.jsonl`
  - Sidecar：`{sessionDir}/agents/{agentId}/metadata.json`
- Resume：
  - `resumeAgent(taskId)` → 读 transcript + sidecar → 重建 AgentContext → 继续执行
  - `SendMessage` 到 stopped agent → 自动 resume
  - 原始 worktree 丢失 → fallback 到 parent cwd

### M2-S5：Mailbox 协调总线

**现状**：AgentBus pub-sub 存在但无实际协调用途。
**目标**：worker ↔ leader 正式协调协议。

Mailbox 消息类型：
- `permission_request`：子 agent 遇到需审批操作 → 路由到父 agent
- `permission_response`：父 agent 决策结果 → 回传子 agent
- `task_dispatch`：父 agent 分派新任务
- `status_report`：子 agent 定期上报进度

变更清单：
- 改造 `src/main/agent/agentBus.ts`：增加 mailbox 协议层
  - `sendMailbox(targetAgentId, message: MailboxMessage): void`
  - `pollMailbox(agentId): MailboxMessage[]`
- 新建 `src/main/agent/mailboxBridge.ts`：
  - `useMailboxBridge(agentId, mainLoop)` — 将 mailbox 消息注入主循环 submit 路径
  - 仅在 `!isLoading` 时 poll（防止过早注入）
- 后端支持：
  - In-process：Map<agentId, MailboxMessage[]>（默认）
  - File-based：`{sessionDir}/agents/{agentId}/mailbox.jsonl`（swarm 场景）

---

## M3：权限矩阵 + 事件分层 + 连续性协议

**目标**：权限从线性规则升级为多源竞争矩阵；事件从单总线升级为三通道；会话连续性增加生成代围栏。

### M3-S1：多源权限竞争模型

**现状**：50+ 硬编码规则按优先级顺序评估。
**目标**：多决策源竞争，first-valid-wins。

决策源：

```
Decision Sources (parallel evaluation):
  ├─ Rules Engine     — 快速 allow/deny/ask（现有 policyEngine）
  ├─ Mode State       — session 级语义（default/auto/plan/bypass）
  ├─ Hooks            — PreToolUse hook 可 allow/deny/ask
  ├─ Classifier       — 上下文风险评估（可选）
  └─ Policy           — 企业级管控（managed settings）

                  ↓ first-valid-wins
            
          Final Verdict: allow / deny / ask
```

变更清单：
- 新建 `src/main/permissions/guardFabric.ts`：
  - `evaluateGuard(tool, args, topology, sources): GuardVerdict`
  - 每个 source 返回 `{verdict: allow|deny|ask, confidence, source}` 或 `null`（不参与）
  - 竞争规则：deny > ask > allow（同级 first-wins）
  - `bypassPermissions` 下 safety 和 content-specific 规则仍有豁免权
- 改造 `src/main/permissions/policyEngine.ts`：作为 guardFabric 的一个 source
- 新建 `src/main/permissions/hookSource.ts`：PreToolUse hook 作为决策源
- 新建 `src/main/permissions/classifierSource.ts`：可选的上下文风险评估

### M3-S2：拓扑感知裁决

变更清单：
- `guardFabric.evaluateGuard()` 接收 `topology: 'main' | 'async_agent' | 'teammate' | 'coordinator'`
- 拓扑规则矩阵：

| 工具 | main | async_agent | teammate | coordinator |
|------|------|------------|----------|-------------|
| bash | ask | deny | ask | deny |
| write | ask | ask | ask | deny |
| read | allow | allow | allow | allow |
| web_search | allow | allow | allow | allow |
| spawn_agent | ask | deny | deny | allow |

- 失败语义：
  - Interactive topology（main/teammate）→ fail-open（降级到 ask）
  - Headless topology（async_agent）→ fail-closed（直接 deny）
- Classifier 超时/不可用时：按拓扑类型决定 fail-open 或 fail-closed

### M3-S3：事件三通道分离

**现状**：单一 EventBus（EventEmitter wrapper）。
**目标**：三个独立通道。

| 通道 | 用途 | 持久化 | 投递保证 |
|------|------|--------|---------|
| InternalEventStore | 工具执行、权限决策、状态变更 | 写入 events.jsonl | at-least-once（eventId 去重） |
| ControlStream | SSE/IPC 流式推送给前端 | 不持久化 | best-effort |
| Mailbox | Agent 间协调（M2-S5） | file-based 可选 | at-least-once |

变更清单：
- 拆分 `src/main/events/eventBus.ts` 为三个模块：
  - `src/main/events/internalEventStore.ts`：持久化事件存储
    - `writeEvent(event): void` → append to `events.jsonl`
    - `readEvents(filter): Event[]` → 支持按 domain/type/agentId 过滤
    - 每条事件带 `eventId`（UUID），去重
  - `src/main/events/controlStream.ts`：实时流推送
    - `pushToFrontend(event): void` → SSE/IPC
    - 无持久化，无去重
  - `src/main/events/mailbox.ts`：agent 协调（引用 M2-S5 实现）
- 子 agent 事件隔离：按 `agentId` 写入独立 stream 文件

### M3-S4：事件持久化 + Replay

变更清单：
- 事件存储路径：
  - 主 agent：`{sessionDir}/events.jsonl`
  - 子 agent：`{sessionDir}/agents/{agentId}/events.jsonl`
- 事件格式：`{eventId, agentId, domain, type, data, timestamp}`
- Session replay：
  - `src/main/events/eventReplay.ts`：从 events.jsonl 重建状态
  - 用于 debug 和评测（Swiss Cheese Evaluator 集成）
  - 支持时间范围过滤和 agent 过滤

### M3-S5：Worker Epoch 生成代围栏

变更清单：
- `src/main/services/infra/sessionManager.ts`：Session 增加 `workerEpoch: number` 字段
- 每次 resume/reconnect 递增 epoch
- 写操作（消息追加、状态更新、event 写入）携带 epoch 校验：
  - `writeWithEpoch(data, expectedEpoch)` → epoch 不匹配时抛出 `EpochMismatchError`
  - 旧 writer 收到 `EpochMismatchError` → 自动退出
- Checkpoint 逻辑写入当前 epoch → resume 时校验

### M3-S6：Rematerialization 协议

**现状**：resume 时 replay transcript。
**目标**：从状态快照投影到本地 AppState。

变更清单：
- 改造 `src/main/session/resume.ts`：
  - 读 checkpoint snapshot（消息、compressionState、agent tasks、settings）
  - 通过 `projectionEngine.projectMessages()` 重建 API 视图
  - 通过 `externalMetadataToAppState()` 投影远程状态到本地
  - 不再逐条 replay 消息历史
- `checkResumeConsistency()`：比较 snapshot.messageCount vs 实际 transcript 行数
- 一致性失败 → 回退到 transcript replay（兜底）
- 远程 sync 场景：保留远程原始时间戳（已有 `?? Date.now()` 机制）

---

## M4：多模型路由整合 + Operator Surface

**目标**：将 CA 的 12 provider 多模型优势嵌入核心路径，打造差异化能力；补齐运维可观察性。

### M4-S1：上下文压缩模型路由

将 M1 的六层压缩管线与多模型路由结合：

| 压缩层 | 选用模型 | 理由 | 成本 |
|--------|---------|------|------|
| L1-L3 | 无需模型 | 规则/标记/编辑操作 | ¥0 |
| L4 contextCollapse | GLM-4 Flash / DeepSeek | 便宜快速，摘要质量够用 | ~¥0.001/次 |
| L5 autocompact | Kimi K2.5 | 更强的摘要能力，兜底层要靠谱 | ~¥0.01/次 |
| L6 overflow recovery | 不换模型 | 紧急路径保持稳定 | - |

变更清单：
- 新建 `src/main/context/compressionModelRouter.ts`：
  - `selectCompressionModel(layer, taskType): { provider, model }`
  - 成本感知：压缩用最便宜的模型，核心推理不降级
  - 用户可配置：settings 中 `compressionModel` 覆盖默认
- 集成到 `compressionPipeline.ts` 的 L4/L5 层

### M4-S2：Fallback 嵌入主循环

M1-S4 的 fallback 分支与 adaptive router 深度整合：

```typescript
adaptiveRouter.selectFallback({
  reason: 'context_overflow' | 'rate_limit' | 'unavailable',
  currentModel,
  currentProvider,
  taskCapabilities: ['code', 'reasoning'],
  budgetRemaining,
}) → { provider, model, contextWindow }
```

变更清单：
- 改造 `src/main/model/adaptiveRouter.ts`：
  - 新增 `selectFallback(context: FallbackContext): FallbackResult`
  - 按失败原因选择策略：
    - `context_overflow` → 选窗口更大的模型（如 Kimi 128k）
    - `rate_limit` → 选同能力不同 provider
    - `unavailable` → 走 `PROVIDER_FALLBACK_CHAIN` 顺序
  - 预算感知：剩余预算不足时优先选便宜模型
- 集成到 M1-S4 的 `loopDecision.ts`

### M4-S3：子 Agent 按能力分配模型

M2 的子 agent 运行时 + 多模型路由结合：

| Agent 类型 | 推荐模型 | 理由 |
|-----------|---------|------|
| Code Explorer | Kimi K2.5 | 128k 窗口，代码理解强 |
| Code Reviewer | DeepSeek R1 | 推理链透明 |
| Web Search | Perplexity Sonar | 搜索原生集成 |
| Document Reader | GLM-4 Flash | 便宜、速度快 |
| Technical Writer | Kimi K2.5 | 中文写作质量高 |
| Debugger | Claude / DeepSeek R1 | 复杂推理场景 |

变更清单：
- 新建 `src/main/agent/agentModelPolicy.ts`：
  - `selectAgentModel(agentType, taskComplexity, budgetRemaining): { provider, model }`
  - 默认策略表（上表），用户可在 settings 中覆盖
  - 预算不足时自动降级到便宜模型
- 集成到 M2-S3 的 `buildChildContext()`

### M4-S4：Provider 请求规范化中间件

**现状**：每个 provider 自己处理消息格式。
**目标**：统一中间件层。

```
User Messages → normalizeMessages() → toolToAPISchema() → applyBetaFlags() → Provider.send()
```

变更清单：
- 新建 `src/main/model/middleware/requestNormalizer.ts`：
  - `normalizeMessages(messages, provider): NormalizedMessage[]` — 统一消息格式
  - `toolToAPISchema(tools, provider): ToolSchema[]` — 工具 schema 适配
  - `applyBetaFlags(request, model): Request` — beta flags 注入
  - `applyCacheTTL(request, cacheState): Request` — 缓存 TTL 标记
- 每个 provider 简化为 `send(normalizedRequest): Response`
- Prompt cache TTL 稳定性：锁定 cache eligibility 到 bootstrap 状态，mid-session 不翻转

### M4-S5：实时状态面板

变更清单：
- **TokenWarning 指示器**（`src/renderer/components/TokenWarning.tsx`）：
  - 正常 → token 用量百分比进度条
  - 压缩中 → 当前层名 + 进度百分比
  - overflow → 恢复状态 + fallback 模型名
  - 按当前压缩层切换显示逻辑
- **ContextVisualization 面板**（`src/renderer/components/ContextVisualization.tsx`）：
  - Token 分布柱状图：system / user / assistant / tools
  - 压缩时间线：各层触发时间点和效果
  - Deferred tools 列表
  - 子 agent 活跃状态卡片
- **StatusBar 集成**：
  - 现有 StatusBar 增加 token 压力指示
  - 点击展开 ContextVisualization 面板

### M4-S6：Doctor 诊断命令

变更清单：
- 新增 `/doctor` 命令（`src/cli/commands/doctor.ts` + `src/main/ipc/doctor.ipc.ts`）
- 诊断项：
  - **环境**：Node 版本、Rust 工具链、Python（ASR 依赖）
  - **网络**：代理连通性（7897 端口）、各 provider API 可达性
  - **配置**：API keys 有效性（调用 /models 接口验证）、MCP server 状态
  - **数据库**：SQLite integrity check、Supabase 连接状态
  - **磁盘**：session 目录大小、日志目录大小
- 输出：结构化诊断报告（pass/warn/fail per item）
- `/context` 命令集成（M1-S6 的 CLI + Web 双模式）

---

## 新增文件清单

```
M1:
  src/main/context/projectionEngine.ts      (投影引擎)
  src/main/context/compressionState.ts      (压缩状态)
  src/main/context/compressionPipeline.ts   (管线协调)
  src/main/context/toolResultBudget.ts      (L1)
  src/main/context/snip.ts                  (L2)
  src/main/context/microcompact.ts          (L3)
  src/main/context/contextCollapse.ts       (L4)
  src/main/context/overflowRecovery.ts      (L6)
  src/main/agent/loopDecision.ts            (主循环决策)
  src/main/model/errorClassifier.ts         (错误分类)
  src/main/prompts/cacheBreakDetection.ts   (缓存断裂检测)
  src/cli/commands/context.ts               (/context CLI)
  src/renderer/components/ContextPanel.tsx   (/context Web)
  src/main/ipc/context.ipc.ts               (IPC)

M2:
  src/main/prompts/overlayEngine.ts         (叠加引擎)
  src/main/prompts/profiles/                (Profile 定义)
  src/main/agent/agentTask.ts               (生命周期状态机)
  src/main/agent/mailboxBridge.ts           (Mailbox 桥接)

M3:
  src/main/permissions/guardFabric.ts       (多源竞争)
  src/main/permissions/hookSource.ts        (Hook 决策源)
  src/main/permissions/classifierSource.ts  (风险评估源)
  src/main/events/internalEventStore.ts     (持久化事件)
  src/main/events/controlStream.ts          (实时流)
  src/main/events/eventReplay.ts            (事件回放)

M4:
  src/main/context/compressionModelRouter.ts (压缩模型路由)
  src/main/agent/agentModelPolicy.ts         (子 agent 模型策略)
  src/main/model/middleware/requestNormalizer.ts (请求规范化)
  src/renderer/components/TokenWarning.tsx    (实时指示器)
  src/renderer/components/ContextVisualization.tsx (状态面板)
  src/cli/commands/doctor.ts                 (诊断命令)
  src/main/ipc/doctor.ipc.ts                (诊断 IPC)
```

## 改造文件清单

```
M1:
  src/main/context/tokenEstimator.ts        (替换算法)
  src/main/context/autoCompressor.ts        (改为写 compressionState)
  src/main/agent/agentLoop.ts               (多分支决策)
  src/main/prompts/builder.ts               (缓存边界)

M2:
  src/main/prompts/builder.ts               (多 profile)
  src/main/agent/subagentExecutor.ts        (完整上下文重建)
  src/main/agent/agentBus.ts                (mailbox 协议)

M3:
  src/main/permissions/policyEngine.ts      (作为 guardFabric source)
  src/main/events/eventBus.ts               (拆分三通道)
  src/main/services/infra/sessionManager.ts (workerEpoch)
  src/main/session/resume.ts                (rematerialization)

M4:
  src/main/model/adaptiveRouter.ts          (fallback 整合)
  src/main/agent/subagentExecutor.ts        (模型分配)
  src/renderer/components/StatusBar.tsx      (token 指示)
```

## 验证策略

每个 Step 完成后：
1. `npm run typecheck` 通过
2. 现有测试不 break（`npm run test`）
3. 新增核心逻辑需要单测覆盖
4. 每个 Step 独立 commit

每个 Milestone 完成后：
1. 手动端到端验证：起 `cargo tauri dev`，执行典型对话场景
2. 压力测试：长对话（>50 轮）验证上下文管理
3. 多 agent 测试：spawn 3+ 子 agent 验证协调
4. Fallback 测试：故意触发 overflow / rate limit 验证恢复链
