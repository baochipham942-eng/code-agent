# Code Agent MCP Server

Code Agent 提供了一个 MCP (Model Context Protocol) 服务器，允许外部 MCP 客户端（如 Claude Code）访问 Code Agent 的日志和状态。

## 架构

```
┌─────────────────────────────────────────────────────────────┐
│                    Code Agent (Electron)                     │
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
│  │  - Tools: get_logs, clear_logs, get_status          │    │
│  └─────────────────────────────────────────────────────┘    │
└────────────────────────────┬────────────────────────────────┘
                             │ STDIO
                             ▼
┌─────────────────────────────────────────────────────────────┐
│                 Claude Code (MCP Client)                     │
└─────────────────────────────────────────────────────────────┘
```

## 使用方法

### 1. 启动 Code Agent

首先启动 Code Agent 桌面应用：

```bash
npm run dev
# 或
npm run start
```

Code Agent 启动后会自动在 `http://127.0.0.1:51820` 启动 Log Bridge HTTP 服务器。

### 2. 配置 Claude Code

在 Claude Code 的 MCP 配置文件中添加 Code Agent MCP 服务器：

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

| 工具 | 描述 |
|------|------|
| `get_logs` | 按来源类型获取日志 |
| `clear_logs` | 清除指定来源或所有日志 |
| `get_status` | 获取当前 Agent 状态和统计 |

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

确保 Code Agent 桌面应用正在运行，Log Bridge HTTP 服务器应在端口 51820 上运行。

检查方法：

```bash
curl http://127.0.0.1:51820/health
```

应返回：`{"status":"ok","port":51820}`

### 连接被拒绝

如果 Log Bridge 端口被占用，可以修改 `src/main/mcp/LogBridge.ts` 中的 `DEFAULT_PORT` 常量。
