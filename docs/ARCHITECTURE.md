# Code Agent - 架构设计文档

> 版本: 9.8 (对应 v0.16.74)
> 日期: 2026-05-11
> 作者: Lin Chen

本文档是 Code Agent 项目的**架构索引入口**。详细设计已拆分为模块化文档，本文提供导航、快速参考和版本演进概要。

---

## 文档导航

### 核心架构

| 文档 | 描述 |
|------|------|
| [系统概览](./architecture/overview.md) | 整体架构图、技术栈、分层设计 |
| [Agent 核心](./architecture/agent-core.md) | AgentLoop、运行时状态机、run-level abort、TaskManager-owned chat send、ContextAssembly |
| [工具系统](./architecture/tool-system.md) | ToolRegistry、ToolExecutor、Core/Deferred、MCP dynamic tools、权限合同 |
| [前端架构](./architecture/frontend.md) | React 组件、Zustand 状态、useAgent Hook |
| [数据存储](./architecture/data-storage.md) | SQLite、Supabase、session runtime state、telemetry/replay、SecureStorage |
| [云端/同步历史架构](./architecture/cloud-architecture.md) | 历史 cloud task / orchestrator 设计归档；当前保留配置、更新、feature flag、cloud proxy 等服务 |
| [多 Agent 编排](./architecture/multiagent-system.md) | Agent Team 并行执行、parallel inbox、dependsOn gate、run-level cancel、SpawnGuard |
| [Chat-Native Workbench](./architecture/workbench.md) | 聊天主链路能力工作台（ConversationEnvelope + InlineWorkbenchBar + Turn Timeline + Prompt Rewind），与 TaskPanel(sidecar) 分工 |
| [Artifact Verification](./architecture/artifact-verification.md) | AcceptanceRunner、Game/Deck/Dashboard verifier、Delivery Review、Preview Feedback |
| [Activity Providers](./architecture/activity-providers.md) | OpenChronicle / Tauri Native Desktop / audio / screenshot-analysis 统一上下文 provider 边界 |
| [CLI 架构](./architecture/cli.md) | 5 种运行模式、CLIAgent 适配层、输出格式化、命令系统 |

### 架构决策记录 (ADR)

| ADR | 标题 | 状态 |
|-----|------|------|
| [001](./decisions/001-turn-based-messaging.md) | Turn-Based 消息流架构 | accepted |
| [002](./decisions/002-eight-generation-tool-evolution.md) | ~~8 代工具演进策略~~ | superseded |
| [003](./decisions/003-cloud-local-hybrid-architecture.md) | 云端-本地混合执行架构 | accepted |
| [004](./decisions/004-unified-plugin-config-structure.md) | 统一插件配置目录结构 | proposed |
| [005](./decisions/005-eval-engineering.md) | Eval Engineering Key Decisions | accepted |
| [006](./decisions/006-deferred-tools-consolidation.md) | Deferred Tools 合并精简 (Phase 2) | accepted |
| [007](./decisions/007-protocol-migration-reality-check.md) | Protocol 迁移现实性复盘 | accepted |
| [008](./decisions/008-swarm-actor-refactor.md) | Swarm Actor 重构 | accepted |
| [009](./decisions/009-dual-coordinator-split.md) | 双 Coordinator 拆分 | accepted |
| [010](./decisions/010-swarm-road-to-10.md) | Swarm Road to 10 | closed |
| [011](./decisions/011-chat-native-workbench.md) | Chat-Native Workbench 架构 | accepted |
| [012](./decisions/012-live-preview-v2-c-deferred.md) | Live Preview V2-C Next.js 支持延期，V2 收敛为 Vite-only MVP | accepted |
| [013](./decisions/013-local-model-eval-support.md) | 评测中心 + 主聊天支持本地 Ollama 模型 | accepted |
| [014](./decisions/014-debug-snapshot-system.md) | 调试快照系统 + CLI debug 命令树 | accepted |
| [015](./decisions/015-swebench-docker-eval-harness.md) | SWE-bench docker-based eval harness | accepted |
| [016](./decisions/016-no-cross-kind-verifier-interface.md) | 不提前抽 cross-kind verifier interface | accepted |

---

## 快速参考

### 技术栈

| 层级 | 技术选型 |
|------|----------|
| 桌面框架 | Tauri 2.x (Rust) |
| Tauri 插件 | `plugin-updater` (自动更新) + `plugin-opener` (Finder reveal/open) + `plugin-dialog` (原生文件选择器) |
| 前端框架 | React 18 + TypeScript 5.6 |
| 状态管理 | Zustand 5 |
| 样式 | Tailwind CSS 3.4 |
| 构建 | esbuild (main) + Vite (renderer) |
| 本地存储 | SQLite (better-sqlite3) |
| 云端存储 | Supabase + pgvector |
| AI 模型 | 小米 MiMo v2.5 Pro（默认）/ GPT-5.5 / DeepSeek V4 / Kimi K2.6 / 智谱 / 火山引擎 / Local-Ollama 多 provider 目录（14+ provider） |
| 本地桥接 | packages/bridge (localhost:9527) |
| 代码编辑 | CodeMirror 6 (Preview 代码/Markdown 编辑模式) |

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
│
├── src/
│   ├── main/                    # 后端主进程 (Node.js, Tauri sidecar)
│   │   │
│   │   │── ── 工程层 core ─────────────────────────
│   │   ├── app/                # 应用启动引导（bootstrap、窗口管理、生命周期）
│   │   ├── agent/              # AgentOrchestrator, AgentLoop, 多 Agent 协作
│   │   ├── context/            # 上下文投影系统（6 层压缩管线 + CompressionState + ProjectionEngine）
│   │   ├── errors/             # 统一错误处理（分类、恢复引擎、自动学习）
│   │   ├── events/             # 事件三通道（InternalEventStore 持久化 + ControlStream 实时 + Mailbox 协调）
│   │   │                         # 注：EventBus / EventBridge 运行时已迁出 protocol/，归位到 services/eventing/
│   │   ├── hooks/              # 用户可配置钩子系统（Agent Hook + 内置 Hook + trigger history）
│   │   ├── ipc/                # IPC handler 层（前后端通信桥梁，含 provider.ipc.ts 连通性测试+诊断+健康状态）
│   │   ├── model/              # ModelRouter, Provider, 自适应路由, 智能 Fallback, HealthMonitor, 请求规范化中间件
│   │   ├── permissions/        # 权限矩阵（GuardFabric 多源竞争 + PolicyEngine + 拓扑感知）
│   │   ├── platform/           # 平台抽象层（Tauri/Electron/Web 差异封装）
│   │   ├── prompts/            # Prompt 矩阵（4 Profile × 5 层 Overlay + Prompt Registry/override + 缓存稳定性）
│   │   ├── routing/            # Agent 路由系统（意图分类 + 路由决策）
│   │   ├── security/           # 运行时安全（命令监控、敏感信息检测、审计日志）
│   │   ├── services/           # 核心服务（Auth, Sync, Database, SecureStorage, 引用溯源、cloud config/update/feature flag）
│   │   ├── session/            # 会话管理（Worker Epoch 生成代围栏、快照重物化、导出、分叉、恢复）
│   │   ├── tools/              # gen1-gen8 工具实现 + DocEdit
│   │   │                         # 注：tool dispatch 已从 protocol/ 拆出，归位到 tools/dispatch/（M1.2）
│   │   │
│   │   │── ── 智能层 ──────────────────────────────
│   │   ├── cron/               # 定时任务与心跳监控
│   │   ├── evaluation/         # 评测双管道 + Session Replay
│   │   ├── desktop/            # 桌面活动服务（从旧 memory/ 搬迁）
│   │   ├── lightMemory/        # Light Memory 系统（File-as-Memory, ~700 行，唯一记忆系统）
│   │   ├── planning/           # 规划系统
│   │   ├── research/           # 深度研究模式（多源路由、自适应搜索、报告生成）
│   │   ├── scheduler/          # DAG 并行任务调度
│   │   ├── task/               # 多任务并行管理（TaskManager + Semaphore 信号量）
│   │   ├── telemetry/          # 遥测采集（意图分类统计、Prompt 缓存、存储）
│   │   ├── testing/            # Agent 自动测试框架（YAML 用例 + 断言引擎 + CI）
│   │   │
│   │   │── ── 技能层 ──────────────────────────────
│   │   ├── channels/           # 多渠道接入（飞书 Webhook 等）
│   │   ├── connectors/         # Office 连接器（日历、邮件、提醒事项，macOS 原生）
│   │   ├── mcp/                # MCP 服务端/客户端
│   │   ├── plugins/            # 插件系统（加载、注册、存储、生命周期）
│   │   ├── skills/             # 用户可定义技能 + 数据清洗 Skill
│   │   │
│   │   │── ── 基础设施 ────────────────────────────
│   │   ├── config/             # 统一配置（路径管理、规则加载）
│   │   ├── cron/               # 定时任务与心跳监控（CronService + Heartbeat）
│   │   ├── ide/                # IDE 桥接接口（未来 IDE 集成预留）
│   │   ├── lsp/                # LSP 语言服务器协议（多语言 Server 管理）
│   │   ├── scheduler/          # DAG 并行任务调度
│   │   ├── types/              # 主进程内部类型定义
│   │   └── utils/              # 工具函数（加密、图片处理、日志脱敏、性能计量）
│   │
│   ├── renderer/               # React 前端
│   │   ├── components/         # UI 组件（Chat, Explorer, AgentTeam, Settings...）
│   │   ├── stores/             # Zustand 状态
│   │   └── hooks/              # 自定义 hooks
│   │
│   ├── shared/                 # 类型定义、常量、IPC 协议（含 contract/designBrief、contract/workspacePreview、prompt rewind DTO）
│   ├── design/                 # Design Brief 工作流：direction-tokens、critique judge（5 维评分 + prompt）
│   ├── artifacts/              # Session-level artifact 定义（question-form 等结构化采集产物）
│   ├── shared/ipc/             # zod IPC schemas、typedInvoke / defineHandler 共享契约
│   ├── cli/                    # CLI 接口（独立构建入口；含 `debug` 命令树）
│   └── web/                    # Web Server（SSE API + 路由）
│
├── src-tauri/                   # Tauri Rust Shell
├── packages/
│   ├── bridge/                  # Local Bridge 服务 (localhost:9527)
│   └── eval-harness/            # 评测 Harness
├── vercel-api/                  # 云端 API (Vercel)
└── supabase/                    # 数据库迁移
```

### 工具体系（108 个 native ToolModule）

按功能分为 9 类，其中 15 个核心工具始终发送给模型，其余通过 ToolSearch 按需加载。2026-05 native migration 后，`src/main/tools/registry.ts` 当前注册 108 个 ToolModule，`src/main/tools/modules/` 下有 107 个 schema 文件；下表按能力域说明，不把每类数量写成长期不变量。

| 分类 | 代表工具 |
|------|----------|
| Shell & 文件 | Bash, Read, Write, Edit, MultiEdit, Glob, Grep, GitCommit, NotebookEdit |
| 规划 & 任务 | TaskManager, Plan, PlanMode, AskUserQuestion, Task, findings_write, confirm_action |
| Web & 搜索 | WebSearch, WebFetch, ReadDocument, LSP, Diagnostics |
| 文档 & 媒体 | DocEdit, ExcelAutomate, PPT, Image/Video/Chart/QRCode, Speech |
| 外部服务连接器 | Jira, GitHubPR, Calendar, Mail, Reminders |
| 记忆 | MemoryWrite, MemoryRead |
| 视觉 & 浏览器 | Computer, Browser, Screenshot, GuiAgent, visual_edit |
| 多 Agent | AgentSpawn, AgentMessage, WaitAgent, CloseAgent, SendInput, Teammate |
| 统一入口 / 元工具 | Process, MCPUnified, DocEdit, ExcelAutomate, PdfAutomate, ToolSearch |

> **工具合并**: 31 个独立延迟工具合并为统一工具（Process, MCPUnified, TaskManager 等），使用 action 参数分发。详见 [ADR-006](./decisions/006-deferred-tools-consolidation.md)。
>
> **文档编辑统一**: DocEdit 统一入口，富文档为原子级增量编辑（Excel 14 操作 / PPT 8 操作 / Word 7 操作），SnapshotManager 提供快照回滚。

### v0.16.74 Prompt / Hook / Prompt Rewind（2026-05-11）

这一轮把可配置 prompt、Hook 可观测性和会话回退收进主产品面。架构上复用既有 domain IPC、SessionRepository、FileCheckpointService 和 turn timeline，没有引入新的并行会话模型。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| Prompt Registry | `applyOverride()` 将 prompt 常量包成实时字符串；`dynamic()` 让组合 prompt 每次构建都重新读取 override；`promptIndex` 负责副作用注册所有 prompt 模块 | `src/main/prompts/registry.ts`、`src/main/prompts/promptIndex.ts`、`src/main/prompts/builder.ts` |
| Prompt Manager UI | `domain:prompt` 提供 `list/get/set/reset/preview/debugSystemPrompt`；UI 按 category 展示默认文本和当前生效文本，保存到 `~/.code-agent/prompts-overrides/<id>.md` | `src/main/ipc/prompt.ipc.ts`、`src/renderer/components/features/prompts/PromptManagerModal.tsx` |
| Hook Settings | `domain:hook` 汇总全局/项目 hook 配置、enabled/unused events、matcher、source、decision/observer、parallel，并能创建/打开/定位配置文件 | `src/main/ipc/hook.ipc.ts`、`src/renderer/components/features/settings/tabs/HooksSettings.tsx` |
| Hook Activity in Chat | HookManager 记录最近 50 条 trigger history，并通过 turn timeline 注入 `hook_activity`；TurnCard 在用户提示词下方展示本轮 hook 数量、状态、耗时和事件 chips | `src/main/hooks/hookManager.ts`、`src/renderer/utils/turnTimelineProjection.ts`、`src/renderer/components/features/chat/TurnCard.tsx` |
| CLI hooks 默认启用 | CLI `buildCLIConfig()` 显式设 `enableHooks:true`，`AgentLoop` 不再只在 planning mode 下运行用户 Hook | `src/cli/bootstrap.ts`、`src/cli/types.ts` |
| Chat workspace defaults | 新建会话、新 tab、初始 bootstrap 传 `workingDirectory:null`，避免继承上一条代码工作区；TitleBar 选择目录后通过 `session:update` 持久化 | `src/renderer/components/Sidebar.tsx`、`src/renderer/components/TitleBar.tsx`、`src/renderer/stores/sessionStore.ts` |
| Prompt Rewind | `domain:session/rewindToPrompt` 拒绝 running session，找到锚点用户消息与最近 checkpoint，回滚文件，隐藏锚点及之后 active 消息，把原 prompt/attachments 回填输入框，并写 `session_rewinds` 审计 | `src/main/app/agentAppService.ts`、`src/main/services/core/repositories/SessionRepository.ts`、`src/main/services/checkpoint/fileCheckpointService.ts`、`src/renderer/components/ChatView.tsx` |
| Web 模式对齐 | `src/web/webServer.ts` 增加同名 `rewindToPrompt` action，Web 端会话 API 与 Tauri IPC 保持功能一致 | `src/web/webServer.ts` |

**持久化边界**：
- `messages.visibility = active | rewound` 是 active transcript 的过滤条件；rewound 消息保留在库中用于审计、同步和回放，不再出现在普通 `getMessages()`。
- `session_rewinds` 记录 anchor prompt、隐藏消息列表、checkpoint message、文件恢复/删除数量和错误列表。
- Supabase 侧迁移 `20260511000000_prompt_rewind.sql` 同步增加 `messages.visibility` 与 `public.session_rewinds`，并用 RLS 限制到当前用户。

### v0.16.72-73 Native Protocol + Artifact Acceptance + Isolation + Quality Gates（2026-05-01 ~ 2026-05-10）

这一轮不是单点功能，而是把工具协议、artifact 验收、多 agent 浏览器/桌面隔离、类型/异步/清理门禁同时推进。文档口径按能力域记录，避免把它误读成零散 refactor。

| 能力域 | 当前闭环 | 关键文件 / 文档 |
|------|---------|----------------|
| Level 1 native tool protocol | Web/Search、Excel、Document、MCP、Skill、LSP、Multiagent、Planning、Vision、Network/Media/Docgen/PPT 按 wave 迁到 native module；旧 wrappers/legacy path 分批删除；IPC schema 不变的工具保留前端兼容 | `src/main/tools/modules/*`、`src/main/tools/registry.ts`、`docs/migrations/legacy-tools-removal-sop.md` |
| Tool reliability | WebFetch 强制 URL；toolSearch 无 callable 命中时明确失败；Edit old_text mismatch 返回最近 anchor lines；LSP 扩到 100+ extension map 并能返回 install hint；shell 统一走 command policy | `src/main/tools/modules/network/*`、`src/main/tools/utils/anchorHint.ts`、`src/main/lsp/*`、`src/main/tools/modules/shell/commandPolicy.ts` |
| Runtime / Web / Context hardening | compaction/browser recovery、partial-failure trace、Web 401/403 token mismatch recovery、run 前持久化 user message、activeAgentLoops flush、telemetry classifier、token-trigger compaction、context fill 包含 tool schemas | `src/main/context/*`、`src/web/webServer.ts`、`src/main/telemetry/*`、`src/renderer/components/features/chat/*` |
| Artifact acceptance / repair | AcceptanceRunner、Delivery Review、Preview Feedback、通用 repair toolkit、Game subtype registry、Best-of-N + repair cap + monotonicity gate、DeckVerifier + schema/narrative probes、DashboardVerifier + browser visual smoke + state_change_on_click probe | `src/main/agent/runtime/acceptance/*`、`src/main/evaluation/deliveryReviewService.ts`、`src/main/evaluation/previewFeedbackService.ts`、`src/main/agent/runtime/repair/*`、`src/main/agent/runtime/game/*`、`src/main/agent/runtime/deck/*`、`src/main/agent/runtime/dashboard/*` |
| Browser / Computer multi-agent isolation | 子 agent 工具调用带 `agentId`，BrowserService pool 提供 per-agent cookie/storage 隔离；ephemeral Chromium FIFO semaphore；ComputerSurface 写动作 mutex；新增 mouse_down/up、open_application、write_clipboard、computer_batch、hold_key、triple_click、cursor_position | `src/main/services/infra/browserPool.ts`、`src/main/services/infra/browserService.ts`、`src/main/services/infra/playwrightLaunchSemaphore.ts`、`src/main/services/desktop/computerSurfaceLock.ts`、`src/main/tools/vision/computerUse.ts`、`tests/smoke/*` |
| Multi-agent signal propagation | subagent dispatch 将 `agentId` 注入 `ToolContext`；`effectiveSignal` 透传 `modelRouter.inference`，避免子 agent cancel / abort 丢到模型调用外 | `src/main/agent/multiagentTools/*`、`src/main/model/modelRouter.ts` |
| Typed IPC / Web payload | `shared/ipc` zod schemas、`defineHandler`、renderer `typedInvoke`、web `parseBody` 建成 typed IPC/HTTP payload 校验起点 | `src/shared/ipc/*`、`src/main/platform/ipcRegistry.ts`、`src/renderer/services/typedInvoke.ts`、`src/web/helpers/typedBody.ts` |
| Provider wrappers / symmetry | OpenAI / Anthropic / DeepSeek / Gemini 解析走 zod wrappers，SSE stream 切到 wrappers；51 fixtures contract tests；provider symmetry 脚本接 Husky + GitHub Actions | `src/main/model/providers/wrappers/*`、`scripts/check-provider-symmetry.sh`、`.husky/pre-commit` |
| Async correctness / god-file split | `Promise.race` → `withTimeout`，timer graceful shutdown + `.unref()`，`new URL()` try/catch；HookManager / telemetryQueryService / TaskDAG 按执行引擎、replay、graph algorithms 拆分 | `src/main/services/infra/timeoutController.ts`、`src/main/hooks/*`、`src/main/evaluation/*`、`src/main/agent/taskDag.ts` |
| Cleanup / architecture retirement | cloud agent module、legacy provider functions、P0-5 POC subsystem、Decorated tools、orphan resume、unused exports 清理；Message 类型统一到 `shared/contract`；Codex sandbox/crossVerify 退场，改成 bash command policy | `src/main/agent/*`、`src/main/model/*`、`src/main/tools/*`、`src/shared/contract/*` |

**架构边界澄清**：
- Native protocol migration 是运行时入口归位，不改变用户看到的工具语义；同名工具、alias 和 IPC contract 尽量保持兼容。
- Artifact acceptance 采用"按 artifact kind 拥有自己的 verifier"的策略；ADR-016 明确暂不抽 `ArtifactKindVerifier` 顶层接口，避免把 deck 的 in-memory 验证和 dashboard 的 browser 验证硬塞进同一形态。
- Browser/Computer 隔离解决的是 Agent Team 并发时的状态串扰，默认单 agent 浏览器语义保持不变。
- 5/10 的 cleanup 是架构退休：删除不再 active 的 POC/cloud/legacy path，不作为新产品入口宣传。

### v0.16.66 Agent Runtime Capability Hardening (2026-04-27)

这一轮把 2026-04-27 的 P1/P2 capability audit 从计划推进到代码和定向测试闭环。范围集中在 agent runtime、tool、MCP、persistence、swarm、eval/replay 的生产链路。

| 模块 | 当前闭环 | 关键文件 |
|------|---------|---------|
| Run lifecycle | `ConversationRuntime.run` 统一 terminal path；`completed / failed / cancelled / interrupted` 都进入 `RunFinalizer`；cancel 发 `agent_cancelled`，failure 不绕过 finalizer | `src/main/agent/runtime/conversationRuntime.ts`、`runFinalizer.ts` |
| Run-level abort | `abortSignal` 贯穿 `ToolExecutionEngine -> ToolExecutor -> ToolResolver -> ProtocolToolContext`，长 Bash/http 等工具可被 run cancel | `src/main/agent/runtime/toolExecutionEngine.ts`、`src/main/tools/toolExecutor.ts`、`src/main/tools/dispatch/toolResolver.ts` |
| Chat run owner | desktop chat send/interrupt 走 TaskManager-owned path，避免 chat status 与 task state 两套 owner 漂移 | `src/main/app/agentAppService.ts`、`src/main/task/TaskManager.ts` |
| Tool 权限与 MCP | `Bash/bash` 归一；顶层审批结果通过 `approvedToolCall` 传给 resolver；MCP dynamic tool 可 direct execute 到 `MCPClient.callTool`；ToolSearch 标记 `loadable/notCallableReason` | `toolExecutor.ts`、`toolResolver.ts`、`mcpToolRegistry.ts`、`toolSearchService.ts` |
| Skill 安全边界 | project/user skill 的 `allowed-tools` 不再自动扩权；只有 builtin/plugin skill 可进入自动 preapproval | `src/main/tools/modules/skill/skill.ts`、`src/main/services/skills/skillParser.ts` |
| Multiagent | parallel executor 有真实 inbox；`dependsOn` 按成功依赖门控；失败/blocked/cancelled 都进入 aggregation；run-level cancel 阻止 pending agent 启动 | `parallelAgentCoordinator.ts`、`sendInput.ts`、`resultAggregator.ts` |
| 持久化恢复 | todo、Task tool task、context intervention、compression state、persistent system context、pending approval kind hydrate 都有 session-scoped durable path | `SessionRepository.ts`、`taskStore.ts`、`contextInterventionState.ts`、`runtimeStatePersistence.ts` |
| Replay / Eval | structured replay join model/tool/event evidence；`real-agent-run` gate 校验 `sessionId + replayKey + telemetryCompleteness`，缺关键证据会 fail/degraded | `telemetryQueryService.ts`、`testRunner.ts`、`ExperimentRunner.ts` |

验证口径：P1/P2 计划文档列出的 blocker 已在 unit/renderer/security 定向测试和 `npm run typecheck` 层面闭环；真实 app 长 run pause/resume、UI cancel 长命令、Agent Team 多 agent、reload recovery 仍按 smoke 风险列在对应文档里，不写成已完成的产品验收。

### v0.16.67-71 Hardening + 评测扩面 + Design Brief 生产化（2026-04-27 ~ 2026-04-29）

两天的 50+ commits 集中在：基建守门、安全收口、目录归位、新模型接入、Design Brief 全链路、评测扩面、调试快照与 CLI debug 命令树、channel 实时事件。

| 模块 | 当前闭环 | 关键文件 / 入口 |
|------|---------|----------------|
| Tauri Updater 安全 (M6.a / M6.b) | cloud-api 下发 `sha256` 字段；updater 落盘前哈希校验；`open_update_url` 阻止二进制下载，仅可在浏览器打开 release 页 | `src/main/services/updater/*`、`vercel-api/`、`docs/releases/` |
| Updater artifact 关闭 | `tauri.conf.json` 关闭自动 updater artifact 生成，避免无签名/无哈希产物意外发布 | `src-tauri/tauri.conf.json` |
| EventBus / EventBridge 归位 | 事件运行时从 `src/main/protocol/` 迁到 `src/main/services/eventing/`，`vi.mock` 路径同步更新；事件分层与三通道契约不变 | `src/main/services/eventing/*`、`tests/eventing/*` |
| Tool dispatch 归位 (M1.2) | tool 分发从 `protocol/` 拆出，统一到 `src/main/tools/dispatch/`，`ToolResolver` 与 abort 链贯通保持原状 | `src/main/tools/dispatch/toolResolver.ts` |
| 调试快照体系 (ADR-014) | `turn_snapshots` + `compaction_snapshots` 两张表 + 写入器；step pause；settings "调试快照" section 含 retention selector；`data` 域 IPC 暴露 stats/clear/setRetention；CLI `code-agent debug` 命令树复用同一能力 | `src/main/agent/runtime/turnSnapshotWriter.ts`、`src/main/context/compactionSnapshotWriter.ts`、`src/main/ipc/data.ipc.ts`、`src/cli/commands/debug/*` |
| 本地 Ollama 评测 (ADR-013) | 评测中心 `MODEL_OPTIONS` 显式声明 provider；`evaluation.ipc.ts` 接收 provider 字段并按 provider 路由 API key；主聊天 `ModelSwitcher` unhide local provider | `src/renderer/components/features/evalCenter/CreateExperimentDialog.tsx`、`src/main/ipc/evaluation.ipc.ts`、`src/renderer/components/StatusBar/ModelSwitcher.tsx` |
| `evalEligible` catalog 字段 | `model-catalog.json` 标记可评测模型，`CreateExperimentDialog` 模型列表从 `PROVIDER_MODELS` 派生并按 `evalEligible` 过滤，避免视觉/嵌入模型出现在主聊天打分对象里 | `src/shared/model-catalog.json`、`src/shared/constants/models.ts` |
| SWE-bench docker harness (ADR-015) | 独立 `eval/swe-bench/`，colima + 官方 docker image；`validation.ts` 双层 executable validation；CLI `--mode docker \| python` 默认 docker；Django <15min 子集 9/10 first-shot；不污染 chat agent 主链路 | `eval/swe-bench/*`、`docs/decisions/015-swebench-docker-eval-harness.md` |
| 小米 MiMo provider | 新增 `XiaomiProvider`（OpenAI 兼容，新加坡 token-plan 节点），注册 4 个模型（mimo-v2.5-pro / v2.5 / v2-pro / v2-omni 多模态）；`DEFAULT_PROVIDER` 切到 `xiaomi`，`DEFAULT_MODEL` 切到 `mimo-v2.5-pro`；CLI / IPC / Web 各入口注册 `XIAOMI_API_KEY` env | `src/main/model/providers/xiaomiProvider.ts`、`src/shared/constants/providers.ts`、`src/shared/constants/defaults.ts`、`scripts/acceptance/xiaomi-smoke.ts` |
| 模型 capability/缩写 单源真理 | 散落在前后端的 capability map 与缩写映射收敛到 `src/shared/constants/models.ts`，前端只消费派生视图 | `src/shared/constants/models.ts` |
| SessionManager apiKey 剥离 | HTTP response 经 `SessionManager` 出口前显式 strip `ModelConfig.apiKey`，防止云同步 / Web 模式回传链路把密钥泄漏到 renderer 或日志 | `src/main/session/SessionManager.ts` |
| Audit Phase A (命令注入 + 默认模型硬编码) | 长期遗留 shell 拼接路径全部走 `execFile`；多处 `\|\| 'deepseek'` `\|\| 'kimi-k2.5'` 风格的硬编码 fallback 全部替换为 `DEFAULT_PROVIDER` / `DEFAULT_MODEL` 常量 | `src/main/`（多文件）；自检 `grep -rn "\|\| 'deepseek'"` |
| NetworkStatus closure-stale 修复 | `NetworkStatus` 闭包陈旧导致退避少一档，调整为读最新 state 而非 closure 捕获 | `src/main/network/networkStatus.ts` |
| `silenceAsync` observability helper | 新增 `silenceAsync` 包装高频 fire-and-forget 调用，6 处关键审计链路接入避免日志爆炸但保留诊断断点 | `src/main/utils/silenceAsync.ts` |
| Husky + lint-staged + 硬编码自检 | 提交前自动跑 `grep -rn "\|\| 'deepseek'"` 等自检规则，硬编码常量回潮即拦截 | `.husky/pre-commit`、`package.json` |
| `max-lines: 1000` ESLint 守门 | 1000 行上限作为 God File 硬护栏，19 个 legacy God File 进白名单逐步消化 | `.eslintrc`、`docs/audits/2026-04-27-codex-2day-burst-cleanup.md` |
| Supabase services 类型清理 | 一次性移除 18+ 处 `as any`，并修出 latent bug（B5 audit） | `src/main/services/sync/*` |
| Design Brief 生产化 (Phase A→C.3) | `src/design/`（direction-tokens + 5-dim critique）、`src/artifacts/question-form.ts`、`src/main/prompts/selfCritique.ts`、`src/main/prompts/questionForm.ts`、`src/main/app/workbenchTurnContext.ts` 把 brief 生产路径接进 envelope 与 system prompt；C.3 路线 A 借鉴 nexu-io 模式注入 silent self-critique pre-emit gate | `src/design/*`、`src/artifacts/*`、`src/shared/contract/designBrief.ts`、`src/main/prompts/selfCritique.ts` |
| Workspace Preview Panel | 右侧 artifact review workbench：承载 designBrief / questionForm / design_ppt / delivery review / preview feedback；反馈项可 resolve、dismiss 或 send back to chat；TaskMonitor scope inspector 与之联动 | `src/renderer/components/WorkspacePreviewPanel.tsx`、`src/renderer/components/QuestionFormPreview.tsx`、`src/renderer/hooks/useWorkspacePreviewModel.ts`、`src/renderer/utils/workspacePreview.ts` |
| Channel inbox / outbox 实时事件 | 入站 / 出站事件统一 IPC 通道，renderer 可 `list / dismiss`；`ConnectorsCard` 直接消费 channel inbox 状态 | `src/main/channels/*`、`src/renderer/components/.../ConnectorsCard.tsx` |
| Chat-view 新会话首屏 | 新 session 首屏从"示例 prompt 卡"改为写邮件/排日程、做方案/文档/PPT、调研/对比、代码改动四类具体任务入口 | `src/renderer/components/ChatView.tsx` |
| Eval Center Review Queue | `SessionListView` 把待评 session 集中分桶，标注 replay 完整度与异常 case；行点击进详情；fatal inference error 熔断；DB 去重 | `src/renderer/components/features/evalCenter/SessionListView.tsx`、`src/main/evaluation/testRunner.ts` |
| Computer Surface `locate_role+targetApp` | 走 macOS background AX 直连指定 app 控件树，避免唤起前台；`type` / `key` 没有 background target 时降级前台键盘事件，bridge 显式 warn；文档 Computer / computer_use 别名映射 + 截图可见性规则 | `src/main/tools/computerUse.ts`、`src/main/tools/desktop.ts`、`docs/guides/computer-use.md` |
| CLI config 单源 | `CLIConfigService` 与 `ConfigService` 统一为同一份 config source，避免 CLI 模式与 Tauri 模式读到不同默认值 | `src/cli/config.ts`、`src/main/config/*`（PR #88） |

**架构边界澄清**：
- `services/eventing/` 与 `tools/dispatch/` 都是 `protocol/` 的"专项归位"，不引入新的运行时语义。`protocol/` 只保留跨进程消息契约，运行时实现回到各自能力域。
- Design Brief 工作流落点是 `src/design/`、`src/artifacts/`、`src/shared/contract/designBrief.ts` 三处，与主聊天 envelope 之间通过 `workbenchTurnContext` + `messageBuild` 串联。它对普通编程任务保持零打扰。
- 调试快照体系不依赖 telemetry / replay 旧链路，单独走 SQLite 双表，方便后续按 retention window 单独清理。

### v0.16.59 竞品追赶 (2026-04-11)

6 条并行工作流，17 commits，61 files，+3249 lines：

| 模块 | 新增能力 |
|------|---------|
| Provider 系统 | 火山引擎 + 本地模型 8 扩充 + Health Monitor 四状态机 + 连通性测试 |
| 错误处理 | 4 类新错误分类 + 可操作化 toast + 流式分阶段反馈 + 诊断面板 |
| 会话控制 | 推理强度 4 级 + Code/Plan/Ask 模式 + 暂停/恢复 + 检查点 Fork |
| 聊天显示 | 工具自动分组 + Thinking 摘要 + 消息编辑/重试 + Artifact 追踪 |
| 设置导航 | 设置搜索 + 会话搜索/项目分组 + MCP 添加 UI + 权限模式切换 |
| 安全 | postMessage 校验 + CSP + prompt injection 防护 + 图表路径统一 |

### v0.16.60-65 Workbench 面板整合 + Preview 扩能 (2026-04-18 ~ 2026-04-23)

40+ commits，围绕**右侧工作面板统一**和 **Preview 多模态能力**展开，消除 legacy 多面板抢宽度问题。

| 模块 | 新增能力 | 关键文件 |
|------|---------|---------|
| 统一 tab 模型 | `openWorkbenchTab` / `closeWorkbenchTab` 单一 action 替代 legacy `show*Panel`；Task/Skills/Files 单例 tab，Preview 多 tab | `src/renderer/stores/appStore.ts` |
| WorkbenchTabs 顶栏 | 右侧面板头部 tab bar，X 关闭后自动切到幸存 tab，tab 顺序稳定 | `src/renderer/components/WorkbenchTabs.tsx` |
| Preview 多格式 | 代码编辑器（ts/tsx/js/jsx/json/yaml/yml，CodeMirror 6）+ Markdown 编辑（md/csv/tsv/txt）+ CSV/TSV 表格 + 图片/PDF base64 | `src/renderer/components/PreviewPanel.tsx` |
| Preview LRU | `MAX_PREVIEW_TABS = 8` 上限，超出按最近未使用淘汰 | `appStore.ts` |
| File Explorer 同步 | 切换 session 时自动跟随 `workingDirectory`，内联新建 File/Folder，`openOrFocusTab` action | `src/renderer/components/features/explorer/FileExplorerPanel.tsx` + `stores/explorerStore.ts` |
| Tauri plugin-opener | Finder reveal / 外部打开路径经 Rust 插件，渲染进程通过 `@tauri-apps/plugin-opener` 调用 | `src-tauri/Cargo.toml` + `package.json` |
| Tauri plugin-dialog | 原生目录选择器替代 renderer 自绘弹窗；`workspace:selectDirectory` IPC 经 domain API 路由 | `src/renderer/services/workspaceService.ts` |
| Sidebar workspace grouping | Codex-style 按 workingDirectory 分组 + 折叠状态持久化 | `src/renderer/components/Sidebar.tsx` |
| 死代码清理 | CloudTaskToggle / TaskListToggle / DAGToggle / ObservabilityToggle 及其 orphan state 全部移除；TitleBar 只保留 File/Skills/Task 三个 toggle | `src/renderer/components/TitleBar.tsx` + `App.tsx` |
| 稳定性护栏 | 恢复 session 不再卡"就绪"（sessionPresentation 修复）；Write tool row 文件名可点击 + Reveal | `src/main/session/sessionPresentation.ts` |

**架构要点**：ADR-011 定义的 Chat-Native Workbench 不变（聊天主链路仍是默认心智入口），本轮改动是在其上对**右侧 sidecar** 做物理整合。TaskPanel / SkillsPanel / PreviewPanel / FileExplorerPanel 共享同一宿主和同一 store action，职责分工不变。

---

### v0.16.65 Live Preview Visual Grounding (D6-D8) + 基础设施修复 (2026-04-24)

把"点 iframe 元素 → 源码位置 → Agent 改代码 → HMR 看效果"做成闭环。跨三处仓库：

- `code-agent`（主仓库）：10 commits，UI + 协议同步 + IPC + 基础设施修复
- `vite-plugin-code-agent-bridge`（独立仓库）：升级到 v0.2.0，新增 HMR restore 协议
- `visual-grounding-eval/spike-app`：测试用 fixture（协议消费者验证）

#### 数据流（从 iframe click 到 envelope context）

```
iframe click
  ↓ (bridge runtime, vite 插件编译期注入 data-code-agent-source="file:line:col")
postMessage {type:'vg:select', payload:SelectedElementInfo}
  ↓ (LivePreviewFrame message handler, 校验 event.source + expectedOrigin)
resolveAndSetSelectedElement
  ↓ (IPC domain:livePreview resolveSourceLocation, projectRoot=workingDirectory)
appStore.setSelectedElement(tabId, {file:absolute, relativeFile, line, column, tag, text, rect, componentName?})
  ↓ (用户发 Chat message)
composerStore.buildContext() 读 activePreviewTabId → tab.selectedElement → 拍回 nested SelectedElementInfo
  ↓
ConversationEnvelopeContext.livePreviewSelection 随 envelope 到 main 侧
```

`file` 存绝对路径（main 侧工具消费跨进程方便），`relativeFile` 存 bridge 原 DOM 属性里的 vite-root 相对路径（HMR restore 反查 DOM 用，两端形状对称）。

#### Bridge 协议 v0.2.0（独立 npm 包 + 主仓库 shared 同步）

| 消息 | 方向 | payload | 用途 |
|---|---|---|---|
| `vg:ready` | iframe → parent | `{url}` | bridge install 完成通告，parent 以此触发 restore 链路 |
| `vg:select` | iframe → parent | `SelectedElementInfo` | 用户 click 的结果 |
| `vg:hover` | iframe → parent | `SelectedElementInfo \| null` | hover 反馈（MVP 不消费，预留） |
| `vg:selection-stale` **(0.2.0 新增)** | iframe → parent | `{location}` | bridge 按 location 找不到元素时反馈，parent 清 appStore selection |
| `vg:simulate-click` | parent → iframe | `{selector}` | 编程触发 iframe 内点击 |
| `vg:clear-selection` | parent → iframe | - | 主动清空 selection |
| `vg:ping` | parent → iframe | - | 健康检测，bridge 回发 vg:ready |
| `vg:restore-selection` **(0.2.0 新增)** | parent → iframe | `{location}` | HMR 回流恢复。bridge 按 file+line+column 反查 DOM 重高亮；匹配失败回发 `vg:selection-stale` |

匹配策略：先精确 file+line+column；次选 file+line（column 最易漂移，作 tiebreaker）。

#### HMR 回流恢复 selection（P3 核心）

```
用户点元素 → appStore 有 selection
  ↓
保存代码 / 点 Refresh → iframe full reload
  ↓
bridge 重新 install() → post('vg:ready')
  ↓ (parent 收到 vg:ready)
LivePreviewFrame 读 useAppStore.getState() 发现 selection 还在
  ↓
iframe.contentWindow.postMessage({type:'vg:restore-selection', location:{file:relativeFile,line,column}}, expectedOrigin)
  ↓ (bridge 的 message listener, 0.2.0 新增 case)
findElementByLocation(location) 遍历 [data-code-agent-source] 匹配
  ├── 命中 → rotateClass HIGHLIGHT_CLASS + post('vg:select', extractInfo(...))
  │          → parent resolveAndSetSelectedElement 回写 appStore（幂等）
  └── 失败 → post('vg:selection-stale', {location})
             → parent setSelectedElement(tabId, null) → UI 回未选中态
```

覆盖范围：完整 full-reload（多数 HMR、手动 Refresh、URL 切换）。Partial HMR 下 DOM 原地替换的 case 暂不覆盖（需 DOM MutationObserver，留未来）。

#### 关键实现坑

| 坑 | 现象 | 根因 | 修法 |
|---|---|---|---|
| iframe Refresh double-load | 蓝框偶尔不恢复（时好时坏） | `<iframe src={devServerUrl}>` 受控 prop，`iframeRef.current.src = '?_refresh=xxx'` 直接 mutate DOM 会被 React rerender 矫正回原 URL，实际加载两次、contentWindow 换两次 | 用 `refreshNonce` React state + `useMemo` 推 `iframeSrc`，`<iframe src={iframeSrc}>` 纯受控，单次 load |
| about:blank CSP 踩坑 | 老 handleRefresh 走 `src='about:blank' → rAF → src=原 URL`，Tauri WKWebView 下 frame-src CSP 对 about:blank 不稳定，且 about:blank 秒加载先触发 onLoad 误导 3s 诊断 timer | 中转态引入时序 race | 一次性 cache-bust query `?_refresh=${Date.now()}`，无中转 |
| SERVER_AUTH_TOKEN 不跨 restart | dev 下 kill/restart webServer 后 Tauri WebView 里固化的老 token 立刻失效，踩 "Invalid auth token" | `auth.ts` 每次启动 `randomUUID()` 生成新 token | `loadOrGenerateAuthToken()` 启动时先读 `.dev-token`，是合法 UUID v4 就复用；shutdown 不再 unlink `.dev-token` |
| Tauri 启动白屏 | `cargo tauri dev` 窗口可见但白屏 | `tauri.conf.json` 里 `window.url = "http://localhost:8180"` 硬编码，webview 一创建就请求；beforeDevCommand 还在 build（12s+），webServer 未监听，webview 加载失败进 error 页 | `window.url = "about:blank"`；Rust setup() healthcheck 通过后用 `webview.navigate(Url)` 跳 SERVER_URL，比 eval+JS 可靠 |
| workspace:setCurrent 不同步 renderer | 直接调 domainAPI setCurrent 后 appStore.workingDirectory 还是 null，LivePreviewFrame 的 resolveSourceLocation 走 `process.cwd()` fallback 丢 selected 条 | 原 `handleSetCurrent` 只更新 main 进程 state 不 emit event | 新增 `WORKSPACE_CURRENT_CHANGED` IPC 事件通道，main emit + renderer `sessionStore` 订阅调 `useAppStore.setWorkingDirectory` |

#### 改动文件索引

| 模块 | 文件 | 作用 |
|---|---|---|
| Bridge 协议 | `~/Downloads/ai/vite-plugin-code-agent-bridge/src/protocol.ts` `runtime.ts` | v0.2.0 新增 restore-selection / selection-stale + findElementByLocation |
| Shared 协议 | `src/shared/livePreview/protocol.ts` | 主仓库侧协议同步到 v0.2.0 |
| Shared envelope | `src/shared/contract/conversationEnvelope.ts` | `ConversationEnvelopeContext.livePreviewSelection?` |
| Shared IPC | `src/shared/ipc/legacy-channels.ts` `handlers.ts` | `WORKSPACE_CURRENT_CHANGED` 通道 + IpcEventHandlers 注册 |
| Main IPC | `src/main/ipc/workspace.ipc.ts` | handleSetCurrent 广播 WORKSPACE_CURRENT_CHANGED |
| Main auth | `src/web/middleware/auth.ts` `src/web/webServer.ts` | `.dev-token` 复用 + shutdown 不清 |
| Tauri | `src-tauri/tauri.conf.json` `src-tauri/src/main.rs` | window.url = about:blank + setup navigate(Url) |
| UI 入口（历史） | `src/renderer/components/features/chat/ChatInput/AbilityMenu.tsx` | 2026-04-24 的 Live Preview URL input + Open 按钮；2026-04-26 B+ 后迁到 `SessionActionsMenu` / `DevServerLauncher` |
| UI 预览面板 | `src/renderer/components/LivePreview/LivePreviewFrame.tsx` | bridge message handler + restore 发起 + stale 清理 + 诊断 |
| Store | `src/renderer/stores/appStore.ts` | `LivePreviewSelectedElement.relativeFile` |
| Composer | `src/renderer/stores/composerStore.ts` | `buildContext()` 读活动 tab 的 selection 并拍回协议 nested 形 |
| Session subscribe | `src/renderer/stores/sessionStore.ts` | 订阅 WORKSPACE_CURRENT_CHANGED |
| Tests | `tests/renderer/stores/composerStore.test.ts` | 覆盖三种 selection 场景（liveDev 有 / file tab / null） |

---

### v0.16.65+ 2026-04-26 实现回写

4 月 26 日这批提交没有 bump package version，但已经明显改变了稳定架构口径。当前要按 `v0.16.65+` 记录，而不是继续只停在 4 月 23 日的面板整合状态。

| 能力域 | 当前状态 | 关键落点 |
|---|---|---|
| Workbench B+ 信息架构 | ChatInput 移除 AbilityMenu；低频动作收进 `+`；Code/Plan/Ask 收进 `+` 菜单；模型和 effort 合并成单胶囊；Routing / Browser 归入 Settings 的“对话”tab；Settings 分组导航与页面骨架落地；TitleBar 只保留核心入口，全局工具移入 Sidebar User Menu | `ChatInput/InputAddMenu.tsx`、`ConversationSettings.tsx`、`SettingsModal.tsx`、`SettingsLayout.tsx`、`settingsTabs.ts`、`SessionActionsMenu.tsx`、`Sidebar.tsx`、`WorkbenchTabs.tsx` |
| Live Preview V2-A/B | `devServerManager` 能探测并启动本地 dev server，DevServerLauncher 作为模态入口；bridge protocol 升级到 0.3.0，选中元素带 `className` 与 `computedStyle`；TweakPanel 支持 spacing/color/fontSize/radius/align 5 类 Tailwind 原子改写；V2-C Next.js App Router 支持按 ADR-012 延期 | `devServerManager.ts`、`LivePreviewFrame.tsx`、`TweakPanel.tsx`、`tweakWriter.ts`、`tailwindCategories.ts`、`docs/decisions/012-live-preview-v2-c-deferred.md` |
| Browser / Computer Workbench | in-app managed browser 已从 smoke 级推进到生产化基线：BrowserSession/Profile/AccountState/Artifact/Lease/Proxy、TargetRef/stale recovery、download/upload、fixture-only recipe benchmark 全部有 acceptance；Computer Surface 增加 background AX 与 background CGEvent 两条受控验证路径 | `browserService.ts`、`browserProvider.ts`、`browserAction.ts`、`computerUse.ts`、`desktop.ts`、`docs/acceptance/browser-computer-workbench-smoke.md` |
| Activity Providers | OpenChronicle 与 Tauri Native Desktop 不再各自直塞 prompt；新增 provider-neutral `ActivityContextProvider`、`ActivityProvider` contract、prompt formatter 与 renderer preview。OpenChronicle 仍是外部 daemon provider，Tauri Native Desktop 是 bundled provider | `activityContextProvider.ts`、`activityProviderRegistry.ts`、`activityPromptFormatter.ts`、`activityContext.ts`、`activityProvider.ts` |
| Semantic Tool UI | 工具 input schema 强制注入 `_meta.shortDescription`；provider parser 抽出 `_meta` 写到 ToolCall 顶层并剥离执行参数；SessionRepository 对无 `_meta` 的历史/弱模型工具调用生成 fallback shortDescription。前端用语义标题、target icon、memory citation 折叠卡、会话 diff 聚合卡和 URL favicon chip 改善可读性 | `prompts/builder.ts`、`model/providers/shared.ts`、`SessionRepository.ts`、`ToolHeader.tsx`、`MemoryCitationGroup.tsx`、`SessionDiffSummary.tsx`、`LinkPreviewCard.tsx` |
| Eval / model 协议修复 | 评测实验支持 SSE 进度、行点击进详情、fatal inference error 熔断、DB 去重；multi-turn adapter 真保留 messages；recent memory 在评测中隔离；thinking-mode provider 补齐 `reasoning_content` history 字段；`max_tool_calls` 从 critical gate 降为 weighted score | `testRunner.ts`、`agentAdapter.ts`、`retryStrategy.ts`、`providers/shared.ts`、`docs/knowledge/eval-tracking.md`、`docs/knowledge/bug-fixes.md` |

#### Live Preview V2 当前边界

V2 的稳定口径是 **Vite-only MVP**：自动起 dev server + 点击源码定位 + TweakPanel 原子样式修改。Next.js App Router 不计入 V2 完成定义，原因见 ADR-012。后续若 React / Next / SWC 生态出现可复用方案，再重新评估 V3。

#### Browser / Computer 当前边界

Browser 主路径是 in-app managed browser，默认验收走 System Chrome headless + CDP。远程浏览器池、外部 Chrome profile、外部 CDP attach、extension bridge 仍保留为 backlog，不写成当前已完成。Computer Surface 的 background AX / CGEvent 只对显式 target app/window 和本地受控 smoke 成立，foreground fallback 仍是需要人工确认的当前前台动作面。

---

## 平台架构（三端产品）

项目基于 Tauri 2.x，扩展为三端产品：

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
│  ├── 5 模式: chat / run / serve / exec / mcp  │
│  ├── 复用 AgentLoop + ToolRegistry            │
│  └── npm install -g code-agent-cli             │
└───────────────────────────────────────────────┘
```

| 端 | 定位 | 代码入口 |
|----|------|----------|
| Web | 尝鲜体验，浏览器即用 | `src/web/webServer.ts` |
| App (Tauri) | 主力体验，完整本地能力 | `src-tauri/` + `src/main/platform/` |
| CLI | 极客/Agent 调用/MCP Server | `src/cli/index.ts`（[详细架构](./architecture/cli.md)）|

### 平台抽象层 (`src/main/platform/`)

v0.16.44+ 引入平台抽象层，统一封装 Tauri/Electron/Web 的差异 API（窗口管理、路径、剪贴板、Shell、通知、全局快捷键、IPC 注册），业务代码不再直接导入 Electron 或 `@tauri-apps/*`。

关键技术决策：
- **Tauri 2.x 替代 Electron**：DMG 从 742MB → 33MB（95% 缩减）
- **Rust shell 启动 Node.js webServer 子进程**，health check 检测开发模式
- **CSP 安全策略 + capabilities 权限模型**

---

## v0.16.57 新增模块 — 架构对齐（2026-04-01）

对标成熟 code agent 能力拆解包，4 个里程碑 21 个 task 完成核心路径架构对齐。

### M1: 上下文投影系统（Projection-First Context Management）

| 模块 | 位置 | 描述 |
|------|------|------|
| **精确 Token 计数** | `src/main/context/tokenEstimator.ts` | 从字符比例启发式（误差 10-30%）升级为 BPE 实测（gpt-tokenizer，误差 <1%） |
| **CompressionState** | `src/main/context/compressionState.ts` | 不可变 commit log + snapshot 双持久化，追踪所有压缩操作 |
| **ProjectionEngine** | `src/main/context/projectionEngine.ts` | 纯函数投影：transcript + compressionState → API 视图（transcript 永不修改） |
| **六层压缩管线** | `src/main/context/layers/` + `compressionPipeline.ts` | L1 tool-result budget → L2 snip → L3 microcompact → L4 contextCollapse → L5 autocompact → L6 overflow recovery |
| **多分支决策引擎** | `src/main/agent/loopDecision.ts` | 每轮显式决策 continue/compact/continuation/fallback/terminate，含 max_tokens 续写协议 |
| **错误分类器** | `src/main/model/errorClassifier.ts` | 6 类错误分类（overflow/rate_limit/auth/network/unavailable/unknown）驱动恢复决策 |
| **缓存稳定性** | `src/main/prompts/cacheBreakDetection.ts` | DYNAMIC_BOUNDARY_MARKER 切分可缓存前缀和动态段，跨轮缓存不失效 |
| **/context 命令** | `src/main/ipc/context.ipc.ts` + `ContextPanel.tsx` | 展示 API 真实视图（经投影后）、token 分布、压缩状态 |

**核心架构变更**：从"原地变异"升级为"投影优先"——原始 transcript 不可变，CompressionState 追踪操作，ProjectionEngine 在查询时生成模型实际看到的视图。

```
Transcript (append-only, immutable)
    ↓
CompressionState (commit log + snapshot)
    ↓ query-time projection
API View (model actually sees)
```

### M2: Prompt 矩阵 + 多 Agent 子运行时

| 模块 | 位置 | 描述 |
|------|------|------|
| **Overlay 引擎** | `src/main/prompts/overlayEngine.ts` | 5 层叠加（substrate → mode → memory → append → projection），每层独立可开关 |
| **Prompt Profile** | `src/main/prompts/profiles.ts` | 4 种入口 profile（interactive/oneshot/subagent/fork）各有独立 overlay 组合 |
| **子 Agent 上下文重建** | `src/main/agent/childContext.ts` | `buildChildContext()` 从父上下文派生完整子运行时（prompt/tools/permissions/hooks/memory） |
| **AgentTask 状态机** | `src/main/agent/agentTask.ts` | 7 态生命周期（pending→registered→running→stopped→resumed→failed→cancelled）+ transcript 持久化 |
| **Mailbox 协调** | `src/main/agent/mailboxBridge.ts` + `agentBus.ts` | worker↔leader 协调协议（permission_request/response、task_dispatch、status_report） |

### M3: 权限矩阵 + 事件分层 + 连续性协议

| 模块 | 位置 | 描述 |
|------|------|------|
| **GuardFabric** | `src/main/permissions/guardFabric.ts` | 多源竞争（Rules + Mode + Hooks + Classifier），deny > ask > allow，first-valid-wins |
| **拓扑感知** | guardFabric 内置 | main/async_agent/teammate/coordinator 各有不同裁决（async_agent+bash→deny） |
| **事件三通道** | `src/main/events/internalEventStore.ts` + `controlStream.ts` | Internal（持久化 JSONL）+ Control（实时推送）+ Mailbox（agent 协调） |
| **EventReplay** | `src/main/events/eventReplay.ts` | 从 InternalEventStore 回放事件，支持 agentId/时间范围过滤 |
| **Worker Epoch** | `src/main/session/workerEpoch.ts` | 生成代围栏防止并发写入，`guardedWrite()` 校验 epoch 一致性 |
| **Rematerialization** | `src/main/session/workerEpoch.ts` | 从快照投影恢复（非 transcript 逐条回放），`checkResumeConsistency()` 一致性检查 |

### M4: 多模型路由整合 + Operator Surface（差异化增强）

| 模块 | 位置 | 描述 |
|------|------|------|
| **压缩模型路由** | `src/main/context/compressionModelRouter.ts` | L4→zhipu/glm-4-flash（最便宜），L5→moonshot/kimi-k2.5（更强摘要），L1-L3→null |
| **智能 Fallback** | `src/main/model/adaptiveRouter.ts` | `selectFallback()` 按失败原因选择：overflow→更大窗口，rate_limit→换 provider |
| **Agent 模型策略** | `src/main/agent/agentModelPolicy.ts` | 按 agent 类型分配模型（Explorer→Kimi 128k, Reviewer→DeepSeek R1, Search→Perplexity） |
| **请求规范化** | `src/main/model/middleware/requestNormalizer.ts` | 统一消息格式转换、工具 schema 适配、beta flags、缓存 TTL |
| **TokenWarning** | `src/renderer/components/TokenWarning.tsx` | 动态指示器：绿(<60%)→黄(60-85%)→黄脉冲(压缩中)→红(overflow/fallback) |
| **ContextVisualization** | `src/renderer/components/ContextVisualization.tsx` | token 分布柱状图 + 压缩时间线 + 活跃 agent + deferred tools |
| **/doctor 诊断** | `src/main/ipc/doctor.ipc.ts` | 环境/网络/配置/数据库/磁盘 5 类诊断，结构化 pass/warn/fail 报告 |

---

## v0.16.55 新增模块

### Agent Team — 并行多代理自主拆分（2026-03-19）

| 模块 | 位置 | 描述 |
|------|------|------|
| **SpawnGuard** | `src/main/agent/spawnGuard.ts` | RAII 风格并发守卫（max 6 agents, max depth 1），19 个禁用工具 + 只读工具限制 |
| **并行执行** | `src/main/tools/multiagent/spawnAgent.ts` | `executeParallelAgents` 容量检查 + 依赖解析（role→id 映射）+ 结果聚合 |
| **结果聚合** | `src/main/agent/resultAggregator.ts` | 3 种正则提取变更文件、计算 speedup ratio、汇总成本 |
| **活跃上下文** | `src/main/agent/activeAgentContext.ts` | `<active_subagents>` XML 注入 + `drainCompletionNotifications()` 异步通知 |
| **Git Worktree** | `src/main/agent/agentWorktree.ts` | `/tmp/code-agent-worktrees/{agentId}` 隔离，coder 独立分支，无变更自动清理 |
| **wait_agent** | `src/main/tools/multiagent/waitAgent.ts` | 等待指定子代理完成（支持超时） |
| **close_agent** | `src/main/tools/multiagent/closeAgent.ts` | 取消运行中的子代理（AbortController） |
| **send_input** | `src/main/tools/multiagent/sendInput.ts` | 向运行中子代理发送消息（消息队列，executor 每轮消费） |
| **SwarmMonitor UI** | `src/renderer/.../swarm/SwarmMonitor.tsx` | 聚合结果展示（成本卡片、文件变更列表、加速比） |

**核心架构**：

```
Parent Agent
  ├── spawn_agent { parallel: true, agents: [...] }
  │     └── SpawnGuard.canSpawn() → capacity check
  │     └── executeParallelAgents()
  │           ├── Agent A (coder, worktree isolated)
  │           ├── Agent B (reviewer, readonly tools)
  │           └── Agent C (explore, readonly tools)
  │
  ├── contextAssembly 每轮注入:
  │     ├── buildActiveAgentContext() → <active_subagents> XML
  │     └── drainCompletionNotifications() → <subagent_notification> XML
  │
  ├── wait_agent { agent_ids: [...] }
  ├── send_input { agent_id: "...", message: "..." }
  └── close_agent { agent_id: "..." }
```

**3 层任务识别**（自然语言触发，非硬提示词）：
1. 工具描述（静态）— spawn_agent description 中说明并行能力
2. 任务特征检测（动态）— complexKeywords + dimensionKeywords 匹配（中英双语）
3. 上下文自适应抑制（自适应）— 简单任务不建议拆分

---

## v0.16.53 新增模块

### 富文档结构化编辑（DocEdit, 2026-03-19）

| 模块 | 位置 | 描述 |
|------|------|------|
| **Excel 原子编辑** | `src/main/tools/excel/excelEdit.ts` | 14 种操作（set_cell/range/formula, insert/delete rows/columns, style, sheet 管理） |
| **Word 原子编辑** | `src/main/tools/modules/document/docEdit.ts` | 历史 7 种 Word 操作经 DocEdit native 入口承接，旧 `docxEdit.ts` 不再作为当前事实源 |
| **SnapshotManager** | `src/main/tools/document/snapshotManager.ts` | 统一文档快照层（创建/恢复/清理，最多 20 个/文件） |
| **DocEdit 统一入口** | `src/main/tools/modules/document/docEdit.ts` | 自动识别格式（.xlsx/.pptx/.docx）路由到对应引擎 |
| **PPT 编辑加固** | `src/main/tools/modules/network/pptEdit.ts` | +2 新操作（reorder_slides, update_notes），接入 SnapshotManager；生成/版式能力在 `src/main/tools/media/ppt/` |

**设计原则**：原子操作替代全量重写，~80% token 节省。编辑前自动快照到 `.doc-snapshots/`，失败自动回滚。对标悟空 RealDoc。

### Generative UI（2026-03-17）

| 模块 | 位置 | 描述 |
|------|------|------|
| **ChartBlock** | `src/renderer/.../MessageBubble/ChartBlock.tsx` | Recharts 6 种图表渲染（bar/line/area/pie/radar/scatter），暗色主题 |
| **GenerativeUIBlock** | `src/renderer/.../MessageBubble/GenerativeUIBlock.tsx` | 沙箱 iframe HTML 小程序渲染（sandbox="allow-scripts"） |
| **Generative UI Prompt** | `src/main/prompts/generativeUI.ts` | System Prompt 注入，教 AI 何时使用 chart vs generative_ui |
| **Artifact 类型** | `src/shared/types/message.ts` | 版本化可视化产物追踪（chart/generative_ui） |

**渲染路由**：MessageContent 的 markdown code block handler 检测 `chart` / `generative_ui` 语言标签，路由到对应 React 组件（与已有 `mermaid` 路由同一模式）。

### Combo Skills（组合技能）

| 模块 | 位置 | 描述 |
|------|------|------|
| **ComboSkillCard** | `src/renderer/.../ChatInput/ComboSkillCard.tsx` | 输入框中的组合技能卡片 UI |
| **Skill IPC** | `src/main/ipc/skill.ipc.ts` | Combo Skill 调度 |

### 文件资源管理器

| 模块 | 位置 | 描述 |
|------|------|------|
| **FileExplorerPanel** | `src/renderer/.../explorer/FileExplorerPanel.tsx` | 左侧文件树面板 |
| **Explorer Store** | `src/renderer/stores/explorerStore.ts` | 文件浏览器状态管理 |

### 对话搜索

| 模块 | 位置 | 描述 |
|------|------|------|
| **ChatSearchBar** | `src/renderer/.../chat/ChatSearchBar.tsx` | 对话内容搜索栏 |

---

## v0.16.52 新增模块

### 轻量记忆系统（Light Memory, 2026-03-15）

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
[4] (removed)              — 旧 RAG Context 已删除（v0.16.56）
[5] Current Session        — 滑动窗口
```

**设计原则**: 模型本身就是最好的记忆引擎。~700 行代码（含前端+IPC）+ prompt 替代旧 13K+ 行 vector/embedding 系统。

### 桌面活动视觉分析（2026-03-15）

| 模块 | 位置 | 描述 |
|------|------|------|
| **视觉分析器** | `src/main/services/desktopVisionAnalyzer.ts` | 后台轮询截图，调用智谱 GLM-4V-Plus 生成语义描述 |
| **Rust 采集增强** | `src-tauri/src/native_desktop.rs` | 截图 PNG→JPG（~80% 空间节省）、`analyze_text` 字段、SQLite 自动迁移 |
| **Tauri 命令** | `desktop_update_analyze_text` | Node 侧写回视觉分析结果到 Rust 管理的 SQLite |

### 架构清理与评测修复（2026-03-09 ~ 03-12）

| 改动 | 描述 |
|------|------|
| **AgentApplicationService** | IPC facade 解耦（`agentAppService.ts`），所有 IPC handler 不再直接依赖具体实现 |
| **agentLoop 拆分** | 4350 行单文件拆为 5 个 runtime 模块（`conversationRuntime.ts` 等），agentLoop 变为 thin wrapper |
| **循环依赖清零** | 114→15→9→0（madge 验证），sessionStore 拆分、IPC facade、bootstrap 4 模块拆分 |
| **死代码清理** | -13,654 行 agent 子系统 + -2,497 行 memory 模块，净减 ~16K 行 |
| **Disposable 扩展** | 11 个资源持有服务实现 Disposable 接口，gracefulShutdown 统一释放 |
| **Session 边界加固** | per-session IPC facade + Bridge session-aware + getter 副作用移除 |
| **评测生产隔离** | evaluation 模块 dynamic import + `EVAL_DISABLED` define，生产包不含评测代码 |
| **esbuild 统一** | 6 个独立 esbuild 命令合并为单一 `esbuild.config.ts` |

---

## v0.16+ 核心模块总览

以下为跨版本积累的核心模块（按能力域分组）。

### Agent 与多 Agent 协作

| 模块 | 位置 | 描述 |
|------|------|------|
| **混合 Agent 架构** | `src/main/agent/hybrid/` | 3 层：核心角色 + 动态扩展 + Swarm |
| **内置 Agent** | `src/shared/types/builtInAgents.ts` | 6+11 个预定义 Agent 角色 |
| **Agent 团队** | `src/main/agent/teammate/` | 持久化团队、生命周期管理（create/resume/snapshot/shutdown） |
| **SpawnGuard** | `src/main/agent/spawnGuard.ts` | 并发守卫（max 6 agents）+ 通知队列 + 消息队列 + 只读工具限制 |
| **Result Aggregator** | `src/main/agent/resultAggregator.ts` | 子代理结果聚合（文件提取、加速比计算、成本汇总） |
| **Active Agent Context** | `src/main/agent/activeAgentContext.ts` | 运行中子代理 XML 注入 + 异步完成通知 |
| **Agent Worktree** | `src/main/agent/agentWorktree.ts` | Git worktree 隔离（coder 角色独立分支，无变更自动清理） |
| **优雅关闭** | `src/main/agent/shutdownProtocol.ts` | 4 阶段关闭（Signal→Grace→Flush→Force） |
| **跨 Agent 审批** | `src/main/agent/planApproval.ts` | 高风险操作 plan → Coordinator 审批（可选） |
| **Adaptive Thinking** | `src/main/agent/agentLoop.ts` | InterleavedThinkingManager + effort 级别控制 |
| **Delegate 模式** | `src/main/agent/agentOrchestrator.ts` | Orchestrator 只分配不执行 |
| **h2A 实时转向** | `src/main/agent/agentLoop.ts` | `steer()` 注入用户消息，保留中间状态 |

### 工具与调度

| 模块 | 位置 | 描述 |
|------|------|------|
| **DAG 调度器** | `src/main/scheduler/` | 基于 DAG 的并行任务调度 |
| **工具 DAG** | `src/main/agent/toolExecution/dagScheduler.ts` | 文件依赖 DAG + Kahn 拓扑排序 |
| **ToolSearch** | `src/main/tools/gen4/toolSearch.ts` | 延迟加载工具发现机制 |
| **Checkpoint** | `src/main/services/FileCheckpointService.ts` | 文件版本快照与回滚 |
| **Skills 系统** | `src/main/skills/` | 用户可定义技能 + 数据清洗 Skill |

### 上下文与记忆

| 模块 | 位置 | 描述 |
|------|------|------|
| **投影式上下文管理** | `src/main/context/` | 6 层压缩管线（tool-result budget → snip → microcompact → contextCollapse → autocompact → overflow recovery），投影架构：transcript 不可变，CompressionState 追踪，ProjectionEngine 查询时生成 API 视图 |
| **文档上下文** | `src/main/context/documentContext/` | 统一文档理解层，5 种解析器 |
| **DataFingerprint** | `src/main/tools/dataFingerprint.ts` | 源数据锚定（xlsx schema + CSV/JSON schema） |
| **FileReadTracker** | `src/main/tools/fileReadTracker.ts` | 文件读取记录，支持编辑验证和恢复上下文 |

### 模型与路由

| 模块 | 位置 | 描述 |
|------|------|------|
| **自适应路由** | `src/main/model/adaptiveRouter.ts` | 简单任务 → glm-4-flash（免费），失败原因感知 fallback（overflow→更大窗口，rate_limit→换 provider） |
| **推理缓存** | `src/main/model/inferenceCache.ts` | LRU 缓存（50 条，5min TTL） |
| **错误恢复引擎** | `src/main/errors/recoveryEngine.ts` | 6 种错误模式自动恢复 |
| **Moonshot Provider** | `src/main/model/providers/moonshot.ts` | Kimi K2.5 / Kimi K2.6 SSE 流式支持 |

### 工程能力

| 模块 | 位置 | 描述 |
|------|------|------|
| **引用溯源** | `src/main/services/citation/` | 自动提取引用（文件行号/URL/单元格） |
| **确认门控** | `src/main/agent/confirmationGate.ts` | 写操作前 diff 预览 + 确认 |
| **变更追踪** | `src/main/services/diff/diffTracker.ts` | 结构化 unified diff |
| **模型热切换** | `src/main/session/modelSessionState.ts` | 对话中途切换模型 |
| **安全校验** | `src/main/security/inputSanitizer.ts` | prompt injection 检测 |

### 评测系统

| 模块 | 位置 | 描述 |
|------|------|------|
| **评测双管道** | `src/main/evaluation/` | Pipeline A: 会话评测, Pipeline B: 用例执行 |
| **Session Replay** | `src/main/evaluation/replayService.ts` | 结构化会话回放 |
| **SwissCheese 评估器** | `src/main/evaluation/swissCheeseEvaluator.ts` | 多维评分 + 权重归一化 |
| **Eval Harness** | `packages/eval-harness/` | 外部评测框架 |

### 基础设施

| 模块 | 位置 | 描述 |
|------|------|------|
| **统一配置** | `src/main/config/configPaths.ts` | `.code-agent/` 配置目录结构 |
| **基础设施服务** | `src/main/services/infra/` | 磁盘监控、文件日志（NDJSON + 按日轮转）、优雅关闭 |
| **CLI 运行时** | `src/cli/` | 5 模式（chat/run/serve/exec-tool/mcp-server）、CLIAgent 适配层 |
| **多渠道接入** | `src/main/channels/` | 飞书 Webhook 等渠道支持 |

---

## Local Bridge 服务

为 Web 端提供本地能力的桥接服务，通过 HTTP + WebSocket 在 localhost:9527 运行。

### 工具清单（三级权限）

| 级别 | 权限 | 工具 |
|------|------|------|
| L1 只读 | 自动执行 | file_read, file_glob, file_grep, directory_list, clipboard_read, system_info |
| L2 写入 | 需确认 | file_write, file_edit, file_download, open_file |
| L3 执行 | 白名单+确认 | shell_exec, process_manage |

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

---

## 版本演进摘要

<details>
<summary>v0.16.16 ~ v0.16.42 历史版本（点击展开）</summary>

| 版本 | 主题 | 关键变更 |
|------|------|----------|
| **v0.16.16** | 基础设施 | 统一配置目录 `.code-agent/`、Moonshot Provider、记忆衰减、Few-shot 示例、原子写入 |
| **v0.16.18** | 评测体系 | 混合 Agent 架构、统一 Identity（token -81%）、评测双管道、SwissCheese 评估器、Logger 文件落盘 |
| **v0.16.19** | 工程能力 E1-E6 | 引用溯源、确认门控、变更追踪、模型热切换、文档上下文、安全校验、PPT 9 模块声明式重构 |
| **v0.16.20** | 对标 Claude Code | 增强型 Compaction、Agent Teams P2P 通信、Delegate 模式、Adaptive Thinking、DeepSeek Thinking UI |
| **v0.16.21** | 健壮性 | h2A 实时转向、TaskListManager、Compaction 恢复、溢出自动重试、动态 Bash 描述 |
| **v0.16.22** | 成本优化 | 推理缓存、自适应路由（免费模型）、错误恢复引擎、工具 DAG 调度、Prompt 精简 -20% |
| **v0.16.37** | 多 Agent 增强 | 持久化团队、优雅关闭 4 阶段、子 Agent 任务自管理、跨 Agent 审批、DataFingerprint 源数据锚定 |
| **v0.16.42** | 分层压缩 | L1 Observation Masking → L2 Truncate → L3 AI Summary 三层递进压缩 |
| **v0.16.53** | 富文档编辑 | DocEdit 统一入口、Excel 14 操作、Word 7 操作、PPT 编辑加固、SnapshotManager |
| **v0.16.55** | Agent Team | SpawnGuard 并发守卫、并行多代理执行、Git Worktree 隔离、异步完成通知、结果聚合 |
| **v0.16.57** | 架构对齐 | 投影式上下文管理（6 层压缩）、Prompt 矩阵（4 Profile × 5 Overlay）、GuardFabric 多源权限、事件三通道、Worker Epoch、多模型差异化路由、Operator Surface |
| **v0.16.66** | Agent Runtime Hardening | run lifecycle 终态、run-level abort、TaskManager-owned chat、MCP direct execute、Skill trust gate、multiagent reliability、structured replay gate |
| **v0.16.71** | Hardening + 评测扩面 + Design Brief | Tauri updater 安全 (M6.a/b)、EventBus & dispatch 归位、调试快照体系 (ADR-014)、本地 Ollama 评测 (ADR-013)、SWE-bench docker harness (ADR-015)、小米 MiMo provider + 默认模型切换、Design Brief 生产化 (Phase A→C.3)、Workspace Preview Panel、Channel inbox/outbox |
| **v0.16.72-73** | Native protocol + acceptance + isolation + quality gates | Level 1 native tool migration wave1-4、Runtime/Web/Context hardening、Artifact repair toolkit、Game/Deck/Dashboard verifier、Browser/Computer multi-agent isolation、typed IPC、provider wrappers/symmetry、async/god-file/cleanup |
| **v0.16.74** | Prompt / Hook / Rewind | Prompt Manager + 实时 override、Hook Settings tab、Hook Activity turn timeline、CLI hooks 默认启用、Chat workspace defaults、Prompt Rewind + session_rewinds 审计 |

</details>

---

## 如何使用本文档

1. **新人入门**: 先阅读 [系统概览](./architecture/overview.md)
2. **开发功能**: 查阅对应模块的详细文档
3. **理解决策**: 查看 [ADR](./decisions/) 了解架构决策背景
4. **贡献代码**: 遵循各文档中的设计原则

## 更多文档

- [Release Notes](./releases/) — 版本发布记录
- [工具参考手册](./guides/tools-reference.md) — 全部工具的完整文档
- [模型配置矩阵](./guides/model-config.md) — 模型路由与配置
- [评测系统指南](./guides/evaluation-system.md) — 评测工程详细文档
- [ADR-005: Eval Engineering](./decisions/005-eval-engineering.md) — 评测关键工程决策
