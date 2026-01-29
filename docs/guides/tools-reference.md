# Code Agent 工具参考手册

> 从 CLAUDE.md 提取的完整工具文档

## 8 代工具演进

| 代际 | 工具集 |
|------|--------|
| Gen1 | bash (PTY支持), read_file, write_file, edit_file, process_list, process_poll, process_log, process_write, process_submit, process_kill |
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
confirm_action {
  "action": "删除 node_modules 目录",
  "reason": "清理依赖以解决版本冲突",
  "severity": "high"
}
```

### read_clipboard - 读取剪贴板

```bash
read_clipboard {}
read_clipboard { "format": "text" }
```

### 计划模式工具

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

```bash
findings_write {
  "category": "security",
  "finding": "发现 SQL 注入风险",
  "location": "src/api/users.ts:42",
  "severity": "high"
}
```

---

## Gen4 网络工具

### web_fetch - HTTP 请求

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
```

### web_search - 网络搜索

```bash
web_search { "query": "TypeScript best practices 2024" }
web_search { "query": "React hooks tutorial", "limit": 5 }
```

**要求**：需配置 Brave Search API Key 或使用云端代理。

### read_pdf - PDF 智能处理

两阶段处理策略：
1. **文本提取优先**：使用 pdfjs-dist 快速提取（免费）
2. **视觉模型回退**：扫描版 PDF 自动调用 Gemini 2.0

```bash
read_pdf { "file_path": "/path/to/doc.pdf" }
read_pdf { "file_path": "/path/to/diagram.pdf", "force_vision": true, "prompt": "分析图表数据" }
```

### skill - 内置技能

| 技能 | 描述 |
|------|------|
| `file-organizer` | 整理目录文件：分析、分类、检测重复、清理 |
| `commit` | Git 提交助手，遵循 conventional commit 规范 |
| `code-review` | 代码审查，检查 bug、安全问题、最佳实践 |

```bash
skill { "name": "file-organizer", "input": "整理我的下载文件夹" }
```

### MCP 工具

MCP (Model Context Protocol) 允许 Agent 调用外部服务：

| 工具 | 描述 |
|------|------|
| `mcp` | 调用 MCP 服务器工具 |
| `mcp_list_tools` | 列出可用工具 |
| `mcp_list_resources` | 列出可用资源 |
| `mcp_read_resource` | 读取资源内容 |
| `mcp_get_status` | 获取连接状态 |

**已配置的 MCP 服务器：**

| 服务器 | 类型 | 默认启用 | 说明 |
|--------|------|----------|------|
| `context7` | HTTP | ✅ | 最新库/框架文档 |
| `exa` | HTTP | 需 API Key | AI 语义搜索 |
| `firecrawl` | HTTP | 需 API Key | 网页抓取 |
| `tavily` | HTTP | 需 API Key | AI 实时搜索 |
| `deepwiki` | SSE | ✅ | GitHub 项目文档 |
| `sequential-thinking` | Stdio | ✅ (懒加载) | 问题分解推理 |
| `github` | Stdio | 需 Token | GitHub API |
| `puppeteer` | Stdio | ❌ (懒加载) | 浏览器自动化 |
| `docker` | Stdio | ❌ (懒加载) | 容器管理 |

---

## Gen5 内容生成工具

### ppt_generate - PPT 生成

```bash
ppt_generate { "topic": "产品介绍", "slides_count": 5 }
ppt_generate { "topic": "技术分享", "theme": "tech", "slides_count": 8 }
```

主题选项：`professional`、`tech`、`minimal`、`vibrant`

### image_generate - 图片生成

```bash
image_generate { "prompt": "sunset over mountains" }
image_generate { "prompt": "一只猫", "expand_prompt": true, "aspect_ratio": "16:9" }
```

### image_analyze - 图片分析

```bash
# 单图分析
image_analyze { "path": "photo.jpg", "prompt": "这张图片里有什么？" }

# 批量筛选
image_analyze { "paths": ["/Photos/*.jpg"], "filter": "有猫的照片" }
```

### video_generate - 视频生成

```bash
video_generate { "prompt": "海浪拍打沙滩，日落余晖" }
video_generate { "prompt": "城市夜景延时", "aspect_ratio": "16:9", "duration": 10 }
```

### docx_generate / excel_generate - 文档生成

```bash
docx_generate { "title": "项目报告", "content": "# 概述\n这是一份报告..." }
excel_generate { "title": "员工名单", "data": "[{\"姓名\": \"张三\"}]" }
```

---

## Gen5 记忆与学习工具

### memory_store / memory_search - 向量记忆

```bash
memory_store {
  "content": "使用 useMemo 优化 React 组件渲染性能",
  "type": "pattern",
  "tags": ["react", "performance"]
}

memory_search { "query": "React 性能优化技巧" }
```

### code_index - 代码索引

```bash
code_index { "action": "index", "path": "." }
code_index { "action": "definition", "symbol": "UserService" }
code_index { "action": "references", "symbol": "handleSubmit" }
```

### auto_learn - 自动学习

```bash
auto_learn { "source": "codebase", "path": "src/" }
auto_learn { "source": "session" }
```

---

## Gen6 视觉与浏览器工具

### screenshot - 屏幕截图

```bash
screenshot {}
screenshot { "window": "Code Agent" }
screenshot { "region": { "x": 0, "y": 0, "width": 800, "height": 600 } }
```

### computer_use - 计算机操作

```bash
computer_use { "action": "click", "x": 100, "y": 200 }
computer_use { "action": "type", "text": "Hello World" }
computer_use { "action": "hotkey", "keys": ["Command", "S"] }
```

### browser_action - 浏览器自动化

基于 Playwright 的完整浏览器自动化：

```bash
browser_action { "action": "launch" }
browser_action { "action": "new_tab", "url": "https://example.com" }
browser_action { "action": "click", "selector": "button.submit" }
browser_action { "action": "type", "selector": "#search", "text": "hello" }
browser_action { "action": "screenshot", "fullPage": true }
browser_action { "action": "close" }
```

---

## Gen7 多代理工具

### spawn_agent - 创建子代理

支持两种模式：声明式（使用预定义角色）和动态模式（自定义 prompt）。

**核心内置角色（6 个）：**
- `coder` - 编写代码
- `reviewer` - 代码审查
- `tester` - 编写测试
- `architect` - 架构设计
- `debugger` - 调试排错
- `documenter` - 编写文档

**扩展角色（11 个）：**

| 分类 | 角色 | 说明 |
|------|------|------|
| 代码 | `refactorer` | 代码重构 |
| DevOps | `devops` | CI/CD 和基础设施 |
| 视觉 | `visual-understanding` | 图片分析（OCR、物体检测）|
| 视觉 | `visual-processing` | 图片编辑（标注、裁剪）|
| 元 | `code-explore` | 本地代码库搜索（只读）|
| 元 | `plan` | 任务规划（只读）|
| 元 | `bash-executor` | Shell 命令执行 |
| 元 | `general-purpose` | 通用全能 Agent |
| 外部 | `web-search` | 网络搜索 |
| 外部 | `mcp-connector` | MCP 服务连接 |
| 外部 | `doc-reader` | 本地文档读取（PDF/Word/Excel）|

```bash
spawn_agent { "role": "coder", "task": "实现用户登录功能" }

# 使用扩展角色
spawn_agent { "role": "code-explore", "task": "查找认证相关代码" }

# 并行执行
spawn_agent {
  "parallel": true,
  "agents": [
    { "role": "reviewer", "task": "审查代码质量" },
    { "role": "tester", "task": "编写测试" }
  ]
}
```

### agent_message - 代理通信

```bash
agent_message { "action": "list" }
agent_message { "action": "status", "agentId": "agent_coder_123" }
agent_message { "action": "result", "agentId": "agent_coder_123" }
```

### workflow_orchestrate - 工作流编排

预定义模板：`code-review-pipeline`、`bug-fix-flow`、`documentation-flow`、`parallel-review`

```bash
workflow_orchestrate { "workflow": "code-review-pipeline", "task": "实现用户认证功能" }
```

---

## Gen8 自进化工具

### strategy_optimize - 策略优化

```bash
strategy_optimize {
  "task": "代码审查",
  "currentStrategy": "逐文件审查",
  "metrics": { "time": 300, "accuracy": 0.85 }
}
```

### tool_create - 动态创建工具

```bash
tool_create {
  "name": "format_json",
  "description": "格式化 JSON 字符串",
  "type": "sandboxed_js",
  "code": "return JSON.stringify(JSON.parse(input.json), null, 2);",
  "parameters": { "json": { "type": "string" } }
}
```

### self_evaluate - 自我评估

```bash
self_evaluate {
  "task": "实现用户认证",
  "result": "完成了登录、注册、密码重置功能",
  "metrics": { "files_changed": 5, "tests_added": 12 }
}
```

### learn_pattern - 模式学习

```bash
learn_pattern { "source": "code", "path": "src/components/", "patternType": "component_structure" }
learn_pattern { "action": "list" }
```
