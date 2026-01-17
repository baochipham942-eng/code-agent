# Code Agent

AI 编程助手桌面应用，用于学习和研究 AI Agent 能力演进。

## 项目简介

这是一个基于 Electron + React 的桌面应用，通过复刻 Claude Code 的 4 个架构代际来观察和学习 AI Agent 能力的演进过程。

## 技术栈

- **框架**: Electron 33 + React 18
- **语言**: TypeScript 5.6
- **构建**: esbuild (main/preload) + Vite (renderer)
- **样式**: Tailwind CSS 3.4
- **状态管理**: Zustand 5
- **AI 模型**: DeepSeek API (主要)，支持 OpenAI/Claude 切换
- **后端服务**: Supabase (认证 + 数据库 + 向量存储)
- **向量数据库**: pgvector (语义搜索和长期记忆)

## 目录结构

```
src/
├── main/                  # Electron 主进程
│   ├── index.ts          # 入口，窗口创建
│   ├── agent/            # Agent 核心
│   │   ├── AgentOrchestrator.ts  # 编排器
│   │   └── AgentLoop.ts          # 事件循环
│   ├── generation/       # 代际管理
│   │   └── GenerationManager.ts
│   ├── model/            # 模型路由
│   │   └── ModelRouter.ts
│   ├── tools/            # 工具实现
│   │   ├── gen1/         # bash, read_file, write_file, edit_file
│   │   ├── gen2/         # glob, grep, list_directory
│   │   ├── gen3/         # task, todo_write, ask_user_question
│   │   └── gen4/         # skill, web_fetch
│   ├── services/         # 核心服务
│   │   ├── SupabaseService.ts    # Supabase 客户端
│   │   ├── AuthService.ts        # 认证服务
│   │   ├── SyncService.ts        # 云端同步引擎
│   │   ├── SecureStorage.ts      # 安全存储
│   │   └── DatabaseService.ts    # 本地 SQLite
│   └── memory/           # 记忆系统
│       ├── MemoryService.ts      # 统一记忆管理
│       ├── EmbeddingService.ts   # 向量嵌入服务
│       └── VectorStore.ts        # 向量存储
├── preload/              # 预加载脚本
├── renderer/             # React 前端
│   ├── components/       # UI 组件
│   ├── hooks/            # 自定义 hooks
│   └── stores/           # Zustand 状态
└── shared/               # 共享类型和 IPC 定义
```

## 8 代工具演进

| 代际 | 版本 | 工具集 | 核心能力 |
|------|------|--------|----------|
| Gen 1 | v1.0 | bash, read_file, write_file, edit_file | 基础文件操作 |
| Gen 2 | v2.0 | + glob, grep, list_directory | 搜索和导航 |
| Gen 3 | v3.0 | + task, todo_write, ask_user_question | 子代理和规划 |
| Gen 4 | v4.0 | + skill, web_fetch | 技能系统和网络 |
| Gen 5 | v5.0 | + memory_store, memory_search, code_index | RAG 和长期记忆 |
| Gen 6 | v6.0 | + screenshot, computer_use, browser_action | Computer Use |
| Gen 7 | v7.0 | + spawn_agent, agent_message, workflow_orchestrate | 多代理协同 |
| Gen 8 | v8.0 | + strategy_optimize, tool_create, self_evaluate | 自我进化 |

## 版本号规范

项目采用语义化版本号 (Semantic Versioning)：**MAJOR.MINOR.PATCH**

| 位置 | 含义 | 范围 | 示例 |
|------|------|------|------|
| **MAJOR** (第1位) | 大架构升级、不兼容改动 | 0-99 | 1.x.x → 2.0.0 |
| **MINOR** (第2位) | 新功能、向后兼容的改进 | 0-99 | 1.0.x → 1.1.0 |
| **PATCH** (第3位) | Bug 修复、小改动 | 0-99 | 1.0.0 → 1.0.1 |

### 版本号规则

1. **PATCH 递增**：修复 bug、优化性能、改进文档
2. **MINOR 递增**：添加新功能、改进 UI/UX（PATCH 归零）
3. **MAJOR 递增**：架构重构、API 不兼容改动（MINOR 和 PATCH 归零）

### 代际版本号

代际版本号（v1.0 - v8.0）表示 AI Agent 能力代际，与应用版本号独立：
- **代际版本**: 表示 Agent 工具集和能力等级（Gen1=v1.0, Gen8=v8.0）
- **应用版本**: 表示软件发布版本（如 0.2.0, 1.0.0）

## 常用命令

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

## 环境变量

项目使用 `.env` 文件配置 API：
- `DEEPSEEK_API_KEY` - DeepSeek API 密钥
- `DEEPSEEK_API_URL` - DeepSeek API 地址
- `SUPABASE_URL` - Supabase 项目 URL
- `SUPABASE_ANON_KEY` - Supabase 匿名密钥

## 开发要点

1. **IPC 通信**: 主进程和渲染进程通过 `src/shared/ipc.ts` 定义的类型安全通道通信
2. **Agent 循环**: `AgentLoop.ts` 实现核心推理循环：用户输入 → 模型推理 → [工具调用]* → 响应
3. **代际切换**: 通过 `GenerationManager` 切换不同代际，动态加载对应的工具集和 system prompt
4. **工具权限**: `ToolExecutor` 控制危险操作的权限检查

## 账户体系与云端同步

### 认证方式
- **邮箱/密码登录**: 标准认证流程
- **GitHub OAuth**: 第三方登录
- **快捷 Token**: 跨设备快速登录

### 同步架构
- **离线优先**: 本地 SQLite 存储，联网时同步
- **增量同步**: 基于 `updated_at` 游标的增量更新
- **冲突解决**: Last-Write-Wins 策略

### 云端数据表
| 表名 | 用途 |
|------|------|
| `profiles` | 用户资料 |
| `devices` | 设备管理 |
| `sessions` | 会话记录 |
| `messages` | 对话消息 |
| `user_preferences` | 用户偏好 |
| `project_knowledge` | 项目知识 |
| `todos` | 待办事项 |
| `vector_documents` | 向量文档 (pgvector) |
| `invite_codes` | 邀请码 |

### 向量数据库
- **扩展**: pgvector (Supabase 原生支持)
- **维度**: 1024 (DeepSeek)，支持 384/1536
- **索引**: HNSW (cosine 距离)
- **用途**: 语义搜索、长期记忆、RAG 上下文

### 相关文件
- `supabase/migrations/` - 数据库迁移脚本
- `src/main/services/AuthService.ts` - 认证逻辑
- `src/main/services/SyncService.ts` - 同步引擎
- `src/renderer/stores/authStore.ts` - 前端认证状态
- `src/renderer/components/AuthModal.tsx` - 登录界面

## UI/UX 设计系统

### Terminal Noir 设计语言

项目采用 "Terminal Noir" 设计风格 —— 融合赛博朋克霓虹感与专业终端美学的深色主题。

#### 配色方案

| 层级 | 颜色 | 用途 |
|------|------|------|
| `void` | #08080a | 最深背景 |
| `deep` | #0c0c10 | 深层背景 |
| `surface` | #121218 | 主表面 |
| `elevated` | #1a1a22 | 提升表面 |
| `primary` | #6366f1 | 主色调 (靛蓝) |
| `accent-cyan` | #22d3ee | 强调色 (青色) |
| `accent-emerald` | #10b981 | 成功状态 |
| `accent-rose` | #f43f5e | 错误状态 |

#### 核心组件

| 组件 | 文件 | 特性 |
|------|------|------|
| **Sidebar** | `Sidebar.tsx` | 会话分组、搜索过滤、时间标签 |
| **ChatView** | `ChatView.tsx` | 渐变背景、卡片式建议、打字指示器 |
| **ChatInput** | `ChatInput.tsx` | 焦点光效、快捷键提示、发送动画 |
| **MessageBubble** | `MessageBubble.tsx` | 代码块高亮、工具调用折叠、状态徽章 |

#### 动画系统

- `fade-in-up` - 淡入上滑 (消息出现)
- `glow-pulse` - 光晕脉冲 (焦点状态)
- `scale-in` - 缩放进入 (卡片、按钮)
- `typing-dot` - 打字点动画 (AI 思考中)

#### 样式文件

- `src/renderer/styles/global.css` - CSS 变量和全局样式
- `tailwind.config.js` - Tailwind 扩展配置

## 相关文档

- [产品需求文档](docs/PRD.md)
- [架构设计文档](docs/ARCHITECTURE.md)
