// Schema-only file (P0-7 方案 A — single source of truth)
// Pure type-only — does not pull legacy tool code at import time.
import type { ToolSchema } from '../../../protocol/tools';

export const mcpInvokeSchema: ToolSchema = {
  name: 'mcp',
  description: `调用 MCP (Model Context Protocol) 服务器提供的工具。

使用此工具前，先调用 mcp_list_tools 查看可用的 MCP 工具列表。

参数说明：
- server: MCP 服务器名称（如 'filesystem', 'github', 'deepwiki'）
- tool: 工具名称
- arguments: 工具参数（JSON 对象）

示例：
- 调用 filesystem 服务器的 read_file 工具：
  { "server": "filesystem", "tool": "read_file", "arguments": { "path": "/path/to/file" } }
- 调用 github 服务器的 search_repositories 工具：
  { "server": "github", "tool": "search_repositories", "arguments": { "query": "electron" } }`,
  inputSchema: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'MCP 服务器名称',
      },
      tool: {
        type: 'string',
        description: '要调用的工具名称',
      },
      arguments: {
        type: 'object',
        description: '工具参数',
        additionalProperties: true,
      },
    },
    required: ['server', 'tool'],
  },
  category: 'mcp',
  permissionLevel: 'network',
};
