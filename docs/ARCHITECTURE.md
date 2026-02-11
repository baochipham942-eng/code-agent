# Code Agent - 架构设计文档

> 版本: 5.7 (对应 v0.16.37)
> 日期: 2026-02-11
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
| **Prompt 精简** | `src/main/generation/prompts/base/gen8.ts` | tool table 再压缩 ~20% |
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
| **统一 Identity** | `src/main/generation/prompts/identity.ts` | 替代 constitution/ 的 6 文件，token -81% |
| **上下文压缩** | `src/main/context/autoCompressor.ts` | 自动上下文压缩 |
| **并行评估** | `src/main/evaluation/parallelEvaluator.ts` | 并行会话评估 |

### v0.16.16+ 新增模块

| 模块 | 位置 | 描述 |
|------|------|------|
| **统一配置目录** | `src/main/config/configPaths.ts` | `.code-agent/` 配置目录结构 |
| **基础设施服务** | `src/main/services/infra/` | 磁盘监控、文件日志、优雅关闭 |
| **错误学习系统** | `src/main/memory/errorLearning.ts` | 错误模式学习与避免 |
| **记忆衰减** | `src/main/memory/memoryDecay.ts` | 基于时间的记忆权重衰减 |
| **动态提醒** | `src/main/generation/prompts/dynamicReminders.ts` | 上下文感知的动态提示 |
| **Few-shot 示例** | `src/main/generation/prompts/fewShotExamples.ts` | 任务类型示例管理 |
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

---

## 快速参考

### 技术栈

| 层级 | 技术选型 |
|------|----------|
| 桌面框架 | Electron 38+ |
| 前端框架 | React 18 + TypeScript 5.6 |
| 状态管理 | Zustand 5 |
| 样式 | Tailwind CSS 3.4 |
| 本地存储 | SQLite (better-sqlite3) |
| 云端存储 | Supabase + pgvector |
| AI 模型 | Moonshot Kimi K2.5 (主要), 智谱/DeepSeek (备用) |

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
│   ├── main/                    # Electron 主进程
│   │   ├── agent/              # AgentOrchestrator, AgentLoop
│   │   ├── generation/         # GenerationManager
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
