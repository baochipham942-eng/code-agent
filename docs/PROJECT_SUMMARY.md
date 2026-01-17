# Code Agent 项目总结

> 版本: 1.0
> 日期: 2026-01-17
> 作者: Lin Chen

---

## 项目概述

**Code Agent** 是一个基于 Electron + React 的 AI 编程助手桌面应用，通过复刻 Claude Code 的 8 个架构代际来观察和学习 AI Agent 能力的演进过程。

### 核心目标

| 目标 | 描述 | 状态 |
|------|------|------|
| **功能复刻** | 实现 Claude Code 核心功能（文件操作、命令执行、代码搜索等） | ✅ 完成 |
| **代际切换** | 支持切换 8 个主要代际的 system prompt，观察能力差异 | ✅ 完成 |
| **交互体验** | Terminal Noir 设计风格，提供友好的桌面应用界面 | ✅ 完成 |
| **模型兼容** | 支持 DeepSeek API、Claude API 等多模型切换 | ✅ 完成 |
| **云端同步** | Supabase 认证 + pgvector 向量数据库 | ✅ 完成 |

---

## 技术栈

| 层级 | 技术选型 | 说明 |
|------|----------|------|
| **桌面框架** | Electron 33 | 跨平台，生态成熟 |
| **前端框架** | React 18 + TypeScript 5.6 | 组件化开发 |
| **状态管理** | Zustand 5 | 轻量级状态管理 |
| **UI 样式** | Tailwind CSS 3.4 | Terminal Noir 设计系统 |
| **构建工具** | esbuild (main/preload) + Vite (renderer) | 快速开发体验 |
| **AI 模型** | DeepSeek API (主要) | 支持 OpenAI/Claude 切换 |
| **后端服务** | Supabase | 认证 + 数据库 + 向量存储 |
| **向量数据库** | pgvector | 语义搜索和长期记忆 |

---

## 8 代工具演进

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
│   ├── main/                  # Electron 主进程
│   │   ├── agent/            # Agent 核心
│   │   │   ├── AgentOrchestrator.ts  # 编排器
│   │   │   └── AgentLoop.ts          # 事件循环
│   │   ├── generation/       # 代际管理
│   │   ├── model/            # 模型路由
│   │   ├── tools/            # 工具实现 (gen1-gen7)
│   │   ├── services/         # 核心服务
│   │   ├── memory/           # 记忆系统
│   │   └── mcp/              # MCP 服务器
│   ├── renderer/             # React 前端
│   │   ├── components/       # UI 组件
│   │   ├── hooks/            # 自定义 hooks
│   │   └── stores/           # Zustand 状态
│   ├── preload/              # 预加载脚本
│   └── shared/               # 共享类型
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

### 2. 代际管理系统

- 支持 8 个代际的独立 system prompt
- 动态加载对应代际的工具集
- 代际间 prompt 差异对比

### 3. 工具权限系统

- `read`: 文件读取
- `write`: 文件写入
- `execute`: 命令执行
- `network`: 网络访问

危险操作需要用户确认。

### 4. 记忆系统 (Gen 5+)

- **短期记忆**: 会话内上下文
- **长期记忆**: pgvector 向量存储
- **语义搜索**: 基于嵌入的相关性检索

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

# 启动（构建后）
npm run start

# 打包 macOS 应用
npm run dist:mac

# 类型检查
npm run typecheck
```

---

## 最近更新

### 2026-01-17

- ✅ 支持 8 代工具选择，Generation 下拉框添加滚动支持
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
# .env 文件
DEEPSEEK_API_KEY=your-key
DEEPSEEK_API_URL=https://api.deepseek.com

SUPABASE_URL=your-supabase-url
SUPABASE_ANON_KEY=your-anon-key

# 可选
ANTHROPIC_API_KEY=your-key
OPENAI_API_KEY=your-key
```

---

## 后续计划

1. **MCP 服务器完善** - 更多 MCP 工具集成
2. **多 Agent 协作** - 基于 Gen 7 的工作流编排
3. **Windows/Linux 支持** - 跨平台打包
4. **插件系统** - 用户自定义技能

---

## 参考资源

- [Claude Code 官方文档](https://docs.anthropic.com/claude-code)
- [How to Build a Coding Agent](https://github.com/ghuntley/how-to-build-a-coding-agent)
- [Vercel AI SDK](https://sdk.vercel.ai/)
- [Electron 官方文档](https://www.electronjs.org/docs)

---

## 许可证

MIT License - 仅供学习研究使用
