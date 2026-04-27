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
│  │  │ Chat View    │ │WorkbenchTabs │ │ Live Preview │ │ Settings    │  │  │
│  │  │ + Trace UI   │ │Task/Skills/  │ │ + TweakPanel │ │Conversation │  │  │
│  │  │              │ │Files/Preview │ │              │ │Activity     │  │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └─────────────┘  │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌─────────────┐  │  │
│  │  │Sidebar User  │ │Semantic Tool │ │ GenerativeUI │ │Automation   │  │  │
│  │  │Menu          │ │UI + Citation │ │ + ChartBlock │ │/Cron Center │  │  │
│  │  └──────────────┘ └──────────────┘ └──────────────┘ └─────────────┘  │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                            │ Platform Abstraction                            │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                   Application Layer (Node.js webServer)                │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │                      Agent Orchestrator                          │ │  │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐  │ │  │
│  │  │  │Runtime     │ │   Model    │ │ToolExec /  │ │TaskManager  │  │ │  │
│  │  │  │Lifecycle   │ │  Router    │ │MCP Resolver│ │Run Owner    │  │ │  │
│  │  │  └────────────┘ └────────────┘ └────────────┘ └─────────────┘  │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  │  ┌──────────────────────────────────────────────────────────────────┐ │  │
│  │  │                      Core Subsystems                             │ │  │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐  │ │  │
│  │  │  │   Light    │ │   Skills   │ │  Platform  │ │  System     │  │ │  │
│  │  │  │  Memory    │ │   System   │ │ Abstraction│ │   Tray      │  │ │  │
│  │  │  └────────────┘ └────────────┘ └────────────┘ └─────────────┘  │ │  │
│  │  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌─────────────┐  │ │  │
│  │  │  │Durable Run │ │Structured  │ │Telemetry / │ │Review Queue │  │ │  │
│  │  │  │State       │ │Replay      │ │Eval Gate   │ │             │  │ │  │
│  │  │  └────────────┘ └────────────┘ └────────────┘ └─────────────┘  │ │  │
│  │  └──────────────────────────────────────────────────────────────────┘ │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                      Tool Layer (96+ 工具, 9 类)                       │  │
│  │                                                                        │  │
│  │  Shell & 文件    规划 & 任务      文档 & 媒体      多 Agent            │  │
│  │  ┌──────────┐   ┌──────────┐    ┌──────────┐    ┌──────────┐         │  │
│  │  │Bash,Read │   │Task,Plan │    │DocEdit   │    │AgentSpawn│         │  │
│  │  │Write,Edit│   │PlanMode  │    │Excel,PPT │    │WaitAgent │         │  │
│  │  │Glob,Grep │   │AskUser   │    │Image,PDF │    │Teammate  │         │  │
│  │  └──────────┘   └──────────┘    └──────────┘    └──────────┘         │  │
│  │  Web & 搜索     连接器           视觉 & 浏览器   记忆                  │  │
│  │  ┌──────────┐   ┌──────────┐    ┌──────────┐    ┌──────────┐         │  │
│  │  │WebSearch │   │Calendar  │    │Computer  │    │Memory    │         │  │
│  │  │WebFetch  │   │Mail      │    │Browser   │    │Write/Read│         │  │
│  │  │ReadDoc   │   │Reminders │    │GuiAgent  │    │          │         │  │
│  │  └──────────┘   └──────────┘    └──────────┘    └──────────┘         │  │
│  │                                                                        │  │
│  │  ┌─────────────────────────────────────────────────────────────────┐   │  │
│  │  │  15 核心工具 (始终可见) + 81+ 延迟工具 (ToolSearch 按需加载)      │   │  │
│  │  │  统一入口: Process, MCPUnified, DocEdit, ExcelAutomate 等        │   │  │
│  │  └─────────────────────────────────────────────────────────────────┘   │  │
│  └───────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
│  ┌───────────────────────────────────────────────────────────────────────┐  │
│  │                         External Layer                                 │  │
│  │  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌───────────────────┐  │  │
│  │  │  GPT-5.5   │ │  Kimi K2.6 │ │  DeepSeek  │ │  Claude / GLM    │  │  │
│  │  │  (primary) │ │  (router)  │ │  (router)  │ │    (fallback)    │  │  │
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
| **AI 模型** | GPT-5.5 / DeepSeek V4 / Kimi K2.6 / 智谱 / Claude / Ollama | 多模型路由 |

## 2026-04-27 当前架构增量

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Agent run lifecycle | `ConversationRuntime` 统一 terminal path，failure/cancel/interrupted 都经 `RunFinalizer`；`agent_cancelled` 不再伪装成 complete | [agent-core.md](./agent-core.md) |
| TaskManager-owned chat run | `AgentAppService.sendMessage` 走 TaskManager-owned send，pause/resume/cancel/interrupt 尽量对齐同一个 run owner | [agent-core.md](./agent-core.md) |
| Tool/MCP 权限合同 | ToolExecutor 顶层审批结果向 resolver 传递，MCP dynamic tool 可 direct execute，ToolSearch 对不可调用项返回 `loadable:false` 和原因 | [tool-system.md](./tool-system.md) |
| Durable runtime state | todos、session tasks、context interventions、compression state、persistent system context、pending approvals 按 session 落 SQLite | [data-storage.md](./data-storage.md) |
| Multiagent reliability | parallel inbox、success-only dependency gate、failed/blocked/cancelled aggregation、run-level cancel 已有定向测试 | [multiagent-system.md](./multiagent-system.md) |
| Replay / eval completeness | structured replay 关联 model/tool/event evidence；`real-agent-run` eval gate 校验 `telemetryCompleteness` | [agent-core.md](./agent-core.md) |

## 2026-04-26 当前架构增量

| 能力域 | 当前形态 | 详细文档 |
|------|----------|----------|
| Workbench B+ | ChatInput 保留高频发送动作，低频动作收进 `+`；Routing / Browser 归到 Settings “对话”tab；TitleBar 瘦身，全局页面入口进入 Sidebar User Menu | [workbench.md](./workbench.md) |
| Live Preview V2 | Vite-only MVP：devServerManager + DevServerLauncher + click-to-source + protocol 0.3.0 + TweakPanel；Next.js App Router 支持按 ADR-012 延期 | [ADR-012](../decisions/012-live-preview-v2-c-deferred.md) |
| Browser / Computer Workbench | in-app managed browser 具备 session/profile/account/artifact/lease/proxy/TargetRef；Computer Surface 具备 background AX / CGEvent 受控验证路径 | [browser-computer-workbench-smoke.md](../acceptance/browser-computer-workbench-smoke.md) |
| Activity Providers | OpenChronicle、Tauri Native Desktop、audio、screenshot-analysis 统一输出 `ActivityContext`，由 prompt formatter 控制注入 | [activity-providers.md](./activity-providers.md) |
| Semantic Tool UI | `_meta.shortDescription` 从 prompt/schema/provider/parser 到 ToolCall UI 打通，弱模型缺失时有 fallback generator；Memory citation / diff summary / URL chip 进入聊天展示层 | [workbench.md](./workbench.md) |

## 分层架构

| 层级 | 职责 | 详细文档 |
|------|------|----------|
| Presentation | UI 组件、状态管理、Generative UI、用户交互 | [frontend.md](./frontend.md) |
| Application | Agent 编排、平台抽象、Light Memory、Skills 系统 | [agent-core.md](./agent-core.md) |
| Tool | 96+ 个工具（9 类），Core/Deferred 双层、统一入口 | [tool-system.md](./tool-system.md) |
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
| **Activity Providers** | `src/main/services/activity/` + `src/shared/contract/activity*.ts` | 统一 OpenChronicle / Tauri Native Desktop / audio / screenshot-analysis 的上下文来源和注入边界 |
| **Live Preview V2** | `src/main/services/infra/devServerManager.ts` + `src/renderer/components/LivePreview/` | 自动启动本地 dev server、iframe source grounding、TweakPanel 原子样式编辑 |
| **Browser / Computer Workbench** | `src/main/services/infra/browserService.ts` + `src/main/services/desktop/` | 托管浏览器会话、TargetRef、artifact、Computer Surface 安全动作面 |

## 工具体系（96+ 个注册工具）

15 个核心工具始终发送给模型，其余通过 ToolSearch 按需加载。按功能分为 9 类：

| 分类 | 数量 | 代表工具 |
|------|------|----------|
| Shell & 文件 | 14 | Bash, Read, Write, Edit, Glob, Grep, GitCommit |
| 规划 & 任务 | 12 | TaskManager, Plan, PlanMode, AskUserQuestion |
| Web & 搜索 | 5 | WebSearch, WebFetch, ReadDocument, LSP |
| 文档 & 媒体 | 23 | DocEdit, ExcelAutomate, PPT, Image/Video/Chart |
| 外部服务连接器 | 13 | Jira, GitHubPR, Calendar, Mail, Reminders |
| 记忆 | 2 | MemoryWrite, MemoryRead |
| 视觉 & 浏览器 | 5+ | Computer, Browser, GuiAgent, visual_edit, Live Preview IPC |
| 多 Agent | 9 | AgentSpawn, AgentMessage, WaitAgent, Teammate |
| 统一入口 + 元工具 | 13 | Process, MCPUnified, DocEdit, ToolSearch |

> **统一入口**：细粒度工具通过 action 参数合并（如 ReadDocument 合并 read_pdf/read_docx/read_xlsx）。
>
> **DocEdit**：自动识别格式（.xlsx/.pptx/.docx）路由到对应编辑引擎，原子操作替代全量重写。

## 相关文档

- [Agent 核心](./agent-core.md) - AgentLoop、消息流、规划系统
- [工具系统](./tool-system.md) - 工具注册、执行、分类
- [前端架构](./frontend.md) - React 组件、状态管理
- [数据存储](./data-storage.md) - SQLite、Supabase、向量数据库
- [云端架构](./cloud-architecture.md) - 云端任务、多设备同步
- [架构决策记录](../decisions/) - ADR 文档
