# Agent Neo MCP Server

Agent Neo 提供了一个 MCP (Model Context Protocol) 服务器，允许外部 MCP 客户端（如 Claude Code）访问 Agent Neo 的**只读**能力：日志、状态、截图、评测数据、历史窗口截图。控屏/写入类能力（computer / execute_command / clear_logs）**永不通过 MCP 暴露**——详见文末「安全边界（WS5）」。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Agent Neo (Electron)                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────┐  │
│  │ AgentLoop   │→ │ LogCollector │→ │   LogBridge (HTTP)  │  │
│  │ BrowserSvc  │  │             │  │   port: 51820       │  │
│  │ ToolExec    │  │             │  │                     │  │
│  └─────────────┘  └─────────────┘  └─────────────────────┘  │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP
                             ▼
┌─────────────────────────────────────────────────────────────┐
│              MCP Server (Standalone Process)                 │
│  ┌─────────────────────────────────────────────────────┐    │
│  │  - Resources: logs/browser, logs/agent, logs/tool   │    │
│  │  - Tools: get_logs, get_status, screenshot,         │    │
│  │           eval-query, appshots-query (read-only)    │    │
│  └─────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────┘
                             │ STDIO
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                 Claude Code (MCP Client)                     │
└─────────────────────────────────────────────────────────────┘
```

## 使用方法

### 1. 启动 Agent Neo

首先启动 Agent Neo 桌面应用：

```bash
npm run dev
# 或
npm run start
```

Agent Neo 启动后会自动在 `http://127.0.0.1:51820` 启动 Log Bridge HTTP 服务器。

### 2. 配置 Claude Code

在 Claude Code 的 MCP 配置文件中添加 Agent Neo MCP 服务器：

**macOS/Linux**: `~/.config/claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "code-agent": {
      "command": "node",
      "args": ["/path/to/code-agent/dist/mcp-server.js"],
      "env": {}
    }
  }
}
```

或者如果在 code-agent 项目目录中：

```json
{
  "mcpServers": {
    "code-agent": {
      "command": "npm",
      "args": ["run", "mcp-server"],
      "cwd": "/Users/linchen/Downloads/ai/code-agent"
    }
  }
}
```

### 3. 可用资源

MCP Server 暴露以下资源：

| URI | 描述 |
|-----|------|
| `code-agent://logs/browser` | 浏览器自动化操作日志 (Playwright) |
| `code-agent://logs/agent` | Agent 执行日志 (推理、决策) |
| `code-agent://logs/tool-calls` | 工具调用日志 (参数和结果) |
| `code-agent://logs/all` | 合并的所有日志 |
| `code-agent://status` | Agent 状态和统计信息 |

### 4. 可用工具

MCP Server 仅暴露**只读**工具（截至 2026-05-27，WS5 决策后）：

| 工具 | 描述 |
|------|------|
| `get_logs` | 按来源类型获取日志 |
| `get_status` | 获取当前 Agent 状态和统计 |
| `screenshot` | 截取当前屏幕（只读读屏，不含点击/输入等控屏） |
| `eval-query` | 读取评测 baseline / 趋势数据（只读） |
| `appshots-query` | 读取历史窗口截图（只读，`resolveInsideDir` 路径穿越防护） |

> 已移除：`clear_logs`、`computer`、`execute_command`。原因见文末「安全边界（WS5）」。

## 示例

在 Claude Code 中，你可以使用以下命令：

```
# 读取浏览器日志
Read the code-agent://logs/browser resource

# 获取所有日志
Use the get_logs tool with source="all" and count=50

# 查看 Agent 状态
Read the code-agent://status resource
```

## 日志格式

日志条目格式：

```
[HH:MM:SS] [SOURCE ] [LEVEL] message
```

示例：

```
[14:32:15] [BROWSER] [INFO ] Navigating to: https://example.com
[14:32:16] [AGENT  ] [INFO ] Tool call: browser_action
[14:32:17] [TOOL   ] [INFO ] Tool result: success
```

## 故障排除

### MCP Server 无法获取日志

确保 Agent Neo 桌面应用正在运行，Log Bridge HTTP 服务器应在端口 51820 上运行。

检查方法：

```bash
curl http://127.0.0.1:51820/health
```

应返回：`{"status":"ok","port":51820}`

### 连接被拒绝

如果 Log Bridge 端口被占用，可以修改 `src/main/mcp/LogBridge.ts` 中的 `DEFAULT_PORT` 常量。

## 安全边界（WS5）

**控屏/写入类能力永不通过 MCP 暴露。** 2026-05-27 拍板（commit `8c85ac22`），完整决策记录见 [docs/designs/ws5b-computeruse-mcp-security.md](designs/ws5b-computeruse-mcp-security.md)。

演进脉络：

1. **WS5a（`e281196c`，止血）**：先给 `computer` / `execute_command` / `clear_logs` 加 `enableComputerControl` opt-in 闸 + `MCP_ENABLE_COMPUTER_CONTROL` 环境变量（默认关），并新增 `eval-query` / `appshots-query` 两个只读工具。
2. **WS5b（`9208bbb9`→`8c85ac22`，定调）**：评估后**否决** opt-in 门控方案——stdio MCP 无法可信认证 caller（无 mTLS/OAuth，谁拉起就是谁），5 层授权门复杂度与收益失衡。最终**彻底移除**三个控屏工具及 `enableComputerControl` / `DANGEROUS_TOOL_NAMES` / `MCP_CAPABILITY_GATE` 全部相关代码，`mcpServer.ts` 从 ~229 行收敛到只读不变量。

代码强制方式：**直接不定义** control 工具（最强的不暴露保证）。调用任何未定义工具走 `CallToolRequestSchema` 的 default 分支返回 `Unknown tool`（`src/main/mcp/mcpServer.ts`）。

正确的控屏路径：外部 agent 不应反向控制 Neo，而是由 **Neo 作为 orchestrator**（经 agentEngine）去编排外部 agent；本机控屏走 Neo 自己的 Computer 工具（native ToolModule + 权限闸），不经 MCP。

> 何时重启讨论：仅当 MCP 传输层支持可信 caller 认证 + 有明确产品场景 + owner 签字三者同时满足（见 ws5b §6）。默认不重启。
