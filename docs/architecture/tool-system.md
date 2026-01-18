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
| **Gen4** | 网络能力 | skill, web_fetch, web_search, hooks |
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
| `web_search` | 网络搜索 | network |
| `hooks` | 生命周期钩子 | - |

---

## 文件结构

```
src/main/tools/
├── ToolRegistry.ts    # 工具注册表 (172 行)
├── ToolExecutor.ts    # 工具执行器 (200 行)
├── gen1/              # bash, readFile, writeFile, editFile
├── gen2/              # glob, grep, listDirectory
├── gen3/              # task, todoWrite, askUserQuestion
└── gen4/              # skill, webFetch
```

## 权限级别

| 级别 | 说明 | 默认行为 |
|------|------|----------|
| `read` | 只读操作 | 自动批准 |
| `write` | 文件写入 | 需要确认 (开发模式可自动) |
| `execute` | 命令执行 | 需要确认 |
| `network` | 网络请求 | 需要确认 |
