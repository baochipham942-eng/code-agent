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
├── CONSTITUTION.md      # 宪法式 Prompt 设计
├── architecture/        # 详细架构文档
│   ├── overview.md      # 系统概览
│   ├── agent-core.md    # Agent 核心
│   ├── tool-system.md   # 工具系统
│   ├── frontend.md      # 前端架构
│   ├── data-storage.md  # 数据存储
│   └── cloud-architecture.md # 云端架构
├── api-reference/       # API 文档 (v0.9+)
│   ├── index.md         # API 索引
│   ├── security.md      # 安全模块 API
│   ├── tool-enhancements.md # 工具增强 API
│   └── hooks.md         # Hooks 系统 API
├── migration/           # 迁移指南
│   └── v0.9-upgrade.md  # v0.9 升级指南
└── decisions/           # 架构决策记录 (ADR)
    └── 001-turn-based-messaging.md
```

## 目录结构

```
src/
├── main/                 # Electron 主进程
│   ├── agent/           # AgentOrchestrator, AgentLoop
│   ├── generation/      # GenerationManager
│   │   └── prompts/     # System prompt 构建
│   │       ├── constitution/  # 宪法层（soul, values, ethics, safety, judgment）
│   │       ├── tools/         # 工具描述（bash, edit, task）
│   │       ├── rules/         # 规则层
│   │       │   └── injection/ # 注入防御（core, verification, meta）
│   │       └── builder.ts     # Prompt 组装器
│   ├── tools/           # gen1-gen4 工具实现
│   │   ├── gen1/        # bash, read_file, write_file, edit_file
│   │   ├── gen2/        # glob, grep, list_directory
│   │   ├── gen3/        # task, todo_write, ask_user_question
│   │   ├── gen4/        # skill, web_fetch, read_pdf, mcp
│   │   ├── fileReadTracker.ts           # 文件读取跟踪
│   │   ├── backgroundTaskPersistence.ts # 后台任务持久化
│   │   └── utils/
│   │       ├── quoteNormalizer.ts       # 智能引号规范化
│   │       └── externalModificationDetector.ts # 外部修改检测
│   ├── security/        # 安全模块 (v0.9+)
│   │   ├── commandMonitor.ts     # 命令执行监控
│   │   ├── sensitiveDetector.ts  # 敏感信息检测
│   │   ├── auditLogger.ts        # JSONL 审计日志
│   │   └── logMasker.ts          # 日志掩码
│   ├── hooks/           # Hooks 系统 (v0.9+)
│   │   ├── configParser.ts  # 配置解析
│   │   ├── scriptExecutor.ts # 脚本执行
│   │   ├── events.ts         # 11种事件类型
│   │   ├── merger.ts         # 多源合并
│   │   └── promptHook.ts     # AI 评估 Hook
│   ├── context/         # 上下文管理 (v0.9+)
│   │   ├── tokenEstimator.ts  # Token 估算
│   │   ├── compressor.ts      # 增量压缩
│   │   ├── codePreserver.ts   # 代码块保留
│   │   └── summarizer.ts      # AI 摘要
│   ├── services/        # Auth, Sync, Database
│   ├── memory/          # 向量存储和记忆系统
│   ├── hooks/           # 用户可配置 Hooks 系统
│   ├── errors/          # 统一错误类型和处理
│   └── utils/           # 性能监控等工具函数
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
| Gen3 | + task, todo_write, ask_user_question, confirm_action, read_clipboard, plan_read, plan_update, enter_plan_mode, exit_plan_mode, findings_write |
| Gen4 | + skill, web_fetch, web_search, read_pdf, mcp, mcp_list_tools, mcp_list_resources, mcp_read_resource, mcp_get_status |
| Gen5 | + memory_store, memory_search, code_index, auto_learn, ppt_generate, image_generate, image_analyze, docx_generate, excel_generate |
| Gen6 | + screenshot, computer_use, browser_navigate, browser_action |
| Gen7 | + spawn_agent, agent_message, workflow_orchestrate |
| Gen8 | + strategy_optimize, tool_create, self_evaluate, learn_pattern |

---

## Gen3 计划与交互工具

Gen3 引入了计划模式、任务管理和用户交互能力。

### ask_user_question - 向用户提问

向用户提问并获取回复，支持预设选项。

```bash
# 简单问题
ask_user_question { "question": "你想使用哪个数据库？" }

# 带预设选项
ask_user_question {
  "question": "选择部署环境",
  "options": ["development", "staging", "production"]
}

# 多选模式
ask_user_question {
  "question": "需要启用哪些功能？",
  "options": ["日志", "监控", "报警"],
  "allowMultiple": true
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `question` | string | 问题内容（必填）|
| `options` | string[] | 预设选项（可选）|
| `allowMultiple` | boolean | 是否允许多选（默认 false）|

### todo_write - 任务清单管理

管理会话内的任务清单，跟踪工作进度。

```bash
# 添加任务
todo_write { "action": "add", "task": "实现用户认证模块" }

# 标记完成
todo_write { "action": "complete", "taskId": "task_1" }

# 更新任务
todo_write { "action": "update", "taskId": "task_1", "task": "实现 OAuth 2.0 认证" }

# 删除任务
todo_write { "action": "remove", "taskId": "task_1" }

# 列出所有任务
todo_write { "action": "list" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string | 操作类型: add, complete, update, remove, list |
| `task` | string | 任务描述（add/update 时必填）|
| `taskId` | string | 任务 ID（complete/update/remove 时必填）|

### task - 后台任务执行

在后台执行长时间运行的任务，支持超时控制。

```bash
# 执行后台任务
task {
  "command": "npm run build",
  "description": "构建项目",
  "timeout": 300000
}

# 查询任务状态
task { "action": "status", "taskId": "task_xxx" }

# 取消任务
task { "action": "cancel", "taskId": "task_xxx" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `command` | string | 要执行的命令 |
| `description` | string | 任务描述 |
| `timeout` | number | 超时时间（毫秒，默认 120000）|
| `action` | string | 操作类型: status, cancel |
| `taskId` | string | 任务 ID |

### confirm_action - 确认危险操作

在执行危险操作前请求用户确认。

```bash
# 确认删除操作
confirm_action {
  "action": "删除 node_modules 目录",
  "reason": "清理依赖以解决版本冲突",
  "severity": "high"
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string | 要执行的操作描述 |
| `reason` | string | 执行原因 |
| `severity` | string | 严重程度: low, medium, high |

### read_clipboard - 读取剪贴板

读取系统剪贴板内容。

```bash
# 读取剪贴板
read_clipboard {}

# 读取并指定格式
read_clipboard { "format": "text" }
```

### 计划模式工具

Gen3 引入计划模式，允许 Agent 在执行前制定详细计划。

**enter_plan_mode** - 进入计划模式：
```bash
enter_plan_mode { "reason": "需要规划复杂的重构任务" }
```

**exit_plan_mode** - 退出计划模式：
```bash
exit_plan_mode { "summary": "计划完成，准备开始执行" }
```

**plan_read** - 读取当前计划：
```bash
plan_read {}
```

**plan_update** - 更新计划：
```bash
plan_update {
  "steps": [
    { "id": 1, "description": "分析现有代码结构", "status": "pending" },
    { "id": 2, "description": "设计新接口", "status": "pending" }
  ]
}
```

### findings_write - 记录发现

在分析过程中记录重要发现，用于后续参考。

```bash
# 记录发现
findings_write {
  "category": "security",
  "finding": "发现 SQL 注入风险",
  "location": "src/api/users.ts:42",
  "severity": "high"
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `category` | string | 分类: bug, security, performance, style |
| `finding` | string | 发现描述 |
| `location` | string | 代码位置 |
| `severity` | string | 严重程度 |

---

## Gen4 网络工具

### web_fetch - HTTP 请求

发送 HTTP 请求并获取响应内容。

```bash
# GET 请求
web_fetch { "url": "https://api.example.com/data" }

# POST 请求
web_fetch {
  "url": "https://api.example.com/submit",
  "method": "POST",
  "headers": { "Content-Type": "application/json" },
  "body": "{\"name\": \"test\"}"
}

# 带认证
web_fetch {
  "url": "https://api.example.com/private",
  "headers": { "Authorization": "Bearer token123" }
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | string | 请求 URL（必填）|
| `method` | string | HTTP 方法（默认 GET）|
| `headers` | object | 请求头 |
| `body` | string | 请求体 |
| `timeout` | number | 超时时间（毫秒）|

### web_search - 网络搜索

使用搜索引擎搜索信息（需配置 API Key）。

```bash
# 基础搜索
web_search { "query": "TypeScript best practices 2024" }

# 限制结果数量
web_search { "query": "React hooks tutorial", "limit": 5 }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string | 搜索关键词（必填）|
| `limit` | number | 返回结果数量（默认 10）|

**要求**：需配置 Brave Search API Key 或使用云端代理。

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

`ppt_generate` 工具直接生成 `.pptx` 文件，可用 PowerPoint/Keynote/WPS 打开：

| 主题 | 风格 | 特点 |
|------|------|------|
| `professional` | 专业商务 | 蓝白配色，适合正式场合 |
| `tech` | 科技风格 | 深色背景，青色点缀 |
| `minimal` | 极简风格 | 浅灰背景，简洁清爽 |
| `vibrant` | 活力风格 | 紫粉配色，适合创意展示 |

**使用示例：**

```bash
# 基础用法
ppt_generate { "topic": "产品介绍", "slides_count": 5 }

# 指定主题风格
ppt_generate { "topic": "技术分享", "theme": "tech", "slides_count": 8 }

# 提供详细内容大纲（Markdown 格式）
ppt_generate { "topic": "年度总结", "content": "# 背景\n- 要点1\n# 成果\n- 成果1" }
```

**输出**：直接生成 `.pptx` 文件，在工具结果中展示为可点击的附件，点击即可打开。

### Gen5 图片生成

`image_generate` 工具通过 OpenRouter API 调用 FLUX 模型生成图片：

| 用户类型 | 模型 | 特点 |
|---------|------|------|
| 管理员 (isAdmin: true) | FLUX 1.1 Pro | 最高质量，约 $0.04/张 |
| 普通用户 | FLUX Schnell | 快速免费 |

**使用示例：**

```bash
# 基础用法
image_generate { "prompt": "sunset over mountains" }

# 使用 prompt 扩展 + 指定宽高比
image_generate { "prompt": "一只猫", "expand_prompt": true, "aspect_ratio": "16:9" }

# 保存到文件 + 风格指定
image_generate { "prompt": "产品展示图", "output_path": "./product.png", "style": "photo" }
```

**参数说明：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `prompt` | string | 图片描述（必填，支持中英文）|
| `expand_prompt` | boolean | 使用 LLM 扩展优化 prompt |
| `aspect_ratio` | string | 宽高比: "1:1", "16:9", "9:16", "4:3", "3:4" |
| `output_path` | string | 保存路径（不填返回 base64）|
| `style` | string | 风格: "photo", "illustration", "3d", "anime" |

**要求**：需要配置 OpenRouter API Key，或通过云端代理使用。

### Gen5 图片分析

`image_analyze` 工具使用 Gemini 2.0 Flash 视觉模型分析图片，支持单图分析和批量筛选：

**单图分析模式：**

```bash
# 分析单张图片
image_analyze { "path": "photo.jpg", "prompt": "这张图片里有什么动物？" }

# 识别 App 截图
image_analyze { "path": "screenshot.png", "prompt": "这是哪个 App 的截图？" }
```

**批量筛选模式：**

```bash
# 从相册中筛选有猫的照片
image_analyze { "paths": ["/Users/xxx/Photos/*.jpg"], "filter": "有猫的照片" }

# 筛选包含文字的图片
image_analyze { "paths": ["img1.png", "img2.png", "img3.png"], "filter": "包含文字的图片" }
```

**参数说明：**

| 参数 | 类型 | 说明 |
|------|------|------|
| `path` | string | 单张图片路径（单图模式）|
| `prompt` | string | 分析提示（单图模式，默认"描述图片内容"）|
| `paths` | string[] | 图片路径数组，支持 glob 模式（批量模式）|
| `filter` | string | 筛选条件（批量模式）|
| `detail` | string | 图片精度: "low"(默认,更便宜) \| "high"(更准确) |

**成本估算：**
- 100 张图片 ≈ $0.001（几乎免费）
- 最大并行处理 10 张

### Gen5 Word 文档生成

`docx_generate` 工具生成 Word 文档（.docx），支持 Markdown 格式内容：

```bash
# 生成报告
docx_generate { "title": "项目报告", "content": "# 概述\n这是一份报告..." }

# 使用学术风格
docx_generate { "title": "论文", "content": "## 摘要\n...", "theme": "academic" }
```

**支持的 Markdown 格式：**
- 标题（# ## ###）
- 列表（- 或 1.）
- 粗体、斜体、代码
- 引用块、代码块
- 表格

**主题选项：** professional、academic、minimal、creative

### Gen5 Excel 表格生成

`excel_generate` 工具生成 Excel 表格（.xlsx），支持多种输入格式：

```bash
# JSON 数组
excel_generate { "title": "员工名单", "data": "[{\"姓名\": \"张三\", \"部门\": \"技术部\"}]" }

# Markdown 表格
excel_generate { "title": "销售数据", "data": "| 月份 | 销售额 |\n|---|---|\n| 1月 | 10000 |" }

# CSV 格式
excel_generate { "title": "数据表", "data": "name,age\n张三,25\n李四,30" }
```

**主题选项：** professional、colorful、minimal、dark

---

## Gen5 记忆与学习工具

Gen5 引入向量存储记忆系统和自动学习能力。

### memory_store - 存储记忆

将信息存储到向量数据库，支持语义检索。

```bash
# 存储代码模式
memory_store {
  "content": "使用 useMemo 优化 React 组件渲染性能",
  "type": "pattern",
  "tags": ["react", "performance", "hooks"]
}

# 存储项目知识
memory_store {
  "content": "项目使用 pnpm workspace 管理 monorepo",
  "type": "knowledge",
  "metadata": { "project": "code-agent" }
}

# 存储用户偏好
memory_store {
  "content": "用户偏好使用 Tailwind CSS 而非 styled-components",
  "type": "preference"
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `content` | string | 要存储的内容（必填）|
| `type` | string | 类型: pattern, knowledge, preference, snippet |
| `tags` | string[] | 标签，用于筛选 |
| `metadata` | object | 额外元数据 |

### memory_search - 搜索记忆

语义搜索存储的记忆。

```bash
# 语义搜索
memory_search { "query": "React 性能优化技巧" }

# 按类型筛选
memory_search { "query": "数据库连接", "type": "knowledge" }

# 限制结果数量
memory_search { "query": "用户偏好", "limit": 5 }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string | 搜索查询（必填）|
| `type` | string | 筛选类型 |
| `tags` | string[] | 筛选标签 |
| `limit` | number | 返回数量（默认 10）|

### code_index - 代码索引

建立和查询代码库索引，支持符号跳转和引用查找。

```bash
# 索引当前项目
code_index { "action": "index", "path": "." }

# 查找符号定义
code_index { "action": "definition", "symbol": "UserService" }

# 查找引用
code_index { "action": "references", "symbol": "handleSubmit" }

# 搜索代码
code_index { "action": "search", "query": "async function" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string | 操作: index, definition, references, search |
| `path` | string | 索引路径（index 时）|
| `symbol` | string | 符号名称 |
| `query` | string | 搜索查询 |

### auto_learn - 自动学习

从代码库和会话中自动提取知识。

```bash
# 学习项目模式
auto_learn { "source": "codebase", "path": "src/" }

# 学习会话内容
auto_learn { "source": "session" }

# 学习特定文件
auto_learn { "source": "file", "path": "src/utils/helpers.ts" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `source` | string | 来源: codebase, session, file |
| `path` | string | 文件/目录路径 |
| `depth` | number | 学习深度（默认 2）|

---

## Gen6 视觉与浏览器工具

Gen6 引入计算机视觉和浏览器自动化能力。

### screenshot - 屏幕截图

捕获屏幕、窗口或区域截图。

```bash
# 全屏截图
screenshot {}

# 截取指定窗口
screenshot { "window": "Code Agent" }

# 截取指定区域
screenshot { "region": { "x": 0, "y": 0, "width": 800, "height": 600 } }

# 保存到文件
screenshot { "output": "./screenshot.png" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `window` | string | 窗口标题 |
| `region` | object | 截取区域 {x, y, width, height} |
| `output` | string | 保存路径 |
| `format` | string | 格式: png, jpeg（默认 png）|

### computer_use - 计算机操作

模拟键盘和鼠标操作。

```bash
# 鼠标点击
computer_use { "action": "click", "x": 100, "y": 200 }

# 双击
computer_use { "action": "doubleClick", "x": 100, "y": 200 }

# 右键点击
computer_use { "action": "rightClick", "x": 100, "y": 200 }

# 键盘输入
computer_use { "action": "type", "text": "Hello World" }

# 按键
computer_use { "action": "key", "key": "Enter" }

# 组合键
computer_use { "action": "hotkey", "keys": ["Command", "S"] }

# 鼠标拖拽
computer_use { "action": "drag", "from": { "x": 100, "y": 100 }, "to": { "x": 200, "y": 200 } }

# 滚动
computer_use { "action": "scroll", "direction": "down", "amount": 3 }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string | 操作类型（见上方示例）|
| `x`, `y` | number | 坐标位置 |
| `text` | string | 输入文本 |
| `key` | string | 按键名称 |
| `keys` | string[] | 组合键 |

### browser_navigate - 浏览器导航

控制浏览器导航（基于系统命令）。

```bash
# 打开 URL
browser_navigate { "action": "open", "url": "https://example.com" }

# 后退
browser_navigate { "action": "back" }

# 前进
browser_navigate { "action": "forward" }

# 刷新
browser_navigate { "action": "refresh" }

# 新标签页
browser_navigate { "action": "newTab" }

# 关闭标签页
browser_navigate { "action": "close" }

# 指定浏览器
browser_navigate { "action": "open", "url": "https://example.com", "browser": "chrome" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string | 操作: open, navigate, back, forward, refresh, close, newTab, switchTab |
| `url` | string | 目标 URL |
| `browser` | string | 浏览器: default, chrome, firefox, safari, edge |

### browser_action - 浏览器自动化

基于 Playwright 的完整浏览器自动化，支持复杂交互。

```bash
# 启动浏览器
browser_action { "action": "launch" }

# 打开新标签页并导航
browser_action { "action": "new_tab", "url": "https://example.com" }

# 点击元素（CSS 选择器）
browser_action { "action": "click", "selector": "button.submit" }

# 点击元素（按文本）
browser_action { "action": "click_text", "text": "Sign In" }

# 输入文本
browser_action { "action": "type", "selector": "#search", "text": "hello" }

# 按键
browser_action { "action": "press_key", "key": "Enter" }

# 滚动页面
browser_action { "action": "scroll", "direction": "down", "amount": 500 }

# 截图
browser_action { "action": "screenshot", "fullPage": true }

# 获取页面内容
browser_action { "action": "get_content" }

# 查找元素
browser_action { "action": "get_elements", "selector": "a.link" }

# 等待元素
browser_action { "action": "wait", "selector": ".loading", "timeout": 5000 }

# 填充表单
browser_action {
  "action": "fill_form",
  "formData": {
    "#username": "user@example.com",
    "#password": "secret"
  }
}

# 列出标签页
browser_action { "action": "list_tabs" }

# 关闭浏览器
browser_action { "action": "close" }

# 获取调试日志
browser_action { "action": "get_logs" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string | 操作类型（见上方示例）|
| `url` | string | URL |
| `selector` | string | CSS 选择器 |
| `text` | string | 文本内容 |
| `key` | string | 按键 |
| `direction` | string | 滚动方向: up, down |
| `amount` | number | 滚动量（像素）|
| `fullPage` | boolean | 全页截图 |
| `formData` | object | 表单数据 {selector: value} |
| `timeout` | number | 超时时间（毫秒）|

**注意**：使用前需先 `launch` 启动浏览器，使用完毕后 `close` 关闭。

---

## Gen7 多代理工具

Gen7 引入多代理协作能力。

### spawn_agent - 创建子代理

创建专业化子代理执行特定任务。

**预定义角色：**

| 角色 | 描述 | 可用工具 |
|------|------|----------|
| `coder` | 编写代码 | bash, read_file, write_file, edit_file, glob, grep |
| `reviewer` | 代码审查 | read_file, glob, grep |
| `tester` | 编写测试 | bash, read_file, write_file, edit_file, glob |
| `architect` | 架构设计 | read_file, glob, grep, write_file |
| `debugger` | 调试问题 | bash, read_file, edit_file, glob, grep |
| `documenter` | 编写文档 | read_file, write_file, edit_file, glob |

```bash
# 使用预定义角色
spawn_agent {
  "role": "coder",
  "task": "实现用户登录功能，包含表单验证"
}

# 后台运行
spawn_agent {
  "role": "tester",
  "task": "为 UserService 编写单元测试",
  "waitForCompletion": false
}

# 自定义代理（动态模式）
spawn_agent {
  "task": "分析 API 响应时间",
  "customPrompt": "你是性能分析专家，专注于 API 性能优化",
  "customTools": ["bash", "read_file", "grep"]
}

# 并行执行多个代理
spawn_agent {
  "parallel": true,
  "agents": [
    { "role": "reviewer", "task": "审查 PR #123 的代码质量" },
    { "role": "tester", "task": "为 PR #123 的改动编写测试" }
  ]
}

# 带依赖的并行执行
spawn_agent {
  "parallel": true,
  "agents": [
    { "role": "coder", "task": "实现功能 A" },
    { "role": "coder", "task": "实现功能 B" },
    { "role": "tester", "task": "测试功能 A 和 B", "dependsOn": ["agent_coder_0", "agent_coder_1"] }
  ]
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `role` | string | 预定义角色 |
| `task` | string | 任务描述（必填）|
| `customPrompt` | string | 自定义系统提示（动态模式）|
| `customTools` | string[] | 自定义工具列表 |
| `waitForCompletion` | boolean | 是否等待完成（默认 true）|
| `maxIterations` | number | 最大迭代次数（默认 20）|
| `maxBudget` | number | 最大预算（USD）|
| `parallel` | boolean | 启用并行执行 |
| `agents` | array | 并行代理列表 |

### agent_message - 代理通信

与已创建的代理通信和管理。

```bash
# 列出所有代理
agent_message { "action": "list" }

# 查询代理状态
agent_message { "action": "status", "agentId": "agent_coder_123" }

# 获取代理结果
agent_message { "action": "result", "agentId": "agent_coder_123" }

# 取消代理
agent_message { "action": "cancel", "agentId": "agent_coder_123" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `action` | string | 操作: list, status, result, cancel |
| `agentId` | string | 代理 ID |

### workflow_orchestrate - 工作流编排

编排多代理工作流。

**预定义工作流模板：**

| 模板 | 描述 | 流程 |
|------|------|------|
| `code-review-pipeline` | 代码审查流水线 | Coder → Reviewer → Tester |
| `bug-fix-flow` | Bug 修复流程 | Debugger → Coder → Tester |
| `documentation-flow` | 文档生成流程 | Architect → Documenter |
| `parallel-review` | 并行审查 | Reviewer + Tester |

```bash
# 使用预定义工作流
workflow_orchestrate {
  "workflow": "code-review-pipeline",
  "task": "实现用户认证功能"
}

# 使用 bug 修复流程
workflow_orchestrate {
  "workflow": "bug-fix-flow",
  "task": "修复登录超时问题"
}

# 自定义工作流
workflow_orchestrate {
  "workflow": "custom",
  "task": "重构数据层",
  "stages": [
    { "name": "分析", "role": "architect", "prompt": "分析现有数据层架构" },
    { "name": "重构", "role": "coder", "prompt": "实施重构", "dependsOn": ["分析"] },
    { "name": "测试", "role": "tester", "prompt": "编写测试", "dependsOn": ["重构"] },
    { "name": "文档", "role": "documenter", "prompt": "更新文档", "dependsOn": ["重构"] }
  ]
}

# 并行执行（无依赖的阶段并行运行）
workflow_orchestrate {
  "workflow": "parallel-review",
  "task": "审查 PR #456",
  "parallel": true
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `workflow` | string | 工作流模板名或 "custom" |
| `task` | string | 总体任务描述 |
| `stages` | array | 自定义阶段（custom 时必填）|
| `parallel` | boolean | 独立阶段是否并行（默认 true）|

---

## Gen8 自进化工具

Gen8 引入自我优化和工具创建能力。

### strategy_optimize - 策略优化

优化任务执行策略。

```bash
# 优化执行策略
strategy_optimize {
  "task": "代码审查",
  "currentStrategy": "逐文件审查",
  "metrics": { "time": 300, "accuracy": 0.85 }
}

# 分析历史性能
strategy_optimize {
  "action": "analyze",
  "taskType": "code-review"
}

# 应用优化建议
strategy_optimize {
  "action": "apply",
  "optimizationId": "opt_123"
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `task` | string | 任务类型 |
| `currentStrategy` | string | 当前策略描述 |
| `metrics` | object | 性能指标 |
| `action` | string | 操作: analyze, apply |

### tool_create - 动态创建工具

在运行时创建新工具。

```bash
# 创建简单工具
tool_create {
  "name": "format_json",
  "description": "格式化 JSON 字符串",
  "type": "sandboxed_js",
  "code": "return JSON.stringify(JSON.parse(input.json), null, 2);",
  "parameters": {
    "json": { "type": "string", "description": "JSON 字符串" }
  }
}

# 创建文件处理工具
tool_create {
  "name": "count_lines",
  "description": "统计文件行数",
  "type": "sandboxed_js",
  "code": "return input.content.split('\\n').length;",
  "parameters": {
    "content": { "type": "string", "description": "文件内容" }
  }
}

# 列出创建的工具
tool_create { "action": "list" }

# 删除工具
tool_create { "action": "delete", "name": "format_json" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `name` | string | 工具名称 |
| `description` | string | 工具描述 |
| `type` | string | 类型: sandboxed_js |
| `code` | string | 工具代码 |
| `parameters` | object | 参数定义 |
| `action` | string | 操作: list, delete |

**安全说明**：动态创建的工具在沙箱中运行（isolated-vm），无法访问文件系统和网络。

### self_evaluate - 自我评估

评估任务执行质量和效率。

```bash
# 评估当前任务
self_evaluate {
  "task": "实现用户认证",
  "result": "完成了登录、注册、密码重置功能",
  "metrics": { "files_changed": 5, "tests_added": 12 }
}

# 评估代码质量
self_evaluate {
  "type": "code_quality",
  "files": ["src/auth/login.ts", "src/auth/register.ts"]
}

# 评估测试覆盖率
self_evaluate {
  "type": "test_coverage",
  "path": "src/auth/"
}
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `task` | string | 任务描述 |
| `result` | string | 执行结果 |
| `metrics` | object | 相关指标 |
| `type` | string | 评估类型: task, code_quality, test_coverage |
| `files` | string[] | 要评估的文件 |

### learn_pattern - 模式学习

从代码和行为中学习模式。

```bash
# 学习代码模式
learn_pattern {
  "source": "code",
  "path": "src/components/",
  "patternType": "component_structure"
}

# 学习命名约定
learn_pattern {
  "source": "code",
  "path": "src/",
  "patternType": "naming_convention"
}

# 学习用户偏好
learn_pattern {
  "source": "session",
  "patternType": "user_preference"
}

# 查看已学习模式
learn_pattern { "action": "list" }

# 应用模式
learn_pattern { "action": "apply", "patternId": "pattern_123" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `source` | string | 来源: code, session, history |
| `path` | string | 代码路径 |
| `patternType` | string | 模式类型 |
| `action` | string | 操作: list, apply |
| `patternId` | string | 模式 ID |

## 安全模块 (v0.9+)

运行时安全监控，敏感信息检测，审计日志。

### 审计日志

所有工具执行自动记录到 JSONL 日志：

```bash
# 查看今天的审计日志
cat ~/.code-agent/audit/$(date +%Y-%m-%d).jsonl | jq .
```

### 敏感信息检测

自动检测并掩码：
- API Keys (`api_key=sk-...`)
- AWS 凭证 (`AKIA...`, Secret Key)
- GitHub Tokens (`ghp_...`, `ghs_...`)
- 私钥 (`-----BEGIN ... PRIVATE KEY-----`)
- 数据库 URL (`postgres://user:pass@...`)

### 配置

```json
// .claude/settings.json
{
  "security": {
    "auditLog": {
      "enabled": true,
      "retentionDays": 30
    },
    "sensitiveDetection": {
      "enabled": true
    },
    "commandMonitor": {
      "blockedPatterns": ["rm -rf /"],
      "warningPatterns": ["sudo"]
    }
  }
}
```

---

## Hooks 系统 (v0.9+)

用户可配置的事件钩子，支持 11 种事件类型。

### 事件类型

| 事件 | 触发时机 |
|------|----------|
| `PreToolUse` | 工具执行前 |
| `PostToolUse` | 工具执行后（成功）|
| `PostToolUseFailure` | 工具执行后（失败）|
| `UserPromptSubmit` | 用户提交 prompt |
| `SessionStart` | 会话开始 |
| `SessionEnd` | 会话结束 |
| `Stop` | Agent 停止 |
| `SubagentStop` | 子代理停止 |
| `PreCompact` | 上下文压缩前 |
| `Setup` | 初始化时 |
| `Notification` | 通知事件 |

### 配置示例

```json
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/validate-command.sh",
            "timeout": 5000
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "matcher": ".*",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/cleanup.sh"
          }
        ]
      }
    ]
  }
}
```

### Hook 脚本环境变量

| 变量 | 说明 |
|------|------|
| `TOOL_NAME` | 工具名称 |
| `TOOL_INPUT` | JSON 格式的工具输入 |
| `SESSION_ID` | 当前会话 ID |
| `FILE_PATH` | 文件路径（文件操作时）|
| `COMMAND` | 命令（Bash 工具时）|

---

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

## 用户可配置 Hooks 系统

基于 Claude Code v2.0 架构的 Hooks 系统，允许用户自定义 Agent 行为。

### Hook 事件类型

| 事件 | 触发时机 | 用途 |
|------|----------|------|
| `PreToolUse` | 工具执行前 | 验证/拦截工具调用 |
| `PostToolUse` | 工具成功后 | 记录/分析工具结果 |
| `PostToolUseFailure` | 工具失败后 | 错误处理/重试逻辑 |
| `UserPromptSubmit` | 用户提交消息时 | 过滤/预处理输入 |
| `Stop` | Agent 准备停止时 | 验证任务完成度 |
| `SessionStart` | 会话开始时 | 初始化/环境设置 |
| `SessionEnd` | 会话结束时 | 清理/日志记录 |
| `Notification` | 通知触发时 | 自定义通知处理 |

### 配置位置

Hooks 配置在 `.claude/settings.json` 中：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "matcher": "bash|write_file",
        "command": "/path/to/validator.sh"
      }
    ],
    "PostToolUse": [
      {
        "type": "prompt",
        "prompt": "分析工具 $TOOL_NAME 的执行结果: $OUTPUT"
      }
    ]
  }
}
```

### Hook 类型

| 类型 | 说明 | 返回值 |
|------|------|--------|
| `command` | 执行 shell 脚本 | 退出码 0=允许, 2=拦截 |
| `prompt` | AI 评估（需要配置 AI 函数）| JSON: `{"action": "allow/block/continue"}` |

### 环境变量

脚本 Hook 可访问以下环境变量：

| 变量 | 说明 |
|------|------|
| `HOOK_EVENT` | 事件类型 |
| `HOOK_SESSION_ID` | 会话 ID |
| `HOOK_WORKING_DIR` | 工作目录 |
| `HOOK_TOOL_NAME` | 工具名（工具事件）|
| `HOOK_TOOL_INPUT` | 工具输入（JSON）|
| `HOOK_TOOL_OUTPUT` | 工具输出（PostToolUse）|
| `HOOK_ERROR_MESSAGE` | 错误信息（PostToolUseFailure）|
| `HOOK_USER_PROMPT` | 用户输入（UserPromptSubmit）|

### 使用示例

**拦截危险命令：**

```bash
#!/bin/bash
# .claude/hooks/validate-bash.sh
if echo "$HOOK_TOOL_INPUT" | grep -q "rm -rf"; then
  echo "危险命令被拦截"
  exit 2  # 拦截
fi
exit 0  # 允许
```

**配置：**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "matcher": "bash",
        "command": ".claude/hooks/validate-bash.sh"
      }
    ]
  }
}
```

### 架构说明

- **HookManager**: 统一 API，管理 hook 配置加载和执行
- **configParser**: 解析 `.claude/settings.json` 中的 hooks 配置
- **scriptExecutor**: 执行 shell 脚本并注入环境变量
- **promptHook**: 使用 AI 评估 hook 条件
- **merger**: 合并全局和项目级 hooks 配置

代码位置：`src/main/hooks/`

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

> 注意：由于 Vercel Hobby 计划 12 函数限制，运维类 API 已整合

| 端点 | 说明 |
|------|------|
| /api/agent | 云端 Agent |
| /api/auth | GitHub OAuth 认证 |
| /api/model-proxy | 模型代理 |
| /api/prompts | System Prompt |
| /api/sync | 数据同步 |
| /api/system | 运维整合（health/init-db/migrate）|
| /api/tools | 云端工具（api/scrape/search/ppt）|
| /api/update | 版本更新检查 |
| /api/user-keys | 用户 API Key 管理 |
| /api/v1/config | 云端配置中心 |

**system.ts 用法**：
```bash
# 健康检查
curl "https://code-agent-beta.vercel.app/api/system?action=health"

# 初始化数据库（需要 X-Init-Key header）
curl -X POST "https://code-agent-beta.vercel.app/api/system?action=init-db" \
  -H "X-Init-Key: $DB_INIT_KEY"

# 数据库迁移
curl -X POST "https://code-agent-beta.vercel.app/api/system?action=migrate" \
  -H "X-Init-Key: $DB_INIT_KEY"
```

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
2. 当前已合并：
   - `tools.ts` 包含 api/scrape/search 三个功能
   - `system.ts` 包含 health/init-db/migrate 三个功能
3. 当前 API 数量：10 个（预留 2 个空间）
4. 未来扩展策略：核心 API 保留主仓库，通用工具可拆到独立仓库

### GitHub Secret Scanning 阻止 Push
**问题**: Git push 被 GitHub 阻止，错误 "Push cannot contain secrets"
**原因**: 测试文件中使用了符合真实 API key 格式的字符串（如 `xoxb-*` Slack token, `sk_live_*` Stripe key）
**正确做法**:
1. **不要在代码中硬编码**任何符合 API key 格式的字符串，即使是测试用途
2. 使用运行时字符串构建来生成测试数据：
   ```typescript
   // ❌ 错误 - 会被 GitHub 检测
   const text = 'xoxb-123456789012-123456789012-abcdefghij';

   // ✅ 正确 - 运行时构建
   const buildSlackToken = (prefix: string) =>
     `${prefix}-${'1'.repeat(12)}-${'2'.repeat(12)}-${'a'.repeat(10)}`;
   const text = buildSlackToken('xoxb');
   ```
3. 常见被检测的格式：
   - Slack: `xoxb-*`, `xoxp-*`, `xoxa-*`
   - Stripe: `sk_live_*`, `sk_test_*`, `pk_live_*`, `pk_test_*`
   - GitHub: `ghp_*`, `gho_*`, `ghu_*`, `ghs_*`, `ghr_*`
   - AWS: `AKIA*`, `ASIA*`
4. 如果历史提交已包含问题字符串，需要用 `git filter-branch` 重写历史

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
