// ============================================================================
// MCP Unified Tool - Consolidates 6 MCP tools into 1 with action dispatch
// Phase 2: Tool Schema Consolidation (Group 2: 6->1)
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../types';
import { mcpTool, mcpListToolsTool, mcpListResourcesTool, mcpReadResourceTool, mcpGetStatusTool } from './mcpTool';
import { mcpAddServerTool } from './mcpAddServer';

export const MCPUnifiedTool: Tool = {
  name: 'MCPUnified',
  description: `Unified MCP (Model Context Protocol) tool for managing servers, invoking tools, and accessing resources.

Actions:
- invoke: Call a tool provided by an MCP server (requires server, tool; optional arguments)
- list_tools: List available tools from connected MCP servers (optional server filter)
- list_resources: List available resources from connected MCP servers (optional server filter)
- read_resource: Read a specific resource by URI (requires server, uri)
- status: Get connection status and statistics of all MCP servers
- add_server: Add and optionally connect a new MCP server (requires name, type)

Examples:
- Invoke a tool: { "action": "invoke", "server": "filesystem", "tool": "read_file", "arguments": { "path": "/tmp/test.txt" } }
- List tools: { "action": "list_tools" }
- List tools for a server: { "action": "list_tools", "server": "github" }
- Read resource: { "action": "read_resource", "server": "myserver", "uri": "file:///data.json" }
- Get status: { "action": "status" }
- Add SSE server: { "action": "add_server", "name": "my-server", "type": "sse", "serverUrl": "https://mcp.example.com/sse" }
- Add stdio server: { "action": "add_server", "name": "fs", "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] }`,

  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['invoke', 'list_tools', 'list_resources', 'read_resource', 'status', 'add_server'],
        description: 'The MCP action to perform',
      },
      // --- invoke params ---
      server: {
        type: 'string',
        description: 'MCP server name (for invoke, list_tools, list_resources, read_resource, add_server)',
      },
      tool: {
        type: 'string',
        description: '[invoke] Tool name to call',
      },
      arguments: {
        type: 'object',
        description: '[invoke] Tool arguments as JSON object',
        additionalProperties: true,
      },
      // --- read_resource params ---
      uri: {
        type: 'string',
        description: '[read_resource] Resource URI to read',
      },
      // --- add_server params ---
      name: {
        type: 'string',
        description: '[add_server] Unique server name identifier',
      },
      type: {
        type: 'string',
        enum: ['sse', 'stdio'],
        description: '[add_server] Server type: sse (remote) or stdio (local)',
      },
      serverUrl: {
        type: 'string',
        description: '[add_server] Server URL (required for SSE type)',
      },
      command: {
        type: 'string',
        description: '[add_server] Command to execute (required for stdio type)',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: '[add_server] Command arguments (stdio only)',
      },
      env: {
        type: 'object',
        description: '[add_server] Environment variables (stdio only)',
        additionalProperties: true,
      },
      auto_connect: {
        type: 'boolean',
        description: '[add_server] Automatically connect after adding (default: true)',
      },
    },
    required: ['action'],
  },

  requiresPermission: true,
  permissionLevel: 'network',

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const action = params.action as string;

    switch (action) {
      case 'invoke':
        return mcpTool.execute(params, context);

      case 'list_tools':
        return mcpListToolsTool.execute(params, context);

      case 'list_resources':
        return mcpListResourcesTool.execute(params, context);

      case 'read_resource':
        return mcpReadResourceTool.execute(params, context);

      case 'status':
        return mcpGetStatusTool.execute(params, context);

      case 'add_server':
        return mcpAddServerTool.execute(params, context);

      default:
        return {
          success: false,
          error: `Unknown action: ${action}. Valid actions: invoke, list_tools, list_resources, read_resource, status, add_server`,
        };
    }
  },
};
