# Code Agent - 架构设计文档

> 版本: 4.0 (对应 v0.16.8)
> 日期: 2026-01-26
> 作者: Lin Chen

本文档已拆分为模块化的架构文档，便于维护和查阅。

---

## 文档导航

### 核心架构

| 文档 | 描述 |
|------|------|
| [系统概览](./architecture/overview.md) | 整体架构图、技术栈、分层设计 |
| [Agent 核心](./architecture/agent-core.md) | AgentLoop、消息流、规划系统、Anti-pattern Detection |
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
| **内置 Agent** | `src/shared/types/builtInAgents.ts` | 6 个预定义 Agent 角色 |

### 架构决策记录 (ADR)

| ADR | 标题 | 状态 |
|-----|------|------|
| [001](./decisions/001-turn-based-messaging.md) | Turn-Based 消息流架构 | accepted |
| [002](./decisions/002-eight-generation-tool-evolution.md) | 8 代工具演进策略 | accepted |
| [003](./decisions/003-cloud-local-hybrid-architecture.md) | 云端-本地混合执行架构 | accepted |

---

## 快速参考

### 技术栈

| 层级 | 技术选型 |
|------|----------|
| 桌面框架 | Electron 33+ |
| 前端框架 | React 18 + TypeScript 5.6 |
| 状态管理 | Zustand 5 |
| 样式 | Tailwind CSS 3.4 |
| 本地存储 | SQLite (better-sqlite3) |
| 云端存储 | Supabase + pgvector |
| AI 模型 | DeepSeek API (主要) |

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
