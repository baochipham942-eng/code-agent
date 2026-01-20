# 工具系统架构

> ToolRegistry + ToolExecutor + 8 代工具演进

## 工具定义格式

**位置**: `src/main/tools/`

```typescript
interface Tool {
  name: string;
  description: string;
  inputSchema: JSONSchema;
  generations: string[];        // 支持的代际
  requiresPermission: boolean;
  permissionLevel: 'read' | 'write' | 'execute' | 'network';
  execute: (params, context) => Promise<ToolExecutionResult>;
}
```

## 工具执行流程

```
输入: toolCalls = [
  { id: "call_abc123", name: "edit_file", arguments: {...} },
  { id: "call_def456", name: "bash", arguments: {...} }
]

FOR EACH toolCall:
┌─────────────────────────────────────────────────────────────────────────────┐
│                                                                             │
│  1️⃣ 发送开始事件                                                           │
│     onEvent({ type: 'tool_call_start', data: toolCall })                    │
│     → UI: MessageBubble 显示 "Running edit_file..."                         │
│                                                                             │
│  2️⃣ 执行工具                                                               │
│     ToolExecutor.execute(name, arguments, context)                          │
│     │                                                                       │
│     ├─ 查找工具: ToolRegistry.get('edit_file')                             │
│     │                                                                       │
│     ├─ 权限检查 (如需要):                                                  │
│     │  ├─ autoApprove 设置? → 自动批准                                     │
│     │  └─ 否则 → onEvent({ type: 'permission_request' })                   │
│     │            等待用户响应                                               │
│     │                                                                       │
│     └─ 工具执行:                                                           │
│        tool.execute(arguments, context)                                     │
│        → ToolExecutionResult { success, output?, error? }                  │
│                                                                             │
│  3️⃣ 构建结果                                                               │
│     ToolResult {                                                            │
│       toolCallId: "call_abc123",  // 必须与 toolCall.id 一致               │
│       success: true,                                                        │
│       output: "Edited file: ...",                                          │
│       duration: 45                                                          │
│     }                                                                       │
│                                                                             │
│  4️⃣ 发送结束事件                                                           │
│     onEvent({ type: 'tool_call_end', data: toolResult })                    │
│     → UI: MessageBubble 通过 toolCallId 匹配并显示结果                      │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

---

## 8 代工具演进

| 代际 | 核心能力 | 新增工具 |
|------|----------|----------|
| **Gen1** | 基础文件操作 | bash, read_file, write_file, edit_file |
| **Gen2** | 代码搜索 | glob, grep, list_directory, mcp |
| **Gen3** | 任务规划 | task, todo_write, ask_user_question, plan_mode |
| **Gen4** | 网络能力 | skill, web_fetch, web_search, read_pdf, hooks |
| **Gen5** | 记忆系统 | memory_store, memory_search, code_index |
| **Gen6** | 视觉交互 | screenshot, computer_use, browser_action |
| **Gen7** | 多代理 | spawn_agent, agent_message, workflow_orchestrate |
| **Gen8** | 自我进化 | strategy_optimize, tool_create, self_evaluate |

---

## Gen1 工具集

| 工具 | 功能 | 权限 |
|------|------|------|
| `bash` | 执行 shell 命令 | execute |
| `read_file` | 读取文件内容 | read |
| `write_file` | 创建/覆盖文件 | write |
| `edit_file` | 精确编辑文件 | write |

## Gen2 工具集

| 工具 | 功能 | 权限 |
|------|------|------|
| `glob` | 文件模式匹配 | read |
| `grep` | 内容搜索 | read |
| `list_directory` | 列出目录 | read |
| `mcp` | MCP 协议扩展 | varies |

## Gen3 工具集

| 工具 | 功能 | 权限 |
|------|------|------|
| `task` | 子任务委托 | - |
| `todo_write` | 任务清单管理 | - |
| `ask_user_question` | 用户交互 | - |
| `plan_mode` | 进入规划模式 | - |

## Gen4 工具集

| 工具 | 功能 | 权限 |
|------|------|------|
| `skill` | 技能调用 | varies |
| `web_fetch` | 网页抓取 | network |
| `web_search` | 网络搜索（Brave Search API） | network |
| `read_pdf` | 智能 PDF 处理 | read |
| `hooks` | 生命周期钩子 | - |

### read_pdf 详解（v0.6.5）

**功能**: 智能 PDF 读取，自动选择最佳处理方式

**处理策略**:
1. **文本提取优先**: 使用 pdfjs-dist 提取文本（快速、免费）
2. **视觉模型回退**: 当文本提取量低于阈值（扫描版 PDF），自动调用 OpenRouter Gemini 2.0

**输入参数**:
```typescript
{
  file_path: string;     // PDF 文件绝对路径（必需）
  prompt?: string;       // 视觉模型处理时的提示词
  force_vision?: boolean; // 强制使用视觉模型
}
```

**配置**: 处理扫描版 PDF 需要配置 OpenRouter API Key

### web_search 详解（v0.6.1）

**功能**: 使用 Brave Search API 搜索网络信息

**输入参数**:
```typescript
{
  query: string;     // 搜索查询（必需）
  count?: number;    // 结果数量（默认 5，最大 20）
}
```

**输出格式**:
```
Search results for: "query"

1. Title (age)
   URL
   Description

2. Title (age)
   ...
```

**配置**: 需要设置 `BRAVE_API_KEY` 环境变量

## Gen5 工具集 - 记忆系统

| 工具 | 功能 | 权限 |
|------|------|------|
| `memory_store` | 存储知识到向量数据库 | - |
| `memory_search` | 搜索相关记忆 | - |
| `code_index` | 索引代码库 | read |
| `auto_learn` | 自动学习模式 | - |

**记忆系统架构**:
- 向量数据库：pgvector（Supabase）
- 嵌入模型：OpenAI text-embedding-ada-002
- 存储类型：代码片段、对话历史、项目知识

## Gen6 工具集 - 视觉交互

| 工具 | 功能 | 权限 |
|------|------|------|
| `screenshot` | 屏幕截图 | execute |
| `computer_use` | 电脑控制（鼠标、键盘）| execute |
| `browser_navigate` | 浏览器导航 | network |
| `browser_action` | 浏览器操作（点击、输入）| network |

**依赖**: Playwright（用于浏览器自动化）

## Gen7 工具集 - 多代理

| 工具 | 功能 | 权限 |
|------|------|------|
| `spawn_agent` | 创建子代理 | - |
| `agent_message` | 代理间通信 | - |
| `workflow_orchestrate` | 工作流编排 | - |

**多代理模式**:
- 主代理（Orchestrator）协调子代理
- 子代理专注特定任务（代码审查、测试、文档）
- 异步通信，支持并行执行

## Gen8 工具集 - 自我进化

| 工具 | 功能 | 权限 |
|------|------|------|
| `strategy_optimize` | 策略优化 | - |
| `tool_create` | 动态创建工具 | execute |
| `self_evaluate` | 自我评估 | - |
| `learn_pattern` | 学习模式 | - |

**Feature Flag 控制**: Gen8 工具默认禁用，需要通过 `enableGen8` Feature Flag 启用。

---

## 文件结构

```
src/main/tools/
├── toolRegistry.ts    # 工具注册表
├── toolExecutor.ts    # 工具执行器
├── index.ts           # 统一导出
├── file/              # 文件操作工具
│   ├── readFile.ts
│   ├── writeFile.ts
│   ├── editFile.ts
│   ├── glob.ts
│   └── listDirectory.ts
├── shell/             # Shell 工具
│   ├── bash.ts
│   └── grep.ts
├── planning/          # 规划工具
│   ├── task.ts
│   ├── todoWrite.ts
│   ├── askUserQuestion.ts
│   ├── planMode.ts
│   └── findings.ts
├── network/           # 网络工具
│   ├── skill.ts
│   ├── webFetch.ts
│   ├── webSearch.ts
│   └── readPdf.ts
├── mcp/               # MCP 协议工具
├── memory/            # 记忆系统工具
├── vision/            # 视觉交互工具
├── multiagent/        # 多代理工具
└── evolution/         # 自我进化工具
```

## 权限级别

| 级别 | 说明 | 默认行为 |
|------|------|----------|
| `read` | 只读操作 | 自动批准 |
| `write` | 文件写入 | 需要确认 (开发模式可自动) |
| `execute` | 命令执行 | 需要确认 |
| `network` | 网络请求 | 需要确认 |
