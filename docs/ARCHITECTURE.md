# Code Agent - 架构设计文档

> 版本: 7.0 (对应 v0.16.52)
> 日期: 2026-03-12
> 作者: Lin Chen

本文档已拆分为模块化的架构文档，便于维护和查阅。

---

## 文档导航

### 核心架构

| 文档 | 描述 |
|------|------|
| [系统概览](./architecture/overview.md) | 整体架构图、技术栈、分层设计 |
| [Agent 核心](./architecture/agent-core.md) | AgentLoop、消息流、规划系统、Nudge 机制、Checkpoint |
| [工具系统](./architecture/tool-system.md) | ToolRegistry、ToolExecutor、8 代工具演进 |
| [前端架构](./architecture/frontend.md) | React 组件、Zustand 状态、useAgent Hook |
| [数据存储](./architecture/data-storage.md) | SQLite、Supabase、pgvector、SecureStorage |
| [云端架构](./architecture/cloud-architecture.md) | Orchestrator、云端任务、多代理调度、断点续传 |

### v0.16+ 新增模块

| 模块 | 位置 | 描述 |
|------|------|------|
| **DAG 调度器** | `src/main/scheduler/` | 基于 DAG 的并行任务调度 |
| **DI 容器** | `src/main/core/container.ts` | 依赖注入容器 |
| **生命周期管理** | `src/main/core/lifecycle.ts` | 服务生命周期管理 |
| **DAG 可视化** | `src/renderer/components/features/workflow/` | React Flow DAG 展示 |
| **内置 Agent** | `src/shared/types/builtInAgents.ts` | 6+11 个预定义 Agent 角色 |
| **Checkpoint 系统** | `src/main/services/FileCheckpointService.ts` | 文件版本快照与回滚 |
| **ToolSearch** | `src/main/tools/gen4/toolSearch.ts` | 延迟加载工具发现机制 |
| **CLI 接口** | `src/main/cli/` | 命令行交互模式 |
| **多渠道接入** | `src/main/channels/` | 飞书 Webhook 等渠道支持 |
| **Skills 系统** | `src/main/skills/` | 用户可定义技能 |

### v0.16.52+ 轻量记忆系统（Light Memory, 2026-03-15）

| 模块 | 位置 | 描述 |
|------|------|------|
| **Index Loader** | `src/main/lightMemory/indexLoader.ts` | 加载 `~/.code-agent/memory/INDEX.md` 到 system prompt |
| **MemoryWrite 工具** | `src/main/lightMemory/memoryWriteTool.ts` | 写入/删除记忆文件 + 自动维护索引 |
| **MemoryRead 工具** | `src/main/lightMemory/memoryReadTool.ts` | 按需读取记忆详情 |
| **Session Metadata** | `src/main/lightMemory/sessionMetadata.ts` | 追踪使用频率/模型分布（借鉴 ChatGPT） |
| **Recent Conversations** | `src/main/lightMemory/recentConversations.ts` | ~15 条近期对话摘要（借鉴 ChatGPT） |
| **前端面板** | `src/renderer/.../settings/tabs/MemoryTab.tsx` | Light Memory 文件浏览器（替代旧 10+ 组件） |
| **IPC 服务** | `src/main/lightMemory/lightMemoryIpc.ts` | 列出/读取/删除记忆文件 + 综合统计 |

**6 层上下文注入架构**（对标 ChatGPT 逆向工程发现的 6 层结构）:
```
[0] System Instructions    — identity.ts（行为规则 + memory_system prompt）
[1] Session Metadata       — 使用频率/活跃天数/模型分布
[2] Memory Index           — INDEX.md 常驻注入（File-as-Memory 核心）
[3] Recent Conversations   — ~15 条近期对话摘要（只摘用户意图）
[4] RAG Context            — buildEnhancedSystemPrompt（旧系统，待废弃）
[5] Current Session        — 滑动窗口
```

**设计原则**: 模型本身就是最好的记忆引擎。~700 行代码（含前端+IPC）+ prompt 替代旧 13K+ 行 vector/embedding 系统。

### v0.16.52+ 桌面活动视觉分析（2026-03-15）

| 模块 | 位置 | 描述 |
|------|------|------|
| **视觉分析器** | `src/main/services/desktopVisionAnalyzer.ts` | 后台轮询截图，调用智谱 GLM-4V-Plus 生成语义描述 |
| **Rust 采集增强** | `src-tauri/src/native_desktop.rs` | 截图 PNG→JPG（~80% 空间节省）、`analyze_text` 字段、SQLite 自动迁移 |
| **Tauri 命令** | `desktop_update_analyze_text` | Node 侧写回视觉分析结果到 Rust 管理的 SQLite |

**对标 StepFun（阶跃AI）全局记忆**：每次截图后由视觉模型生成"用户正在做什么"的自然语言描述（`analyzeText`），类似 StepFun 的 `analyze_text` 字段。UI 详情面板优先展示 AI 分析文本，搜索范围纳入分析结果。

### v0.16.53+ 富文档结构化编辑（2026-03-19）

| 模块 | 位置 | 描述 |
|------|------|------|
| **Excel 原子编辑** | `src/main/tools/excel/excelEdit.ts` | 14 种操作（set_cell/range/formula, insert/delete rows/columns, style, sheet 管理） |
| **Word 原子编辑** | `src/main/tools/document/docxEdit.ts` | 7 种操作（replace_text, replace/insert/delete/append paragraph, heading, text style） |
| **SnapshotManager** | `src/main/tools/document/snapshotManager.ts` | 统一文档快照层（创建/恢复/清理，最多 20 个/文件） |
| **DocEdit 统一入口** | `src/main/tools/document/docEditTool.ts` | 自动识别格式（.xlsx/.pptx/.docx）路由到对应引擎 |
| **PPT 编辑加固** | `src/main/tools/network/ppt/editTool.ts` | +2 新操作（reorder_slides, update_notes），接入 SnapshotManager |

**设计原则**：原子操作替代全量重写，~80% token 节省。编辑前自动快照到 `.doc-snapshots/`，失败自动回滚。

**对标悟空 RealDoc**：按行号/关键词/范围定位 → 原子修改 → 自动版本快照。Excel 用 ExcelJS cell 级操作，PPT/Word 用 JSZip 操作 Office Open XML。

### v0.16.53+ Generative UI（2026-03-17）

| 模块 | 位置 | 描述 |
|------|------|------|
| **ChartBlock** | `src/renderer/.../MessageBubble/ChartBlock.tsx` | Recharts 6 种图表渲染（bar/line/area/pie/radar/scatter），暗色主题 |
| **GenerativeUIBlock** | `src/renderer/.../MessageBubble/GenerativeUIBlock.tsx` | 沙箱 iframe HTML 小程序渲染（sandbox="allow-scripts"） |
| **Generative UI Prompt** | `src/main/prompts/generativeUI.ts` | System Prompt 注入，教 AI 何时使用 chart vs generative_ui |
| **Artifact 类型** | `src/shared/types/message.ts` | 版本化可视化产物追踪（chart/generative_ui） |

**渲染路由**：MessageContent 的 markdown code block handler 检测 `chart` / `generative_ui` 语言标签，路由到对应 React 组件（与已有 `mermaid` 路由同一模式）。

### v0.16.52+ 架构清理与评测修复（2026-03-09 ~ 03-12）

| 改动 | 描述 |
|------|------|
| **AgentApplicationService** | IPC facade 解耦（`agentAppService.ts`），所有 IPC handler 不再直接依赖具体实现 |
| **agentLoop 拆分** | 4350 行单文件拆为 5 个 runtime 模块（`conversationRuntime.ts` 等），agentLoop 变为 thin wrapper |
| **循环依赖清零** | 114→15→9→0（madge 验证），sessionStore 拆分、IPC facade、bootstrap 4 模块拆分 |
| **死代码清理** | -13,654 行 agent 子系统 + -2,497 行 memory 模块，净减 ~16K 行 |
| **Disposable 扩展** | 11 个资源持有服务实现 Disposable 接口，gracefulShutdown 统一释放 |
| **Session 边界加固** | per-session IPC facade + Bridge session-aware + getter 副作用移除 |
| **评测生产隔离** | evaluation 模块 dynamic import + `EVAL_DISABLED` define，生产包不含评测代码 |
| **EvalSnapshot** | `snapshotBuilder.ts` + `telemetryQueryService.ts`，会话评测数据快照与版本化 |
| **TraceView** | SessionReplayView 重构为通用 TraceView，支持实验和会话两种入口 |
| **Turn-based trace** | ChatView 从平铺列表改为分组卡片（`TurnBasedTraceView.tsx` + `useTurnProjection.ts`） |
| **评测四项修复** | subset 过滤、trialsPerCase 多试次、3 页面数据源迁移到 DB、session_id 关联 |
| **Web session 修复** | webServer.ts 覆盖 `domain:session` handler，绕过 null AppService |
| **Codex 审计修复** | heartbeatService 重写、cronService 竞态、channelAgentBridge 改造等 14 项 |
| **工具描述对齐 CC** | 移除 Bash 5 层硬编码检测，改为纯工具描述引导 |
| **Opus maxTokens** | thinking budget 与 maxTokens 冲突自动调大 |
| **esbuild 统一** | 6 个独立 esbuild 命令合并为单一 `esbuild.config.ts` |

### v0.16.37+ 多 Agent 协作增强（持久化团队 + 优雅关闭 + 任务自管理 + 审批流）

| 模块 | 位置 | 描述 |
|------|------|------|
| **E3 持久化团队** | `src/main/agent/teammate/teamPersistence.ts` | 团队/任务状态写入磁盘（config/tasks/findings/checkpoint），支持 session 中断后恢复 |
| **E3 团队管理器** | `src/main/agent/teammate/teamManager.ts` | 团队生命周期管理（create/resume/snapshot/shutdown），进程退出前自动保存 |
| **E4 子 Agent 任务自管理** | `src/main/agent/hybrid/coreAgents.ts` | 4 核心角色可自行查看/认领/完成/创建任务，减少 Coordinator 瓶颈 |
| **E1 优雅关闭协议** | `src/main/agent/shutdownProtocol.ts` | 4 阶段关闭（Signal→Grace→Flush→Force），替代暴力中断 |
| **E1 信号合并** | `src/main/agent/subagentExecutor.ts` | per-execution AbortController + combineAbortSignals，统一超时与外部取消 |
| **E2 跨 Agent 审批** | `src/main/agent/planApproval.ts` | 高风险操作提交 plan → Coordinator 审批 → 通过后执行（可选，默认关闭） |
| **E2 审批工具** | `src/main/tools/multiagent/planReview.ts` | `plan_review` 工具：Coordinator 批准/拒绝子 Agent 的 plan |

### v0.16.37+ 工程能力提升（动态 maxTokens + 源数据锚定 + 数据清洗）

| 模块 | 位置 | 描述 |
|------|------|------|
| **截断自动恢复** | `src/main/agent/agentLoop.ts` | 文本截断翻倍 maxTokens 重试，工具截断注入续写提示 |
| **复杂任务 maxTokens** | `src/main/model/adaptiveRouter.ts` | 复杂任务主动提升 maxTokens 到 8192 |
| **DataFingerprintStore** | `src/main/tools/dataFingerprint.ts` | 源数据锚定：xlsx schema + bash 统计 + CSV/JSON schema |
| **Compaction 事实注入** | `src/main/context/autoCompressor.ts` | 压缩时自动注入已验证的源数据和计算结果 |
| **数据清洗 Skill** | `src/main/services/skills/builtinSkills.ts` | 6 步系统性清洗检查清单，关键词自动匹配 |

### v0.16.22+ 成本优化与健壮性增强（Electron 38 + 7 项改进）

| 模块 | 位置 | 描述 |
|------|------|------|
| **Electron 38 升级** | `package.json` | Chromium 140, V8 14.0, Node 22.16（最高兼容版本，39+ isolated-vm 不兼容） |
| **推理缓存** | `src/main/model/inferenceCache.ts` | LRU 缓存（50 条，5min TTL），md5 key，只缓存 text 响应 |
| **自适应路由** | `src/main/model/adaptiveRouter.ts` | 简单任务 → zhipu/glm-4.7-flash（免费），失败自动 fallback |
| **错误恢复引擎** | `src/main/errors/recoveryEngine.ts` | 6 种错误模式自动恢复（429/401/context_length/timeout/connection/unavailable） |
| **工具 DAG 调度** | `src/main/agent/toolExecution/dagScheduler.ts` | 文件依赖 DAG + Kahn 拓扑排序，WAR/WAW 检测 |
| **实时成本流** | `src/renderer/stores/statusStore.ts` | SSE 流式 token 估算 + StatusBar 脉冲动画 |
| **Prompt 精简** | `src/main/prompts/base/gen8.ts` | tool table 再压缩 ~20% |
| **激进裁剪** | `src/main/context/autoCompressor.ts` | 更早触发压缩（0.6），旧消息 200 字符摘要 |
| **错误恢复 IPC** | `src/main/ipc/error.ipc.ts` | 错误恢复事件推送到渲染进程 |
| **错误恢复 Hook** | `src/renderer/hooks/useErrorRecovery.ts` | React Hook + 自动 dismiss |

### v0.16.21+ 健壮性增强（h2A 转向 + Compaction 恢复 + 溢出自动重试）

| 模块 | 位置 | 描述 |
|------|------|------|
| **h2A 实时转向** | `src/main/agent/agentLoop.ts` | `steer()` 方法注入用户消息，不销毁 loop，保留所有中间状态 |
| **消息排队** | `src/main/agent/agentOrchestrator.ts` | 快速连续输入不互相覆盖，重写 interruptAndContinue() |
| **TaskListManager** | `src/main/agent/taskList/` | 可视化任务列表管理 + IPC handlers |
| **Compaction 恢复** | `src/main/agent/agentLoop.ts` | 压缩后注入最近读取文件和待处理 TODO |
| **FileReadTracker** | `src/main/tools/fileReadTracker.ts` | 跟踪文件读取记录，支持编辑验证和恢复上下文 |
| **Edit 代码片段** | `src/main/tools/file/edit.ts` | 编辑成功后返回 4 行上下文代码 |
| **溢出自动恢复** | `src/main/agent/agentLoop.ts` | ContextLengthExceededError → 自动压缩 + 0.7x maxTokens 重试 |
| **动态 Bash 描述** | `src/main/tools/shell/dynamicDescription.ts` | GLM-4-Flash 生成命令描述，LRU 缓存 |
| **Moonshot 连接修复** | `src/main/model/providers/moonshot.ts` | 专用 Agent（keepAlive=false）+ 瞬态错误重试 |

### 分层压缩增强（v0.16.42+）

上下文压缩从单一策略改为三层递进：
- **L1 Observation Masking**（≥60%）：用占位符替换旧 tool result，保留 tool call 骨架（借鉴 JetBrains Junie）
- **L2 Truncate/CodeExtract**（≥85%）：裁剪中段消息
- **L3 AI Summary**（≥90%）：Handoff Prompt 生成摘要（借鉴 Codex CLI）

关键文件：`tokenOptimizer.ts`（observationMask）、`autoCompressor.ts`（分层集成）、`constants.ts`（OBSERVATION_MASKING）

### v0.16.20+ 对标 Claude Code 2026（Compaction + Agent Teams + Adaptive Thinking）

| 模块 | 位置 | 描述 |
|------|------|------|
| **增强型 Compaction** | `src/main/context/autoCompressor.ts` | `CompactionBlock` 可审计摘要、`triggerTokens` 绝对阈值、`pauseAfterCompaction` 暂停注入、`shouldWrapUp()` 预算收尾 |
| **Agent Teams** | `src/main/agent/teammate/teammateService.ts` | P2P 通信集成到 Swarm、`subscribeToAgent()`/`onUserMessage()`/`getConversation()` |
| **Delegate 模式** | `src/main/agent/agentOrchestrator.ts` | Orchestrator 只分配不执行、Plan 审批流程（review→approved/rejected） |
| **AgentTeamPanel** | `src/renderer/components/features/agentTeam/` | Agent 列表 + 消息流 + 用户输入 + 任务分配概览 |
| **Swarm IPC** | `src/main/ipc/swarm.ipc.ts` | 3 个新 IPC 通道：send-user-message / get-agent-messages / set-delegate-mode |
| **Adaptive Thinking** | `src/main/agent/agentLoop.ts` | `InterleavedThinkingManager`（shouldThink + generateThinkingPrompt）、effort 级别控制 |
| **Effort 映射** | `src/main/agent/agentOrchestrator.ts` | `taskComplexityAnalyzer` → effort 自动映射（simple→low, moderate→medium, complex→high） |
| **DeepSeek Thinking** | `src/main/model/providers/deepseek.ts` | `reasoning_content` → thinking block 映射 |
| **Thinking UI** | `src/renderer/components/features/chat/MessageBubble/AssistantMessage.tsx` | 可折叠思考卡片 + effort 级别徽章（Zap 图标） |

### v0.16.19+ 新增模块（E1-E6 工程能力 + PPT 重构 + Agent 协作）

| 模块 | 位置 | 描述 |
|------|------|------|
| **E1 引用溯源** | `src/main/services/citation/` | 自动从工具结果提取引用（文件行号/URL/单元格），可点击跳转 |
| **E2 确认门控** | `src/main/agent/confirmationGate.ts` | 写操作前展示 diff 预览 + 确认对话框，策略可配置 |
| **E3 变更追踪** | `src/main/services/diff/diffTracker.ts` | 每次文件修改产生结构化 unified diff，会话级持久化 |
| **E4 模型热切换** | `src/main/session/modelSessionState.ts` | 对话中途切换模型，下一轮生效，不中断当前轮 |
| **E5 文档上下文** | `src/main/context/documentContext/` | 统一文档理解层，5 种解析器，importance-aware 压缩 |
| **E6 安全校验** | `src/main/security/inputSanitizer.ts` | 外部数据 prompt injection 检测，20+ 正则模式 |
| **PPT 模块化** | `src/main/tools/network/ppt/` | 9 模块声明式架构，原生图表，9 主题，137 测试 |
| **Agent 协作** | `src/main/agent/teammate/` | TeammateService 通信 + SwarmMonitor 监控 |
| **Diff 面板** | `src/renderer/components/DiffPanel/` | 会话级变更追踪 UI |
| **引用列表** | `src/renderer/components/citations/` | 可点击引用标签（文件/URL/单元格/查询/记忆） |
| **模型切换器** | `src/renderer/components/StatusBar/ModelSwitcher.tsx` | 状态栏模型切换下拉框 |
| **Agent 团队面板** | `src/renderer/components/features/agentTeam/` | Agent 团队协作视图 |

### v0.16.18+ 新增模块

| 模块 | 位置 | 描述 |
|------|------|------|
| **混合 Agent 架构** | `src/main/agent/hybrid/` | 3 层混合架构：核心角色 + 动态扩展 + Swarm |
| **统一 Identity** | `src/main/prompts/identity.ts` | 替代 constitution/ 的 6 文件，token -81% |
| **上下文压缩** | `src/main/context/autoCompressor.ts` | 自动上下文压缩 |
| **评测双管道** | `src/main/evaluation/` | Pipeline A: EvaluationService（会话评测）, Pipeline B: TestRunner（用例执行）, Bridge: ExperimentAdapter |
| **Session Replay** | `src/main/evaluation/replayService.ts` | 评测中心第三模式：结构化会话回放（三表 JOIN + 工具分类 + 自修复链检测） |
| **SwissCheese 评估器** | `src/main/evaluation/swissCheeseEvaluator.ts` | 多维评分 + 权重归一化 + 分数尺度统一（0-1 内部 → 0-100 展示） |
| **评分配置** | `ScoringConfigPage.tsx` | 用户可自定义评分维度权重，前后端维度名对齐 |
| **失败漏斗** | `ExperimentDetailPage.tsx` | 5 阶段失败分析（Setup → Tool → Logic → Output → Timeout） |
| **实验管理** | DB: `experiments`, `experiment_cases` | 实验元数据 + 用例结果持久化 |
| **Logger 文件落盘** | `src/main/services/infra/logger.ts` | NDJSON 格式 + 按日轮转 + async stream |

### v0.16.16+ 新增模块

| 模块 | 位置 | 描述 |
|------|------|------|
| **统一配置目录** | `src/main/config/configPaths.ts` | `.code-agent/` 配置目录结构 |
| **基础设施服务** | `src/main/services/infra/` | 磁盘监控、文件日志、优雅关闭 |
| **错误学习系统** | `src/main/memory/errorLearning.ts` | 错误模式学习与避免 |
| **记忆衰减** | `src/main/memory/memoryDecay.ts` | 基于时间的记忆权重衰减 |
| **动态提醒** | `src/main/prompts/dynamicReminders.ts` | 上下文感知的动态提示 |
| **Few-shot 示例** | `src/main/prompts/fewShotExamples.ts` | 任务类型示例管理 |
| **执行监控** | `src/main/planning/executionMonitor.ts` | 计划执行进度监控 |
| **可行性检查** | `src/main/planning/feasibilityChecker.ts` | 任务可行性评估 |
| **恢复策略** | `src/main/agent/recovery/` | 任务分解、降级、学习策略 |
| **原子写入** | `src/main/tools/utils/atomicWrite.ts` | 文件写入原子性保证 |
| **Moonshot Provider** | `src/main/model/providers/moonshot.ts` | Kimi K2.5 SSE 流式支持 |

### 架构决策记录 (ADR)

| ADR | 标题 | 状态 |
|-----|------|------|
| [001](./decisions/001-turn-based-messaging.md) | Turn-Based 消息流架构 | accepted |
| [002](./decisions/002-eight-generation-tool-evolution.md) | 8 代工具演进策略 | accepted |
| [003](./decisions/003-cloud-local-hybrid-architecture.md) | 云端-本地混合执行架构 | accepted |
| [004](./decisions/004-unified-plugin-config-structure.md) | 统一插件配置目录结构 | proposed |
| [005](./decisions/005-eval-engineering.md) | Eval Engineering Key Decisions | accepted |
| [006](./decisions/006-deferred-tools-consolidation.md) | Deferred Tools 合并精简 (Phase 2) | accepted |

---

## 快速参考

### 技术栈

| 层级 | 技术选型 |
|------|----------|
| 桌面框架 | Tauri 2.x (Rust) — 替代 Electron |
| 前端框架 | React 18 + TypeScript 5.6 |
| 状态管理 | Zustand 5 |
| 样式 | Tailwind CSS 3.4 |
| 本地存储 | SQLite (better-sqlite3) |
| 云端存储 | Supabase + pgvector |
| AI 模型 | Moonshot Kimi K2.5 (主要), 智谱/DeepSeek (备用) |
| 本地桥接 | packages/bridge (localhost:9527) |

### 8 代工具演进

| 代际 | 核心能力 | 工具集 |
|------|----------|--------|
| Gen1 | 基础文件操作 | bash, read_file, write_file, edit_file |
| Gen2 | 代码搜索 | + glob, grep, list_directory, mcp |
| Gen3 | 任务规划 | + task, todo_write, ask_user_question |
| Gen4 | 网络能力 | + skill, web_fetch, **web_search** |
| Gen5 | 记忆系统 | + memory_store, memory_search |
| Gen6 | 视觉交互 | + screenshot, computer_use |
| Gen7 | 多代理 | + spawn_agent, agent_message |
| Gen8 | 自我进化 | + strategy_optimize, tool_create |

> **Phase 2 工具合并**: 31 个延迟加载工具合并为 9 个统一工具（Process, MCPUnified, TaskManager, Plan, PlanMode, WebFetch, ReadDocument, Browser, Computer），使用 action 参数分发。旧名通过 TOOL_ALIASES 保持兼容。详见 [ADR-006](./decisions/006-deferred-tools-consolidation.md)。
>
> **Phase 3 文档编辑统一**: DocEdit 统一入口 + ExcelAutomate(edit) + ppt_edit 加固。富文档从全量生成升级为原子级增量编辑（Excel 14 操作 / PPT 8 操作 / Word 7 操作），SnapshotManager 提供快照回滚。

### 目录结构

```
code-agent/
├── docs/
│   ├── ARCHITECTURE.md          # 本文档（索引）
│   ├── PRD.md                   # 产品需求文档
│   ├── architecture/            # 详细架构文档
│   │   ├── overview.md          # 系统概览
│   │   ├── agent-core.md        # Agent 核心
│   │   ├── tool-system.md       # 工具系统
│   │   ├── frontend.md          # 前端架构
│   │   ├── data-storage.md      # 数据存储
│   │   └── cloud-architecture.md # 云端架构
│   └── decisions/               # 架构决策记录
│       ├── template.md          # ADR 模板
│       └── 001-turn-based-messaging.md
│
├── src/
│   ├── main/                    # 后端主进程 (Tauri/Node.js)
│   │   ├── agent/              # AgentOrchestrator, AgentLoop
│   │   ├── prompts/           # Prompt system
│   │   ├── model/              # ModelRouter
│   │   ├── tools/              # gen1-gen4 工具实现
│   │   ├── services/           # Auth, Sync, Database, SecureStorage
│   │   ├── memory/             # 向量存储和记忆系统
│   │   ├── planning/           # 规划系统
│   │   └── orchestrator/       # 统一调度器 (v0.6.1+)
│   │
│   ├── renderer/               # React 前端
│   │   ├── components/         # UI 组件
│   │   ├── stores/             # Zustand 状态
│   │   └── hooks/              # 自定义 hooks
│   │
│   ├── shared/                 # 类型定义和 IPC
│   └── preload/                # Preload 脚本
│
├── vercel-api/                 # 云端 API (Vercel)
├── packages/bridge/              # Local Bridge 服务 (localhost:9527)

└── supabase/                   # 数据库迁移
```

---

## 如何使用本文档

1. **新人入门**: 先阅读 [系统概览](./architecture/overview.md)
2. **开发功能**: 查阅对应模块的详细文档
3. **理解决策**: 查看 [ADR](./decisions/) 了解架构决策背景
4. **贡献代码**: 遵循各文档中的设计原则

## 文档维护指南

- **新增功能**: 更新对应模块文档
- **架构决策**: 新建 ADR 文档
- **重大变更**: 更新索引和版本号

---

## 更多文档

- [Release Notes](./releases/) — 版本发布记录
- [ADR-005: Eval Engineering Key Decisions](./decisions/005-eval-engineering.md) — Excel Agent Benchmark 优化的关键工程决策

---

## 平台架构（v0.16.44+ 三端产品）

项目已从 Electron 迁移到 Tauri 2.x，并扩展为三端产品：

```
┌─ Web 端（浏览器）─────────────────────────────┐
│  React 18 + Vite                              │
│  ├── 云端功能 → webServer API                  │
│  └── 本地功能 → Bridge (localhost:9527)         │
└───────────────────────────────────────────────┘
┌─ App 端（Tauri 2.x）─────────────────────────┐
│  Rust Shell → spawn Node.js webServer         │
│  ├── tauri-plugin-updater 原生自动更新          │
│  ├── Tauri 2.x capabilities 权限模型           │
│  └── 完整本地能力（文件/Shell/进程）             │
└───────────────────────────────────────────────┘
┌─ CLI 端 ─────────────────────────────────────┐
│  Node.js 单文件 (esbuild)                     │
│  ├── 适合极客和 Agent 调用                      │
│  └── npm install -g code-agent-cli             │
└───────────────────────────────────────────────┘
```

### 关键技术决策

- **Tauri 2.x 替代 Electron**：DMG 从 742MB → 33MB（95% 缩减）
- **Rust shell 启动 Node.js webServer 子进程**，health check 检测开发模式
- **CSP 安全策略 + capabilities 权限模型**

### 三端产品定位

| 端 | 定位 | 用户画像 |
|----|------|----------|
| Web | 尝鲜体验 | 无需安装，浏览器即用 |
| App (Tauri) | 完整体验 | 主力用户，完整本地能力 |
| CLI | 极客/Agent 调用 | 开发者、自动化场景 |

---

## Local Bridge 服务

为 Web 端提供本地能力的桥接服务，通过 HTTP + WebSocket 在 localhost:9527 运行。

### 目录结构

```
packages/bridge/
├── src/
│   ├── server.ts         — HTTP + WebSocket 服务 (:9527)
│   ├── security/         — 三级权限 + 沙箱 + 命令过滤
│   └── tools/            — 12 个工具实现
└── scripts/              — 平台安装/卸载脚本
```

### 工具清单（三级权限）

| 级别 | 权限 | 工具 |
|------|------|------|
| L1 只读 | 自动执行 | file_read, file_glob, file_grep, directory_list, clipboard_read, system_info |
| L2 写入 | 需确认 | file_write, file_edit, file_download, open_file |
| L3 执行 | 白名单+确认 | shell_exec, process_manage |

### 安全机制

- **工作目录沙箱**：path.resolve 后检查是否在允许目录内
- **命令黑名单**：rm -rf /, sudo, curl|bash 等
- **Auth Token**：启动时生成，存储于 ~/.code-agent-bridge/token
- **CORS**：仅允许 localhost

### Web 端工具调用数据流

```
agentLoop.executeTool(Read)
  → webServer 识别为本地工具 (isLocalTool)
  → SSE 推送 tool_call_local 事件
  → 前端 httpTransport 拦截
  → LocalBridgeClient.invokeTool("file_read", params)
  → Bridge localhost:9527 执行
  → POST /api/tool-result 回传
  → agentLoop 继续对话
```

### 关键文件

| 文件 | 描述 |
|------|------|
| `packages/bridge/*` | Bridge 服务完整实现 |
| `src/main/tools/localBridge.ts` | 本地工具识别 |
| `src/renderer/stores/localBridgeStore.ts` | 前端 Bridge 状态管理 |
| `src/renderer/services/localTools.ts` | 前端工具调用适配 |
| `src/main/webServer.ts` | SSE tool_call_local 事件推送 |
| `src/renderer/services/httpTransport.ts` | 前端 SSE 拦截层 |
| `src/renderer/components/features/chat/ChatView.tsx` | 对话拦截集成 |
| `src/renderer/components/features/settings/MCPSettings.tsx` | MCP 设置页 Bridge 手风琴 |
