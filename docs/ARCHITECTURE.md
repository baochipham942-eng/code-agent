# Code Agent - 架构设计文档

> 版本: 9.1 (对应 v0.16.59)
> 日期: 2026-04-11
> 作者: Lin Chen

本文档是 Code Agent 项目的**架构索引入口**。详细设计已拆分为模块化文档，本文提供导航、快速参考和版本演进概要。

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
| [多 Agent 编排](./architecture/multiagent-system.md) | Agent Team 并行执行、SpawnGuard、异步通知（历史设计 + 实现指引） |
| [CLI 架构](./architecture/cli.md) | 5 种运行模式、CLIAgent 适配层、输出格式化、命令系统 |

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
| 桌面框架 | Tauri 2.x (Rust) |
| 前端框架 | React 18 + TypeScript 5.6 |
| 状态管理 | Zustand 5 |
| 样式 | Tailwind CSS 3.4 |
| 构建 | esbuild (main) + Vite (renderer) |
| 本地存储 | SQLite (better-sqlite3) |
| 云端存储 | Supabase + pgvector |
| AI 模型 | Kimi K2.5 (主要), 智谱/DeepSeek/OpenAI/火山引擎 (备用), Local/Ollama (本地) |
| 本地桥接 | packages/bridge (localhost:9527) |

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
│   │   ├── hooks/              # 用户可配置钩子系统（Agent Hook + 内置 Hook）
│   │   ├── ipc/                # IPC handler 层（前后端通信桥梁，含 provider.ipc.ts 连通性测试+诊断+健康状态）
│   │   ├── model/              # ModelRouter, Provider, 自适应路由, 智能 Fallback, HealthMonitor, 请求规范化中间件
│   │   ├── permissions/        # 权限矩阵（GuardFabric 多源竞争 + PolicyEngine + 拓扑感知）
│   │   ├── platform/           # 平台抽象层（Tauri/Electron/Web 差异封装）
│   │   ├── prompts/            # Prompt 矩阵（4 Profile × 5 层 Overlay + 缓存稳定性）
│   │   ├── routing/            # Agent 路由系统（意图分类 + 路由决策）
│   │   ├── security/           # 运行时安全（命令监控、敏感信息检测、审计日志）
│   │   ├── services/           # 核心服务（Auth, Sync, Database, SecureStorage, 引用溯源）
│   │   ├── session/            # 会话管理（Worker Epoch 生成代围栏、快照重物化、导出、分叉、恢复）
│   │   ├── tools/              # gen1-gen8 工具实现 + DocEdit
│   │   │
│   │   │── ── 智能层 ──────────────────────────────
│   │   ├── cloud/              # 云端任务服务（任务路由、混合调度、加密同步）
│   │   ├── cron/               # 定时任务与心跳监控
│   │   ├── evaluation/         # 评测双管道 + Session Replay
│   │   ├── desktop/            # 桌面活动服务（从旧 memory/ 搬迁）
│   │   ├── lightMemory/        # Light Memory 系统（File-as-Memory, ~700 行，唯一记忆系统）
│   │   ├── orchestrator/       # 云端任务执行编排器（Orchestrator 配置与调度）
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
│   ├── shared/                 # 类型定义、常量、IPC 协议
│   ├── cli/                    # CLI 接口（独立构建入口）
│   └── web/                    # Web Server（SSE API + 路由）
│
├── src-tauri/                   # Tauri Rust Shell
├── packages/
│   ├── bridge/                  # Local Bridge 服务 (localhost:9527)
│   └── eval-harness/            # 评测 Harness
├── vercel-api/                  # 云端 API (Vercel)
└── supabase/                    # 数据库迁移
```

### 8 代工具演进

| 代际 | 核心能力 | 工具集 |
|------|----------|--------|
| Gen1 | 基础文件操作 | bash, read_file, write_file, edit_file |
| Gen2 | 代码搜索 | + glob, grep, list_directory, mcp |
| Gen3 | 任务规划 | + task, todo_write, ask_user_question |
| Gen4 | 网络能力 | + skill, web_fetch, **web_search** |
| Gen5 | 记忆系统 | + memory_store, memory_search |
| Gen6 | 视觉交互 | + screenshot, computer_use |
| Gen7 | 多代理 | + spawn_agent, agent_message, wait_agent, close_agent, send_input |
| Gen8 | 自我进化 | + strategy_optimize, tool_create |

> **Phase 2 工具合并**: 31 个延迟加载工具合并为 9 个统一工具（Process, MCPUnified, TaskManager, Plan, PlanMode, WebFetch, ReadDocument, Browser, Computer），使用 action 参数分发。TOOL_ALIASES 兼容层已删除（v0.16.56），所有代码统一使用 PascalCase。详见 [ADR-006](./decisions/006-deferred-tools-consolidation.md)。
>
> **Phase 3 文档编辑统一**: DocEdit 统一入口 + ExcelAutomate(edit) + ppt_edit 加固。富文档从全量生成升级为原子级增量编辑（Excel 14 操作 / PPT 8 操作 / Word 7 操作），SnapshotManager 提供快照回滚。

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
| **Word 原子编辑** | `src/main/tools/document/docxEdit.ts` | 7 种操作（replace_text, replace/insert/delete/append paragraph, heading, text style） |
| **SnapshotManager** | `src/main/tools/document/snapshotManager.ts` | 统一文档快照层（创建/恢复/清理，最多 20 个/文件） |
| **DocEdit 统一入口** | `src/main/tools/document/docEditTool.ts` | 自动识别格式（.xlsx/.pptx/.docx）路由到对应引擎 |
| **PPT 编辑加固** | `src/main/tools/network/ppt/editTool.ts` | +2 新操作（reorder_slides, update_notes），接入 SnapshotManager |

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
| **Moonshot Provider** | `src/main/model/providers/moonshot.ts` | Kimi K2.5 SSE 流式支持 |

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
