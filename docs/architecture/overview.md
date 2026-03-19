# 系统架构概览

> 本文档提供 Code Agent 的高层架构视图

## 整体架构图

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Code Agent Architecture (Tauri 2.x)                  │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                    Presentation Layer (React 18)                       │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐  │  │
│  │  │  Chat View   │ │ FileExplorer │ │ ChatSearch   │ │  Settings   │  │  │
│  │  │  + Trace     │ │    Panel     │ │    Bar       │ │   Panel     │  │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └─────────────┘  │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐  │  │
│  │  │ MemoFloater  │ │ GenerativeUI │ │ ComboSkills  │ │ CronCenter  │  │  │
│  │  │              │ │ + ChartBlock │ │              │ │   Panel     │  │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └─────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                            │ Platform Abstraction                            │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                   Application Layer (Node.js webServer)                │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │                      Agent Orchestrator                          │ │  │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐  │ │  │
│  │  │  │ Generation │ │   Model    │ │   Tool     │ │  Session    │  │ │  │
│  │  │  │  Manager   │ │  Router    │ │  Registry  │ │  Manager    │  │ │  │
│  │  │  └────────────┘ └────────────┘ └────────────┘ └─────────────┘  │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │                      Core Subsystems                             │ │  │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐  │ │  │
│  │  │  │   Light    │ │   Skills   │ │  Platform  │ │  System     │  │ │  │
│  │  │  │  Memory    │ │   System   │ │ Abstraction│ │   Tray      │  │ │  │
│  │  │  └────────────┘ └────────────┘ └────────────┘ └─────────────┘  │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                           Tool Layer                                   │  │
│  │                                                                        │  │
│  │  Gen1-2 基础     Gen3-4 规划+网络   Gen5-6 记忆+视觉   Gen7-8 多Agent  │  │
│  │  ┌──────────┐   ┌──────────┐       ┌──────────┐      ┌──────────┐    │  │
│  │  │bash,read │   │task,skill│       │memory    │      │spawn_    │    │  │
│  │  │write,edit│   │web_fetch │       │screenshot│      │agent     │    │  │
│  │  │glob,grep │   │web_search│       │computer  │      │strategy  │    │  │
│  │  └──────────┘   └──────────┘       └──────────┘      └──────────┘    │  │
│  │                                                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │  DocEdit 统一入口 (Excel 14ops / PPT 8ops / Word 7ops)          │   │  │
│  │  │  Deferred Tools: 31→9 统一工具 (action 参数分发)                  │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         External Layer                                 │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌───────────────────┐  │  │
│  │  │  Kimi K2.5 │ │  智谱 GLM  │ │  DeepSeek  │ │ OpenAI / Claude  │  │  │
│  │  │  (primary) │ │  (backup)  │ │  (backup)  │ │    (backup)      │  │  │
│  │  └────────────┘ └────────────┘ └────────────┘ └───────────────────┘  │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐                       │  │
│  │  │   Ollama   │ │   File     │ │  Network   │                       │  │
│  │  │(本地 Vision)│ │  System    │ │  (HTTP)    │                       │  │
│  │  └────────────┘ └────────────┘ └────────────┘                       │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 三端产品形态

```
┌─ Web 端（浏览器）──────────────────────┐
│  React 18 + Vite                       │
│  云端功能 → webServer API              │
│  本地功能 → Bridge (localhost:9527)     │
└────────────────────────────────────────┘
┌─ App 端（Tauri 2.x）──────────────────┐
│  Rust Shell → spawn Node.js webServer  │
│  原生自动更新 + capabilities 权限模型   │
│  完整本地能力（文件/Shell/进程/Vision） │
│  DMG ~33MB（vs Electron 742MB）        │
└────────────────────────────────────────┘
┌─ CLI 端 ──────────────────────────────┐
│  Node.js 单文件 (esbuild)             │
│  适合极客和 Agent 调用                 │
└────────────────────────────────────────┘
```

## 技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| **桌面框架** | Tauri 2.x (Rust) | 替代 Electron，DMG 95% 缩减 |
| **前端框架** | React 18 + TypeScript 5.6 | 组件化开发 |
| **状态管理** | Zustand 5 | 轻量级状态管理 |
| **UI 组件** | Tailwind CSS 3.4 | 快速开发 |
| **构建工具** | esbuild (main/preload) + Vite (renderer) | 双构建管线 |
| **IPC 通信** | Platform Abstraction Layer (`src/main/platform/`) | 统一替代直接 Electron 导入，跨平台兼容 |
| **本地存储** | SQLite (better-sqlite3) | 会话/配置持久化 |
| **云端存储** | Supabase + pgvector | 同步 + 向量存储 |
| **AI 模型** | Kimi K2.5 (主要), 智谱/DeepSeek/OpenAI (备用), Ollama (本地 Vision) | 多模型路由 |

## 分层架构

| 层级 | 职责 | 详细文档 |
|------|------|----------|
| Presentation | UI 组件、状态管理、Generative UI、用户交互 | [frontend.md](./frontend.md) |
| Application | Agent 编排、平台抽象、Light Memory、Skills 系统 | [agent-core.md](./agent-core.md) |
| Tool | 工具实现、代际演进、DocEdit 统一入口、Deferred Tools | [tool-system.md](./tool-system.md) |
| Data | 本地存储、云端同步 | [data-storage.md](./data-storage.md) |
| Cloud | 云端任务、多设备同步 | [cloud-architecture.md](./cloud-architecture.md) |

## 平台抽象层

`src/main/platform/` 是连接前后端的关键层，统一替代所有直接 Electron 导入：

| 模块 | 文件 | 职责 |
|------|------|------|
| App 路径 | `appPaths.ts` | 统一的应用路径和生命周期 API |
| IPC 注册 | `ipcRegistry.ts` | Handler 注册中心，跨平台 IPC 抽象 |
| Window 桥接 | `windowBridge.ts` | 渲染进程通信（broadcastToRenderer） |
| Native Shell | `nativeShell.ts` | 打开外部链接、文件 |
| 剪贴板 | `nativeClipboard.ts` | 读写剪贴板 |
| 通知/快捷键 | `notifications.ts` / `globalShortcuts.ts` | 系统级交互 |
| 兼容层 | `miscCompat.ts` | dialog, Tray, Menu 等 Electron API 兼容 |

所有业务代码通过 `import { ... } from '../platform'` 引入，不直接依赖 Electron 或 Tauri API。

## 新增子系统（v0.16.52+）

| 子系统 | 位置 | 说明 |
|--------|------|------|
| **Light Memory** | `src/main/lightMemory/` | File-as-Memory，~700 行代码替代旧 13K+ 行 vector/embedding 系统。6 层上下文注入 |
| **Generative UI** | renderer `MessageBubble/` | ChartBlock（6 种 Recharts 图表）+ GenerativeUIBlock（沙箱 iframe HTML 小程序） |
| **Combo Skills** | `src/main/skills/` | 用户可定义技能，关键词自动匹配 |
| **System Tray** | platform `miscCompat.ts` → Tray | 系统托盘集成 |
| **Desktop Vision** | `desktopVisionAnalyzer.ts` + Rust FFI | 后台截图 + 视觉模型语义描述（Ollama 本地 / 智谱云端） |
| **Cron Center** | renderer `features/cron/` | 定时任务管理面板 |

## 8 代工具演进

| 代际 | 核心能力 | 工具集 |
|------|----------|--------|
| Gen1 | 基础文件操作 | bash, read_file, write_file, edit_file |
| Gen2 | 代码搜索 | + glob, grep, list_directory, mcp |
| Gen3 | 任务规划 | + task, todo_write, ask_user_question, plan_mode |
| Gen4 | 网络能力 | + skill, web_fetch, web_search, hooks |
| Gen5 | 记忆系统 | + memory_store, memory_search, code_index |
| Gen6 | 视觉交互 | + screenshot, computer_use, browser_action |
| Gen7 | 多代理 | + spawn_agent, agent_message, workflow_orchestrate |
| Gen8 | 自我进化 | + strategy_optimize, tool_create, self_evaluate |

> **Deferred Tools 合并（Phase 2）**：31 个延迟加载工具合并为 9 个统一工具（Process, MCPUnified, TaskManager, Plan, PlanMode, WebFetch, ReadDocument, Browser, Computer），使用 action 参数分发。旧名通过 TOOL_ALIASES 保持兼容。
>
> **DocEdit 统一入口（Phase 3）**：自动识别格式（.xlsx/.pptx/.docx）路由到对应编辑引擎。Excel 14 操作 / PPT 8 操作 / Word 7 操作，原子操作替代全量重写。

## 相关文档

- [Agent 核心](./agent-core.md) - AgentLoop、消息流、规划系统
- [工具系统](./tool-system.md) - 工具注册、执行、代际演进
- [前端架构](./frontend.md) - React 组件、状态管理
- [数据存储](./data-storage.md) - SQLite、Supabase、向量数据库
- [云端架构](./cloud-architecture.md) - 云端任务、多设备同步
- [架构决策记录](../decisions/) - ADR 文档
