# Code Agent

AI 编程助手桌面应用，复刻 Claude Code 的 8 个架构代际来研究 AI Agent 能力演进。

## 技术栈

- **框架**: Electron 33 + React 18 + TypeScript
- **构建**: esbuild (main/preload) + Vite (renderer)
- **样式**: Tailwind CSS
- **状态**: Zustand
- **AI**: DeepSeek API（主）, OpenAI/Claude（备）
- **后端**: Supabase + pgvector

## 文档结构

```
docs/
├── ARCHITECTURE.md       # 架构索引（入口）
├── PRD.md               # 产品需求文档
├── architecture/        # 详细架构文档
│   ├── overview.md      # 系统概览
│   ├── agent-core.md    # Agent 核心
│   ├── tool-system.md   # 工具系统
│   ├── frontend.md      # 前端架构
│   ├── data-storage.md  # 数据存储
│   └── cloud-architecture.md # 云端架构
└── decisions/           # 架构决策记录 (ADR)
    └── 001-turn-based-messaging.md
```

## 目录结构

```
src/
├── main/                 # Electron 主进程
│   ├── agent/           # AgentOrchestrator, AgentLoop
│   ├── generation/      # GenerationManager
│   ├── tools/           # gen1-gen4 工具实现
│   ├── services/        # Auth, Sync, Database
│   └── memory/          # 向量存储和记忆系统
├── preload/             # 预加载脚本
├── renderer/            # React 前端
│   ├── components/      # UI 组件
│   │   ├── primitives/  # 基础组件 (Button, Modal, Input, Textarea, Select)
│   │   ├── composites/  # 组合组件 (ConfirmDialog, FormField)
│   │   ├── features/    # 业务组件
│   │   │   ├── chat/    # 聊天组件 (ChatInput, MessageBubble)
│   │   │   └── settings/# 设置组件 (SettingsModal, 各 Tab)
│   │   └── index.ts     # 统一导出入口
│   ├── stores/          # Zustand 状态
│   │   ├── appStore.ts  # 应用全局状态
│   │   ├── uiStore.ts   # UI 状态 (modal, toast)
│   │   ├── authStore.ts # 认证状态
│   │   └── sessionStore.ts # 会话状态
│   └── hooks/           # 自定义 hooks
└── shared/              # 类型定义和 IPC
```

## 常用命令

```bash
npm run dev          # 开发模式
npm run build        # 构建
npm run dist:mac     # 打包 macOS
npm run typecheck    # 类型检查
```

## 8 代工具演进

| 代际 | 工具集 |
|------|--------|
| Gen1 | bash, read_file, write_file, edit_file |
| Gen2 | + glob, grep, list_directory |
| Gen3 | + task, todo_write, ask_user_question |
| Gen4 | + skill, web_fetch, read_pdf, mcp, mcp_list_tools, mcp_list_resources, mcp_read_resource, mcp_get_status |
| Gen5 | + memory_store, memory_search, code_index, ppt_generate |
| Gen6 | + screenshot, computer_use, browser_action |
| Gen7 | + spawn_agent, agent_message, workflow_orchestrate |
| Gen8 | + strategy_optimize, tool_create, self_evaluate |

### Gen4 PDF 智能处理

`read_pdf` 工具采用两阶段处理策略：

1. **文本提取优先**：使用 pdfjs-dist 快速提取文本（免费、快速）
2. **视觉模型回退**：如果文本提取量低于阈值（扫描版 PDF），自动调用 OpenRouter Gemini 2.0 视觉模型

```bash
# 普通文本 PDF - 使用文本提取
read_pdf { "file_path": "/path/to/doc.pdf" }

# 扫描版或图表 PDF - 自动回退到视觉模型
read_pdf { "file_path": "/path/to/scanned.pdf" }

# 强制使用视觉模型（含图表分析）
read_pdf { "file_path": "/path/to/diagram.pdf", "force_vision": true, "prompt": "分析图表数据" }
```

**要求**：处理扫描版 PDF 需要配置 OpenRouter API Key。

### Gen4 Skill 内置技能

`skill` 工具提供预定义的工作流：

| 技能 | 描述 |
|------|------|
| `file-organizer` | 整理目录文件：分析、分类、检测重复、清理 |
| `commit` | Git 提交助手，遵循 conventional commit 规范 |
| `code-review` | 代码审查，检查 bug、安全问题、最佳实践 |

**file-organizer 使用示例：**

```bash
# 整理下载目录
skill { "name": "file-organizer", "input": "整理我的下载文件夹" }

# 整理指定目录
skill { "name": "file-organizer", "input": "整理 ~/Desktop 目录，清理重复文件" }
```

**安全机制**：删除操作必须通过 `ask_user_question` 获得用户确认，支持移动到废纸篓或永久删除。

### Gen4 MCP 工具说明

MCP (Model Context Protocol) 允许 Agent 调用外部服务提供的工具：

| 工具 | 描述 |
|------|------|
| `mcp` | 调用 MCP 服务器工具（如 deepwiki, github 等）|
| `mcp_list_tools` | 列出已连接服务器的可用工具 |
| `mcp_list_resources` | 列出可用资源 |
| `mcp_read_resource` | 读取资源内容 |
| `mcp_get_status` | 获取 MCP 连接状态 |

**DeepWiki 使用示例：**

DeepWiki 是默认启用的远程 MCP 服务器，提供 GitHub 项目文档解读能力：

```bash
# 1. 先查看可用工具
mcp_list_tools { "server": "deepwiki" }

# 2. 获取项目文档结构
mcp { "server": "deepwiki", "tool": "read_wiki_structure", "arguments": { "repoName": "anthropics/claude-code" } }

# 3. 读取具体文档内容
mcp { "server": "deepwiki", "tool": "read_wiki_contents", "arguments": { "repoName": "anthropics/claude-code", "topic": "Architecture" } }

# 4. 询问项目问题
mcp { "server": "deepwiki", "tool": "ask_question", "arguments": { "repoName": "facebook/react", "question": "React 18 的并发特性是如何实现的？" } }
```

**已配置的 MCP 服务器：**

| 服务器 | 类型 | 默认启用 | 说明 |
|--------|------|----------|------|
| `deepwiki` | SSE | ✅ | 解读 GitHub 项目文档 |
| `github` | Stdio | 需 GITHUB_TOKEN | GitHub API |
| `filesystem` | Stdio | ❌ | 文件系统访问 |
| `git` | Stdio | ❌ | Git 版本控制 |
| `brave-search` | Stdio | 需 BRAVE_API_KEY | 网络搜索 |

### Gen5 PPT 生成

`ppt_generate` 工具支持两种引擎生成演示文稿：

| 引擎 | 场景 | 特点 |
|------|------|------|
| `slidev` | 技术演示、代码展示 | 本地生成，基于 Markdown，免费快速 |
| `presenton` | 商务汇报、需要配图 | 云端 LLM 生成内容，支持 AI 配图 prompts |

**使用示例：**

```bash
# 技术演示 - 使用 Slidev（本地）
ppt_generate { "topic": "React 18 新特性", "slides_count": 5, "engine": "slidev" }

# 商务演示 - 使用云端 LLM（带配图 prompts）
ppt_generate { "topic": "公司年度总结", "slides_count": 10, "engine": "presenton", "need_images": true }
```

**输出**：生成 Slidev 项目目录，包含 `slides.md` 和 `package.json`，可直接 `npm install && npm run dev` 预览。

**配图流程**：如果 `need_images: true`，工具会返回每页幻灯片的图片描述（英文 prompt），可配合 `image_generate` 工具生成配图。

## 云端 Prompt 管理

System Prompt 采用前后端分离架构，支持热更新：

**架构**：
- 云端 `/api/prompts` 端点提供各代际的 system prompt
- 客户端 `PromptService` 启动时异步拉取，1 小时缓存
- 拉取失败自动降级到内置 prompts

**优势**：
- 修改 prompt 只需部署云端，无需重新打包客户端
- 离线也能正常工作（使用内置版本）

**API 端点**：
```bash
# 获取所有代际 prompts
curl "https://code-agent-beta.vercel.app/api/prompts?gen=all"

# 获取特定代际
curl "https://code-agent-beta.vercel.app/api/prompts?gen=gen4"

# 只获取版本号
curl "https://code-agent-beta.vercel.app/api/prompts?version=true"
```

## 版本号规范

- **PATCH**: Bug 修复、小改动 (0.3.0 → 0.3.1)
- **MINOR**: 新功能 (0.3.1 → 0.4.0)
- **MAJOR**: 架构重构 (0.4.0 → 1.0.0)

代际版本 (v1.0-v8.0) 表示 Agent 能力等级，与应用版本独立。

---

## 部署配置

### Vercel

| 配置项 | 值 |
|--------|-----|
| 项目名 | `code-agent` |
| 域名 | `https://code-agent-beta.vercel.app` |
| Root Directory | `vercel-api` |

```bash
# 验证部署
curl -s "https://code-agent-beta.vercel.app/api/update?action=health"
```

### API 目录

| 目录 | 说明 |
|------|------|
| `vercel-api/` | Vercel Serverless Functions（版本检查、设置同步等）|

### API 端点列表

> 注意：由于 Vercel Hobby 计划 12 函数限制，v1 版本化方案已放弃

| 端点 | 说明 |
|------|------|
| /api/agent | 云端 Agent |
| /api/auth | GitHub OAuth 认证 |
| /api/health | 健康检查 |
| /api/prompts | System Prompt |
| /api/sync | 数据同步 |
| /api/tools | 云端工具（api/scrape/search）|
| /api/update | 版本更新检查 |
| /api/user-keys | 用户 API Key 管理 |
| /api/v1/config | 云端配置中心（新）|

---

## 开发规范

### 类型检查

- **边开发边验证**：写完一个功能点后立即运行 `npm run typecheck`
- **提交前必检**：commit 前 typecheck 必须通过
- **允许临时 any**：原型阶段可用 `as any` 绕过，但必须标注 `// TODO: 修复类型`
- **接口改动要追溯**：修改 interface/type 后，检查所有引用处是否需要同步更新

### 常见类型错误模式

| 错误模式 | 原因 | 预防 |
|---------|------|------|
| `isCloud` vs `fromCloud` | 不同文件命名不一致 | 改接口时全局搜索引用 |
| Supabase 类型错误 | 缺少生成的类型定义 | 用 `as any` 临时绕过并标 TODO |
| `unknown` 转 `ReactNode` | Record<string, unknown> 取值 | 显式类型断言 |

### 验证节奏

```
写代码 → typecheck → 修复 → 功能测试 → commit
```

---

## 错题本

### Vercel 部署目录混淆
**问题**: 修改了错误的 API 目录
**正确做法**: 只修改 `vercel-api/api/update.ts`

### 打包位置错误
**问题**: 在 worktree 中执行 `npm run dist:mac`，产物在 worktree 的 `release/` 下
**正确做法**: 切换到主仓库后再打包

### 版本号遗漏
**问题**: 修改代码后直接打包，忘记更新版本号
**正确做法**: 每次修改客户端代码必须递增 package.json 版本号

### 类型错误积累
**问题**: 多个功能并行开发后合并，积累了大量类型错误（接口不一致、命名冲突）
**正确做法**: 每个功能点完成后立即 `npm run typecheck`，不要等到最后一起修

### 客户端打开失败（白屏/无响应）
**问题**: 打包后应用启动白屏或无响应，通常是主进程初始化阻塞
**排查方法**:
1. 终端运行 `/Applications/Code\ Agent.app/Contents/MacOS/Code\ Agent` 查看日志
2. 检查 `initializeServices()` 中是否有阻塞操作
**常见原因**:
- MCP 服务器连接超时（远程服务不可达）
- 数据库初始化失败
- 环境变量缺失导致服务初始化卡住

### 启动慢（窗口延迟出现）
**问题**: `npm run dev` 或打包应用启动后，窗口要等很久才出现
**原因**: `initializeServices()` 中的 await 阻塞了窗口创建
**正确做法**:
- 非关键服务（MCP、LogBridge、Auth）使用 `.then()/.catch()` 异步初始化
- 只有数据库、配置等核心服务才需要 await
- 示例：`initMCPClient().then(...).catch(...)` 而非 `await initMCPClient()`

### Vercel 部署到错误项目
**问题**: 在 `vercel-api/` 目录执行 `vercel --prod`，Vercel CLI 自动创建了新项目
**原因**: Vercel CLI 会在当前目录创建 `.vercel/` 配置，如果没有配置则创建新项目
**正确做法**:
1. 永远不要在 `vercel-api/` 目录执行 Vercel 命令
2. 通过 git push 触发自动部署（Vercel 已配置 Root Directory 为 `vercel-api`）
3. 如果 `vercel-api/.vercel/` 存在，立即删除

### Vercel Hobby 计划 12 函数限制
**问题**: 部署失败，错误 "No more than 12 Serverless Functions"
**原因**: Hobby 计划最多支持 12 个 API 函数，`vercel-api/api/` 下文件超过限制
**正确做法**:
1. 将相关功能合并到一个文件，通过 `?action=xxx` 参数区分
2. 当前已合并：`tools.ts` 包含 api/scrape/search 三个功能
3. 当前 API 数量：10 个（预留 2 个空间）

### 发布清单

```
□ 代码改动已测试
□ npm run typecheck 通过
□ package.json 版本号已递增
□ vercel-api/api/update.ts 已更新
□ 已 commit 并 push
□ 当前目录是主仓库
□ API 验证通过
□ npm run build
□ npm run dist:mac
```

---

## 调试与日志查询

### 本地数据库位置

```
~/Library/Application Support/code-agent/code-agent.db
```

### 查询用户请求和 AI 回复

```bash
# 查看最近 10 条消息（含时间戳）
sqlite3 "~/Library/Application Support/code-agent/code-agent.db" \
  "SELECT role, substr(content, 1, 200), datetime(timestamp/1000, 'unixepoch', 'localtime') \
   FROM messages ORDER BY timestamp DESC LIMIT 10;"

# 查看最新一条完整的 AI 回复
sqlite3 "~/Library/Application Support/code-agent/code-agent.db" \
  "SELECT content FROM messages WHERE role='assistant' \
   AND timestamp = (SELECT MAX(timestamp) FROM messages WHERE role='assistant');"

# 查看特定会话的消息
sqlite3 "~/Library/Application Support/code-agent/code-agent.db" \
  "SELECT role, content FROM messages WHERE session_id='<SESSION_ID>' ORDER BY timestamp;"
```

### 数据库表结构

| 表名 | 用途 |
|------|------|
| `sessions` | 会话记录 |
| `messages` | 消息历史（用户请求 + AI 回复）|
| `tool_executions` | 工具执行记录 |
| `todos` | 任务清单 |
| `project_knowledge` | 项目知识库 |
| `user_preferences` | 用户设置 |
| `audit_log` | 审计日志 |

### .env 文件位置

| 场景 | 路径 |
|------|------|
| 开发模式 | `/Users/linchen/Downloads/ai/code-agent/.env` |
| 打包应用 | `/Applications/Code Agent.app/Contents/Resources/.env` |

**注意**：修改 `.env` 后，打包应用需要手动同步：
```bash
cp /Users/linchen/Downloads/ai/code-agent/.env "/Applications/Code Agent.app/Contents/Resources/.env"
```
