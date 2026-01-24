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

### Gen3 规划与交互工具

Gen3 引入任务规划和用户交互能力。

#### confirm_action - 危险操作确认

弹窗确认危险或不可逆的操作：

```bash
# 删除文件前确认
confirm_action { "title": "删除文件", "message": "确定要删除以下 5 个文件吗？", "type": "danger" }

# 执行危险命令前确认
confirm_action { "title": "执行命令", "message": "将执行 rm -rf ./dist", "type": "warning", "confirmText": "执行", "cancelText": "取消" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `title` | string | 对话框标题（必填）|
| `message` | string | 详细说明（必填）|
| `type` | string | danger（红色）/ warning（黄色）/ info（蓝色）|
| `confirmText` | string | 确认按钮文字（默认"确认"）|
| `cancelText` | string | 取消按钮文字（默认"取消"）|

**返回**: `confirmed` 或 `cancelled`

#### read_clipboard - 读取剪贴板

读取系统剪贴板内容（文本或图片）：

```bash
# 自动检测格式
read_clipboard {}

# 只读取文本
read_clipboard { "format": "text" }

# 只读取图片
read_clipboard { "format": "image" }
```

#### plan_read / plan_update - 任务计划管理

管理 task_plan.md 中的任务计划：

```bash
# 读取当前计划
plan_read {}

# 读取简要摘要
plan_read { "summary": true }

# 更新步骤状态
plan_update { "stepContent": "实现登录功能", "status": "completed" }

# 标记步骤为跳过
plan_update { "stepContent": "优化性能", "status": "skipped", "phaseTitle": "Phase 2" }
```

#### enter_plan_mode / exit_plan_mode - 规划模式

进入/退出规划模式，用于复杂任务的设计阶段：

```bash
# 进入规划模式
enter_plan_mode { "reason": "需要设计新功能架构" }

# 退出规划模式并提交计划
exit_plan_mode { "plan": "## 实现计划\n1. 创建组件\n2. 添加逻辑\n3. 编写测试" }
```

**规划模式期间**：
- ✅ 可以：读取文件、搜索代码、分析架构
- ❌ 避免：执行写入操作、提交代码

#### findings_write - 保存研究发现

将重要发现保存到 findings.md：

```bash
findings_write {
  "category": "architecture",
  "title": "发现模块循环依赖",
  "content": "moduleA 和 moduleB 存在循环依赖，需要重构",
  "source": "src/modules/index.ts"
}
```

| 分类 | 说明 |
|------|------|
| `code` | 代码相关发现 |
| `architecture` | 架构设计 |
| `dependency` | 依赖库信息 |
| `issue` | 发现的问题 |
| `insight` | 一般性洞察 |

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

### Gen4 网络搜索

`web_search` 工具提供多源并行网络搜索能力：

```bash
# 基础搜索
web_search { "query": "React 18 新特性" }

# 指定搜索源和数量
web_search { "query": "TypeScript 5.0", "sources": ["google", "bing"], "limit": 5 }

# 过滤特定域名
web_search { "query": "Next.js 14", "site": "nextjs.org" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string | 搜索查询（必填）|
| `sources` | string[] | 搜索源: google, bing, duckduckgo（默认全部）|
| `limit` | number | 每个源返回的结果数（默认 3）|
| `site` | string | 限制搜索的域名 |
| `freshness` | string | 时效性: day, week, month |

**特点**：
- 多源并行搜索，聚合去重
- 自动提取页面摘要
- 支持中英文查询

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

### Gen5 记忆系统

Gen5 引入持久化记忆能力，支持跨会话知识积累。

#### memory_store - 存储长期记忆

将重要信息存入向量数据库：

```bash
# 存储用户偏好
memory_store { "content": "用户偏好使用 TypeScript 严格模式", "category": "preference" }

# 存储代码模式
memory_store { "content": "项目使用 Repository 模式处理数据访问", "category": "pattern", "key": "data-access-pattern" }

# 存储错误解决方案
memory_store { "content": "ESLint 报错 X 的解决方法是...", "category": "error_solution", "confidence": 0.9 }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `content` | string | 要存储的信息（必填）|
| `category` | string | preference / pattern / decision / context / insight / error_solution |
| `key` | string | 唯一标识，便于直接检索 |
| `confidence` | number | 置信度 0-1（默认 1.0）|

**安全机制**：自动检测并拒绝存储敏感信息（API Keys、密码等）。

#### memory_search - 搜索记忆

语义搜索存储的知识：

```bash
# 搜索相关记忆
memory_search { "query": "用户的代码风格偏好" }

# 按分类过滤
memory_search { "query": "数据库连接", "category": "error_solution", "limit": 3 }

# 搜索特定来源
memory_search { "query": "架构决策", "source": "knowledge" }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `query` | string | 搜索查询（必填）|
| `category` | string | 过滤分类 |
| `source` | string | knowledge / conversation / file / all |
| `limit` | number | 最大结果数（默认 5）|

#### code_index - 代码索引

建立代码库的语义索引，实现智能代码搜索：

```bash
# 索引项目代码
code_index { "action": "index", "pattern": "**/*.ts" }

# 语义搜索代码
code_index { "action": "search", "query": "处理用户认证的函数" }

# 查看索引状态
code_index { "action": "status" }
```

| Action | 说明 |
|--------|------|
| `index` | 索引匹配 pattern 的文件 |
| `search` | 语义搜索代码 |
| `status` | 查看索引统计 |

**默认索引模式**：`**/*.{ts,tsx,js,jsx,py,go,rs}`

#### auto_learn - 自动学习

自动从会话中提取并保存有价值的信息：

```bash
# 分析会话并学习
auto_learn { "action": "analyze" }

# 批量保存学到的知识
auto_learn { "action": "save", "insights": ["用户偏好...", "项目使用..."] }

# 查看学习历史
auto_learn { "action": "history", "limit": 10 }
```

**自动学习的内容**：
- 用户编码偏好和习惯
- 项目特定的模式和约定
- 错误解决方案
- 架构决策和理由

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

### Gen6 计算机控制

Gen6 引入计算机使用能力，可以控制屏幕、鼠标和键盘。

#### screenshot - 屏幕截图

捕获屏幕或特定窗口的截图：

```bash
# 截取全屏
screenshot {}

# 截取特定窗口
screenshot { "target": "window", "windowName": "Visual Studio Code" }

# 保存到指定路径
screenshot { "outputPath": "./screenshots/debug.png" }

# 截取特定区域
screenshot { "region": { "x": 100, "y": 100, "width": 800, "height": 600 } }
```

| 参数 | 类型 | 说明 |
|------|------|------|
| `target` | string | screen（全屏）/ window（窗口）|
| `windowName` | string | 窗口名称（当 target=window 时）|
| `outputPath` | string | 保存路径（默认 .screenshots/）|
| `region` | object | 截取区域 { x, y, width, height } |

**跨平台支持**：macOS（screencapture）、Linux（import）、Windows（PowerShell）

#### computer_use - 鼠标键盘控制

控制鼠标和键盘进行自动化操作：

```bash
# 点击指定位置
computer_use { "action": "click", "x": 500, "y": 300 }

# 双击
computer_use { "action": "doubleClick", "x": 500, "y": 300 }

# 输入文本
computer_use { "action": "type", "text": "Hello World" }

# 按键组合
computer_use { "action": "key", "key": "s", "modifiers": ["cmd"] }

# 滚动
computer_use { "action": "scroll", "direction": "down", "amount": 200 }

# 拖拽
computer_use { "action": "drag", "x": 100, "y": 100, "toX": 300, "toY": 300 }
```

| Action | 参数 | 说明 |
|--------|------|------|
| `click` | x, y | 单击 |
| `doubleClick` | x, y | 双击 |
| `rightClick` | x, y | 右键点击 |
| `move` | x, y | 移动鼠标 |
| `type` | text | 输入文本 |
| `key` | key, modifiers | 按键（支持 enter, tab, escape 等）|
| `scroll` | direction, amount | 滚动（up/down/left/right）|
| `drag` | x, y, toX, toY | 拖拽 |

**安全机制**：需要通过云端 Feature Flag 启用。

**提示**：使用前先调用 screenshot 了解当前屏幕状态。

#### browser_navigate - 浏览器控制

控制浏览器导航和基本交互：

```bash
# 打开 URL
browser_navigate { "action": "open", "url": "https://example.com" }

# 使用特定浏览器
browser_navigate { "action": "open", "url": "https://example.com", "browser": "chrome" }

# 浏览器操作
browser_navigate { "action": "back" }
browser_navigate { "action": "forward" }
browser_navigate { "action": "refresh" }
browser_navigate { "action": "newTab" }
browser_navigate { "action": "close" }

# 切换标签页
browser_navigate { "action": "switchTab", "tabIndex": 2 }
```

| Action | 说明 |
|--------|------|
| `open` / `navigate` | 打开/跳转到 URL |
| `back` / `forward` | 历史导航 |
| `refresh` | 刷新页面 |
| `newTab` | 新建标签页 |
| `close` | 关闭当前窗口 |
| `switchTab` | 切换标签页（需提供 tabIndex）|

| 浏览器 | macOS | Linux |
|--------|-------|-------|
| `default` | 系统默认 | xdg-open |
| `chrome` | Google Chrome | google-chrome |
| `firefox` | Firefox | firefox |
| `safari` | Safari | - |
| `edge` | Microsoft Edge | microsoft-edge |

---

### Gen7 多代理协作

Gen7 引入多代理能力，支持创建专业化子代理并协调复杂工作流。

#### spawn_agent - 创建子代理

创建专业化子代理处理特定任务：

```bash
# 使用预定义角色
spawn_agent { "role": "coder", "task": "实现用户登录功能" }

# 使用自定义代理
spawn_agent {
  "customPrompt": "你是一个安全专家，专门检查代码中的安全漏洞",
  "customTools": ["read_file", "glob", "grep"],
  "task": "检查 src/auth 目录下的安全问题"
}

# 后台运行
spawn_agent { "role": "tester", "task": "编写测试用例", "waitForCompletion": false }

# 并行执行多个代理
spawn_agent {
  "parallel": true,
  "agents": [
    { "role": "reviewer", "task": "审查代码质量" },
    { "role": "tester", "task": "编写测试用例" }
  ]
}
```

**预定义角色：**

| 角色 | 描述 | 工具 |
|------|------|------|
| `coder` | 编写高质量代码 | bash, read_file, write_file, edit_file, glob, grep |
| `reviewer` | 代码审查，发现问题 | read_file, glob, grep |
| `tester` | 编写测试用例 | bash, read_file, write_file, edit_file, glob |
| `architect` | 系统架构设计 | read_file, glob, grep, write_file |
| `debugger` | 调试和修复 bug | bash, read_file, edit_file, glob, grep |
| `documenter` | 编写文档 | read_file, write_file, edit_file, glob |

#### agent_message - 代理通信

与已创建的子代理进行交互：

```bash
# 列出所有代理
agent_message { "action": "list" }

# 检查代理状态
agent_message { "action": "status", "agentId": "agent_coder_1234567890" }

# 获取代理结果
agent_message { "action": "result", "agentId": "agent_coder_1234567890" }

# 取消运行中的代理
agent_message { "action": "cancel", "agentId": "agent_coder_1234567890" }
```

**代理状态**：
- ⏸️ `idle` - 空闲
- 🔄 `running` - 运行中
- ✅ `completed` - 已完成
- ❌ `failed` - 失败

#### workflow_orchestrate - 工作流编排

编排多代理协作完成复杂任务：

```bash
# 使用预定义工作流
workflow_orchestrate { "workflow": "code-review-pipeline", "task": "实现支付功能" }

# 使用 bug 修复流程
workflow_orchestrate { "workflow": "bug-fix-flow", "task": "修复用户无法登录的问题" }

# 自定义工作流
workflow_orchestrate {
  "workflow": "custom",
  "task": "重构认证模块",
  "stages": [
    { "name": "分析", "role": "architect", "prompt": "分析当前认证模块" },
    { "name": "实现", "role": "coder", "prompt": "重构代码", "dependsOn": ["分析"] },
    { "name": "测试", "role": "tester", "prompt": "编写测试", "dependsOn": ["实现"] }
  ],
  "parallel": true
}
```

**预定义工作流：**

| 工作流 | 描述 | 阶段 |
|--------|------|------|
| `code-review-pipeline` | 功能开发流程 | Coder → Reviewer → Tester |
| `bug-fix-flow` | Bug 修复流程 | Debugger → Coder → Tester |
| `documentation-flow` | 文档编写流程 | Architect → Documenter |
| `parallel-review` | 并行审查 | Reviewer + Tester（并行）|

---

### Gen8 自我进化

Gen8 引入自我学习和进化能力，可以从经验中学习并持续改进。

#### learn_pattern - 模式学习

学习和应用编码经验模式：

```bash
# 学习成功模式
learn_pattern {
  "action": "learn",
  "name": "React Hook 错误处理",
  "type": "success",
  "context": "在自定义 Hook 中处理异步错误",
  "pattern": "使用 try-catch 包裹 async 操作，并通过 state 暴露错误",
  "solution": "const [error, setError] = useState(null); try { ... } catch (e) { setError(e); }",
  "tags": ["react", "hooks", "error-handling"]
}

# 学习反模式
learn_pattern {
  "action": "learn",
  "name": "直接修改 Props",
  "type": "anti_pattern",
  "context": "React 组件中",
  "pattern": "直接修改传入的 props 对象",
  "solution": "使用 useState 创建本地状态副本",
  "tags": ["react", "anti-pattern"]
}

# 查找适用模式
learn_pattern { "action": "apply", "query": "React 错误处理" }

# 搜索模式
learn_pattern { "action": "search", "query": "hooks", "type": "success" }

# 列出所有模式
learn_pattern { "action": "list" }

# 强化模式（反馈）
learn_pattern { "action": "reinforce", "patternId": "pattern_123", "success": true }
```

**模式类型**：
- ✅ `success` - 成功模式，值得复用
- ❌ `failure` - 失败模式，需要避免
- ⚡ `optimization` - 优化模式，提升效率
- 🚫 `anti_pattern` - 反模式，明确禁止

#### strategy_optimize - 策略优化

管理和优化工作策略：

```bash
# 创建策略
strategy_optimize {
  "action": "create",
  "name": "TDD 开发流程",
  "description": "测试驱动开发策略",
  "steps": ["编写失败测试", "实现最小代码", "重构优化"],
  "tags": ["tdd", "testing"]
}

# 获取推荐策略
strategy_optimize { "action": "recommend", "task": "添加新功能" }

# 记录策略反馈
strategy_optimize { "action": "feedback", "strategyId": "strategy_123", "success": true, "duration": 3600000 }

# 分析策略效果
strategy_optimize { "action": "analyze", "strategyId": "strategy_123" }

# 列出所有策略
strategy_optimize { "action": "list" }
```

#### tool_create - 动态工具创建

在运行时创建新工具：

```bash
# 创建 bash 脚本工具
tool_create {
  "action": "create",
  "name": "format_code",
  "description": "格式化项目代码",
  "type": "bash_script",
  "script": "prettier --write ."
}

# 创建沙盒 JS 工具
tool_create {
  "action": "create",
  "name": "count_lines",
  "description": "统计文件行数",
  "type": "sandboxed_js",
  "code": "const content = await readFile(input.path); return content.split('\\n').length;"
}

# 使用动态工具
tool_create { "action": "use", "toolId": "format_code" }

# 列出动态工具
tool_create { "action": "list" }
```

**工具类型**：
- `bash_script` - Shell 脚本
- `sandboxed_js` - 沙盒 JavaScript（安全执行）
- `http_api` - HTTP API 调用
- `file_processor` - 文件处理器
- `composite` - 组合多个工具

**安全机制**：创建工具需要用户确认（除非开启 devModeAutoApprove）。

#### self_evaluate - 自我评估

评估和改进 Agent 性能：

```bash
# 记录任务指标
self_evaluate {
  "action": "record",
  "taskType": "coding",
  "success": true,
  "duration": 120000,
  "toolsUsed": ["read_file", "edit_file", "bash"],
  "iterations": 3
}

# 分析性能
self_evaluate { "action": "analyze", "period": 24 }

# 生成报告
self_evaluate { "action": "report", "period": 168 }

# 获取改进洞察
self_evaluate { "action": "insights" }
```

**分析维度**：
- 任务成功率
- 平均完成时间
- 工具使用效率
- 迭代次数趋势

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
