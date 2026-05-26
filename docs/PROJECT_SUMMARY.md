# Agent Neo / Code Agent 项目总结

> 版本: 2.1
> 日期: 2026-05-26
> 作者: Lin Chen

---

## 项目概述

**Agent Neo** 是一个 Tauri + React 的多模型生活 / 工作 AI 助手。它保留 Code Agent 仓库早期的编程、文件、终端和评测能力，同时把产品主线推进到聊天原生工作台、可验收 artifact、托管浏览器/桌面执行、记忆管理、能力中心、外部 Agent Engine 和本地优先的模型配置。

`Code Agent` 仍是代码仓库、历史包名和早期文档名；`Agent Neo` 是 2026-05-16 起的产品品牌。

### 核心目标

| 目标 | 描述 | 状态 |
|------|------|------|
| **本地执行** | 文件、Shell、Git、浏览器、桌面和 artifact 验证都优先落在本机 runtime | ✅ 已产品化 |
| **聊天原生工作台** | Task / Skills / Files / Preview / Browser / Validation 收敛到聊天右侧工作面 | ✅ 已产品化 |
| **模型与 Agent 选择** | 14+ Provider 本地 API Key 配置，Native Agent Neo / Codex CLI / Claude Code 受控切换 | ✅ 已产品化 |
| **质量闭环** | Swiss Cheese 评测、artifact acceptance、Delivery Review、Preview Feedback 和 Review Queue | ✅ 已产品化 |
| **记忆系统** | Light Memory + 记忆导入、条目管理、注入 trace 和 Knowledge Memory Audit | ✅ 已产品化 |
| **能力中心** | Skill / MCP template / tool bundle / channel / workflow / connector / agent engine 本地货架 | ✅ P0 完成 |
| **云端同步与管理** | Supabase 认证、同步、管理员用户 dashboard、邀请码管理、显式 grants | ✅ 已接入 |
| **分发安全** | release security scan、关闭第一方 sourcemap、DMG bundle 禁带内部 docs/src/tests/env/私钥 | ✅ P0 接入 |

---

## 技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| **桌面框架** | Tauri 2.x | Rust shell + Node.js webServer，DMG 体积显著小于 Electron |
| **前端框架** | React 18 + TypeScript 5.6 | 组件化开发 |
| **状态管理** | Zustand 5 | 轻量级状态管理 |
| **UI 样式** | Tailwind CSS 3.4 | 深色工作台界面 |
| **构建工具** | esbuild (main/preload) + Vite (renderer) | 快速开发体验 |
| **AI 模型** | 小米 MiMo v2.5 Pro 默认 + GPT-5.5 / DeepSeek V4 / Kimi K2.6 / Claude / OpenRouter / Ollama 等 | 本地 API Key 配置，多 provider 路由 |
| **Agent Engine** | Native Agent Neo / Codex CLI / Claude Code | 外部 engine 默认 read-only、workspace-only |
| **后端服务** | Supabase | 认证 + 同步 + 管理员 RPC + 向量存储 |
| **向量数据库** | pgvector | 语义搜索和长期记忆 |

---

## 8 代工具演进

本节保留仓库早期的研究脉络，用来解释 Code Agent 为什么从 Claude Code 能力复刻起步。当前产品主线已经转为 Agent Neo 工作台，最新产品能力以 [PRD](./PRD.md)、[NEW_FEATURES](./NEW_FEATURES.md) 和 [ARCHITECTURE](./ARCHITECTURE.md) 为准。

项目实现了 Claude Code 从 v0.2 到 v2.0+ 的完整代际演进：

| 代际 | 版本 | 工具数量 | 核心能力 |
|------|------|----------|----------|
| **Gen 1** | v0.2 | 4 | bash, read_file, write_file, edit_file |
| **Gen 2** | v1.0 | 7 | + glob, grep, list_directory |
| **Gen 3** | v1.0.60 | 12 | + task, todo_write, ask_user_question, plan_read, plan_update, findings_write |
| **Gen 4** | v2.0 | 14 | + skill, web_fetch |
| **Gen 5** | v2.1 | 18 | + auto_learn, code_index, memory_search, memory_store |
| **Gen 6** | v2.2 | 21 | + browser_navigate, computer_use, screenshot |
| **Gen 7** | v2.3 | 24 | + agent_message, spawn_agent, workflow_orchestrate |
| **Gen 8** | v2.4 | 24+ | 完整 MCP 服务器支持 |

### 代际能力对比

```
┌─────────────────────────────────────────────────────────────────────────┐
│                    Claude Code 代际演进图                                │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                         │
│  Gen 1-2        Gen 3-4          Gen 5           Gen 6-7        Gen 8   │
│  基础工具期     智能规划期        知识记忆期       自动化期       完整态  │
│      │              │                │               │             │    │
│      ▼              ▼                ▼               ▼             ▼    │
│  ┌───────┐     ┌────────┐      ┌─────────┐    ┌──────────┐  ┌───────┐  │
│  │ bash  │     │ +Plan  │      │+Memory  │    │+Computer │  │ +MCP  │  │
│  │ read  │ →   │ +Task  │  →   │+AutoLearn│ → │  Use     │→ │Server │  │
│  │ write │     │ +Agent │      │+CodeIndex│   │+Workflow │  │Support│  │
│  │ edit  │     │/context│      │+Embed   │    │+MultiAgent│  │      │  │
│  └───────┘     └────────┘      └─────────┘    └──────────┘  └───────┘  │
│                                                                         │
└─────────────────────────────────────────────────────────────────────────┘
```

---

## 项目结构

```
code-agent/
├── src/
│   ├── main/                  # Node.js main runtime（Tauri sidecar / Web server）
│   │   ├── agent/            # Agent 核心
│   │   │   ├── AgentOrchestrator.ts  # 编排器
│   │   │   └── AgentLoop.ts          # 事件循环
│   │   ├── prompts/         # Prompt system
│   │   ├── model/            # 模型路由
│   │   ├── tools/            # native ToolModule 工具体系
│   │   ├── services/         # 核心服务（Auth/Admin/AgentEngine/Capability/Sync）
│   │   ├── memory/           # 记忆条目运行时与注入追踪
│   │   └── mcp/              # MCP 服务器
│   ├── renderer/             # React 前端
│   │   ├── components/       # UI 组件
│   │   ├── hooks/            # 自定义 hooks
│   │   └── stores/           # Zustand 状态
│   └── shared/               # 共享类型
├── src-tauri/                 # Tauri shell、capabilities、icons、updater
├── docs/                      # 文档
├── supabase/                  # 数据库迁移
└── build/                     # 构建配置
```

---

## 核心功能模块

### 1. Agent 事件循环

```typescript
// 核心推理循环
用户输入 → 模型推理 → [工具调用]* → 响应
```

Agent 的核心是持续处理用户输入和工具调用的事件循环，支持流式输出和并行工具调用。

### 2. Agent Engine 与模型配置

- Native Agent Neo 是默认 engine，走完整 ConversationRuntime、工具、权限和 trace/review 链路
- Codex CLI / Claude Code 作为受控外部 engine，默认 read-only、workspace-only
- Provider API Key 由本机配置，ModelSettings 和 onboarding 负责首次配置与连通性测试

### 3. 工具权限系统

- `read`: 文件读取
- `write`: 文件写入
- `execute`: 命令执行
- `network`: 网络访问

危险操作需要用户确认。

### 4. 记忆系统

- **Light Memory**: 文件即记忆，保留人工可读结构
- **统一管理**: 记忆导入、条目 CRUD、候选决策和 Knowledge Memory Audit
- **注入追踪**: 记录 memory 如何进入当前 prompt，便于排查上下文污染

### 5. 云端同步

| 表名 | 用途 |
|------|------|
| `profiles` | 用户资料 |
| `devices` | 设备管理 |
| `sessions` | 会话记录 |
| `messages` | 对话消息 |
| `vector_documents` | 向量文档 |

---

## UI/UX 设计

### Terminal Noir 设计语言

融合赛博朋克霓虹感与专业终端美学的深色主题。

| 层级 | 颜色 | 用途 |
|------|------|------|
| `void` | #08080a | 最深背景 |
| `surface` | #121218 | 主表面 |
| `primary` | #6366f1 | 主色调 (靛蓝) |
| `accent-cyan` | #22d3ee | 强调色 |
| `accent-emerald` | #10b981 | 成功状态 |
| `accent-rose` | #f43f5e | 错误状态 |

### 动画系统

- `fade-in-up`: 淡入上滑 (消息出现)
- `glow-pulse`: 光晕脉冲 (焦点状态)
- `scale-in`: 缩放进入 (卡片、按钮)
- `typing-dot`: 打字点动画 (AI 思考中)

---

## 开发命令

```bash
# 开发模式
npm run dev

# 构建
npm run build

# 启动 Web host（开发）
npm run dev:web:server

# 打包并安装 macOS Tauri 应用
npm run tauri:build

# 生成 release bundle / update manifest
npm run tauri:release:bundle
npm run tauri:update-manifest

# 类型检查
npm run typecheck
```

---

## 最近更新

### 2026-05-22 ~ 2026-05-26

- ✅ **Goal Mode（`/goal` 自治目标循环）**：完成判定权落代码层的三层闸（确定性 verify exec + 可选 Reviewer 子代理 + 代码层兜底），`--verify`/`--review` 二选一支持纯软目标，斜杠命令 UI + 实时状态条 + 生命周期卡片。详见 [goal-mode spec](./designs/goal-mode.md)
- ✅ **Provider 层迁移到 Vercel AI SDK（双引擎）**：`aiSdkAdapter` 归一流式/非流式 provider 响应，子代理 + 主 loop 默认 aisdk、`CODE_AGENT_MODEL_ENGINE=legacy` 一键回退，从根上消灭解析不对称的整类 bug
- ✅ **Appshots（macOS）**：左右 Command 双击截当前窗口（截图 + AX 文本，OCR 兜底），隐藏 `<appshot>` XML + 图片注入聊天上下文。详见 [appshots spec](./designs/appshots.md)
- ✅ **bypassPermissions 档接入 OS 级沙箱**：sandbox-exec/bwrap 命令包装 + 沙箱不可用 fail-fast 硬报错，其余权限档零变化

### 2026-05-15 ~ 2026-05-17

- ✅ 产品品牌切到 Agent Neo，App、站点、icon、About/Update、MCP server 和终端输出已更新
- ✅ server-side cloud proxy 退场，本地 Provider API Key + onboarding 成为默认模型配置路径
- ✅ Native Agent Neo / Codex CLI / Claude Code 进入 Agent Engine 选择器，外部 engine read-only 接力运行
- ✅ Capability Center 本地 registry、disabled MCP draft、agent engine 能力卡和成功/删除回执打通
- ✅ In-App HTML Validation、Browser Surface、visualSmoke interaction loop 和 artifact repair Route A 补齐验收面
- ✅ Background task ledger、handoff proposal、Hook source metadata、管理员用户/邀请码、可选 Tauri 更新和 release security scan 接入

### 2026-01-17

- ✅ 支持 8 代工具选择，（已移除）Generation 下拉框添加滚动支持
- ✅ Gen6-8 工具实现完成
- ✅ Terminal Noir UI 设计系统
- ✅ 用户认证系统 (Supabase)
- ✅ pgvector 云端向量同步
- ✅ 安全增强: 速率限制、CORS、模块隔离

### 关键提交

```
79094fd fix(ui): Add scrolling support to generation dropdown for 8 generations
1061b33 feat: Add gen6-8 tools, Terminal Noir UI, and enhanced features
9aa718f feat(ui): Terminal Noir design system with enhanced UI/UX
8ef48df Add user auth system with Supabase and pgvector cloud sync
d45f2e6 Security enhancements: rate limiting, CORS, module isolation
```

---

## 环境配置

```bash
# 本地 Provider Key（按需配置）
OPENAI_API_KEY=your-key
DEEPSEEK_API_KEY=your-key
ANTHROPIC_API_KEY=your-key
OPENROUTER_API_KEY=your-key

SUPABASE_URL=your-supabase-url
SUPABASE_ANON_KEY=your-anon-key
```

---

## 后续计划

1. **远程 marketplace** - 让 skill、MCP template、workflow recipe 等能力可发现、可安装、可审计
2. **外部 Agent Engine 写权限设计** - 在更明确的权限模型下评估 workspace-write 接力
3. **In-App Validation 扩面** - 从 HTML artifact 扩到更多可交互交付物
4. **Windows/Linux 打包验证** - Tauri 多平台分发和 updater 兼容性

---

## 参考资源

- [Claude Code 官方文档](https://docs.anthropic.com/claude-code)
- [How to Build a Coding Agent](https://github.com/ghuntley/how-to-build-a-coding-agent)
- [Vercel AI SDK](https://sdk.vercel.ai/)
- [Tauri 官方文档](https://tauri.app/)

---

## 许可证

MIT License - 仅供学习研究使用
