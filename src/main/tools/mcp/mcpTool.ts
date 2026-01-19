// ============================================================================
// MCP Tool - 动态调用 MCP 服务器工具
// Gen4: 外部服务集成能力
// ============================================================================

import type { ToolContext, ToolExecutionResult, Tool } from '../toolRegistry';
import { getMCPClient } from '../../mcp/mcpClient';
import { v4 as uuidv4 } from 'uuid';

// ----------------------------------------------------------------------------
// MCP Tool Definition
// ----------------------------------------------------------------------------

/**
 * MCP 工具 - 通用入口
 * 用于调用已连接的 MCP 服务器提供的工具
 */
export const mcpTool: Tool = {
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
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'network',

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const { server, tool, arguments: toolArgs } = params as {
      server: string;
      tool: string;
      arguments?: Record<string, unknown>;
    };

    if (!server || !tool) {
      return {
        success: false,
        error: '缺少必需参数: server 和 tool',
      };
    }

    const mcpClient = getMCPClient();

    // 检查服务器是否连接
    if (!mcpClient.isConnected(server)) {
      const status = mcpClient.getStatus();
      return {
        success: false,
        error: `MCP 服务器 '${server}' 未连接。已连接的服务器: ${status.connectedServers.join(', ') || '无'}`,
      };
    }

    try {
      const toolCallId = uuidv4();
      const result = await mcpClient.callTool(
        toolCallId,
        server,
        tool,
        toolArgs || {}
      );

      if (result.success) {
        return {
          success: true,
          output: result.output || '执行成功',
          metadata: {
            server,
            tool,
            duration: result.duration,
          },
        };
      } else {
        return {
          success: false,
          error: result.error || 'MCP 工具调用失败',
        };
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      return {
        success: false,
        error: `MCP 工具调用异常: ${errorMessage}`,
      };
    }
  },
};

// ----------------------------------------------------------------------------
// MCP List Tools - 列出可用工具
// ----------------------------------------------------------------------------

export const mcpListToolsTool: Tool = {
  name: 'mcp_list_tools',
  description: `列出所有已连接的 MCP 服务器及其提供的工具。

返回信息包括：
- 已连接的服务器列表
- 每个服务器提供的工具名称和描述
- 工具的输入参数 schema

在调用 mcp 工具前，建议先使用此工具查看可用选项。`,
  inputSchema: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: '可选：只列出指定服务器的工具',
      },
    },
  },
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const { server: filterServer } = params as { server?: string };

    const mcpClient = getMCPClient();
    const status = mcpClient.getStatus();

    if (status.connectedServers.length === 0) {
      return {
        success: true,
        output: '当前没有已连接的 MCP 服务器。',
      };
    }

    const tools = mcpClient.getTools();

    // 按服务器分组
    const toolsByServer: Record<string, typeof tools> = {};
    for (const tool of tools) {
      if (filterServer && tool.serverName !== filterServer) {
        continue;
      }
      if (!toolsByServer[tool.serverName]) {
        toolsByServer[tool.serverName] = [];
      }
      toolsByServer[tool.serverName].push(tool);
    }

    // 格式化输出
    const lines: string[] = [];
    lines.push(`已连接的 MCP 服务器: ${status.connectedServers.join(', ')}`);
    lines.push(`总工具数: ${status.toolCount}`);
    lines.push('');

    for (const [serverName, serverTools] of Object.entries(toolsByServer)) {
      lines.push(`## ${serverName} (${serverTools.length} 个工具)`);
      lines.push('');

      for (const tool of serverTools) {
        lines.push(`### ${tool.name}`);
        lines.push(tool.description || '无描述');

        // 简化 schema 输出
        if (tool.inputSchema && typeof tool.inputSchema === 'object') {
          const schema = tool.inputSchema as { properties?: Record<string, unknown>; required?: string[] };
          if (schema.properties) {
            lines.push('参数:');
            for (const [propName, propDef] of Object.entries(schema.properties)) {
              const def = propDef as { type?: string; description?: string };
              const required = schema.required?.includes(propName) ? '(必需)' : '(可选)';
              lines.push(`  - ${propName}: ${def.type || 'any'} ${required}`);
              if (def.description) {
                lines.push(`    ${def.description}`);
              }
            }
          }
        }
        lines.push('');
      }
    }

    return {
      success: true,
      output: lines.join('\n'),
    };
  },
};

// ----------------------------------------------------------------------------
// MCP List Resources - 列出可用资源
// ----------------------------------------------------------------------------

export const mcpListResourcesTool: Tool = {
  name: 'mcp_list_resources',
  description: `列出所有已连接的 MCP 服务器提供的资源。

MCP 资源是服务器暴露的只读数据源，如文件、数据库记录、API 响应等。`,
  inputSchema: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: '可选：只列出指定服务器的资源',
      },
    },
  },
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const { server: filterServer } = params as { server?: string };

    const mcpClient = getMCPClient();
    const resources = mcpClient.getResources();

    const filtered = filterServer
      ? resources.filter(r => r.serverName === filterServer)
      : resources;

    if (filtered.length === 0) {
      return {
        success: true,
        output: filterServer
          ? `服务器 '${filterServer}' 没有提供资源。`
          : '当前没有可用的 MCP 资源。',
      };
    }

    // 按服务器分组
    const resourcesByServer: Record<string, typeof filtered> = {};
    for (const resource of filtered) {
      if (!resourcesByServer[resource.serverName]) {
        resourcesByServer[resource.serverName] = [];
      }
      resourcesByServer[resource.serverName].push(resource);
    }

    const lines: string[] = [];
    lines.push(`共 ${filtered.length} 个资源`);
    lines.push('');

    for (const [serverName, serverResources] of Object.entries(resourcesByServer)) {
      lines.push(`## ${serverName}`);
      for (const resource of serverResources) {
        lines.push(`- ${resource.name}`);
        lines.push(`  URI: ${resource.uri}`);
        if (resource.description) {
          lines.push(`  描述: ${resource.description}`);
        }
        if (resource.mimeType) {
          lines.push(`  类型: ${resource.mimeType}`);
        }
      }
      lines.push('');
    }

    return {
      success: true,
      output: lines.join('\n'),
    };
  },
};

// ----------------------------------------------------------------------------
// MCP Read Resource - 读取资源
// ----------------------------------------------------------------------------

export const mcpReadResourceTool: Tool = {
  name: 'mcp_read_resource',
  description: `读取 MCP 服务器提供的资源内容。

使用 mcp_list_resources 查看可用资源及其 URI。`,
  inputSchema: {
    type: 'object',
    properties: {
      server: {
        type: 'string',
        description: 'MCP 服务器名称',
      },
      uri: {
        type: 'string',
        description: '资源 URI',
      },
    },
    required: ['server', 'uri'],
  },
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'network',

  async execute(
    params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const { server, uri } = params as { server: string; uri: string };

    if (!server || !uri) {
      return {
        success: false,
        error: '缺少必需参数: server 和 uri',
      };
    }

    const mcpClient = getMCPClient();

    if (!mcpClient.isConnected(server)) {
      return {
        success: false,
        error: `MCP 服务器 '${server}' 未连接`,
      };
    }

    try {
      const content = await mcpClient.readResource(server, uri);
      return {
        success: true,
        output: content,
        metadata: {
          server,
          uri,
        },
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : '未知错误';
      return {
        success: false,
        error: `读取资源失败: ${errorMessage}`,
      };
    }
  },
};

// ----------------------------------------------------------------------------
// MCP Get Status - 获取连接状态
// ----------------------------------------------------------------------------

export const mcpGetStatusTool: Tool = {
  name: 'mcp_get_status',
  description: `获取 MCP 服务器的连接状态和统计信息。

返回：
- 已连接的服务器列表
- 可用工具数量
- 可用资源数量
- 可用提示数量`,
  inputSchema: {
    type: 'object',
    properties: {},
  },
  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: false,
  permissionLevel: 'read',

  async execute(
    _params: Record<string, unknown>,
    _context: ToolContext
  ): Promise<ToolExecutionResult> {
    const mcpClient = getMCPClient();
    const status = mcpClient.getStatus();

    const output = [
      '# MCP 连接状态',
      '',
      `已连接服务器: ${status.connectedServers.length > 0 ? status.connectedServers.join(', ') : '无'}`,
      `可用工具: ${status.toolCount}`,
      `可用资源: ${status.resourceCount}`,
      `可用提示: ${status.promptCount}`,
    ].join('\n');

    return {
      success: true,
      output,
      metadata: status,
    };
  },
};
