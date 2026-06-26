// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const mcpAddServerSchema: ToolSchema = {
  name: 'mcp_add_server',
  description: `Add a new MCP (Model Context Protocol) server configuration.

Supports three server types:
1. HTTP Streamable: Modern remote HTTP MCP servers
2. SSE (Server-Sent Events): Legacy remote HTTP servers
3. Stdio: Local command-line servers

The configuration is persisted to .code-agent/mcp.json (or .claude/settings.json for legacy projects) and the server is optionally connected immediately.

Parameters:
- name (required): Unique server name identifier
- type (required): 'http-streamable'/'http', 'sse', or 'stdio'
- serverUrl/url (Remote required): Server URL for HTTP Streamable or SSE type
- headers (Remote optional): HTTP headers object
- command (Stdio required): Command to run for Stdio type
- args (Stdio optional): Command arguments array
- env (Stdio optional): Environment variables object
- auto_connect (optional): Connect after adding (default: true)

Examples:
- HTTP Streamable server: { "name": "jira", "type": "http-streamable", "serverUrl": "https://mcp.example.com/mcp" }
- SSE server: { "name": "my-server", "type": "sse", "serverUrl": "https://mcp.example.com/sse" }
- Stdio server: { "name": "fs-server", "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] }
- Without auto-connect: { "name": "test", "type": "http-streamable", "serverUrl": "https://...", "auto_connect": false }`,
  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Unique server name identifier',
      },
      type: {
        type: 'string',
        enum: ['http-streamable', 'http', 'sse', 'stdio'],
        description: 'Server type: http-streamable/http (remote), sse (legacy remote), or stdio (local)',
      },
      serverUrl: {
        type: 'string',
        description: 'Server URL (required for remote types)',
      },
      url: {
        type: 'string',
        description: 'Alias for serverUrl (accepted for Settings JSON compatibility)',
      },
      headers: {
        type: 'object',
        description: 'HTTP headers (remote types only)',
        additionalProperties: true,
      },
      command: {
        type: 'string',
        description: 'Command to execute (required for Stdio type)',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Command arguments (Stdio only)',
      },
      env: {
        type: 'object',
        description: 'Environment variables (Stdio only)',
        additionalProperties: true,
      },
      auto_connect: {
        type: 'boolean',
        description: 'Automatically connect after adding (default: true)',
      },
    },
    required: ['name', 'type'],
  },
  category: 'mcp',
  permissionLevel: 'write',
};
