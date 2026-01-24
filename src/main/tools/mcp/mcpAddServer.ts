// ============================================================================
// MCP Add Server Tool - Dynamically add MCP server configurations
// Gen4: Runtime MCP server management
// ============================================================================

import type { Tool, ToolContext, ToolExecutionResult } from '../toolRegistry';
import {
  getMCPClient,
  type MCPServerConfig,
  type MCPStdioServerConfig,
  type MCPSSEServerConfig,
} from '../../mcp/mcpClient';
import { createLogger } from '../../services/infra/logger';
import fs from 'fs/promises';
import path from 'path';

const logger = createLogger('MCPAddServer');

// Blocked commands for stdio servers (security)
const BLOCKED_COMMANDS = [
  'rm',
  'sudo',
  'chmod',
  'chown',
  'kill',
  'killall',
  'shutdown',
  'reboot',
  'dd',
  'mkfs',
  'fdisk',
  'mount',
  'umount',
];

/**
 * Validate stdio command for security
 */
function validateStdioCommand(command: string): { valid: boolean; error?: string } {
  const normalizedCmd = command.toLowerCase().trim();
  const cmdName = normalizedCmd.split(/[\s/]/).pop() || '';

  // Check blocked commands
  for (const blocked of BLOCKED_COMMANDS) {
    if (cmdName === blocked) {
      return { valid: false, error: `Command '${blocked}' is not allowed for MCP servers` };
    }
  }

  return { valid: true };
}

/**
 * Validate SSE URL
 */
function validateSSEUrl(url: string): { valid: boolean; error?: string } {
  try {
    const parsed = new URL(url);

    // Only allow http/https
    if (!['http:', 'https:'].includes(parsed.protocol)) {
      return { valid: false, error: `Invalid protocol: ${parsed.protocol}. Only http:// and https:// are allowed.` };
    }

    return { valid: true };
  } catch {
    return { valid: false, error: 'Invalid URL format' };
  }
}

/**
 * Persist MCP server configuration to settings file
 */
async function persistMCPConfig(
  workingDirectory: string,
  serverConfig: MCPServerConfig
): Promise<{ success: boolean; error?: string; filePath?: string }> {
  const claudeDir = path.join(workingDirectory, '.claude');
  const settingsPath = path.join(claudeDir, 'settings.json');

  try {
    // Ensure .claude directory exists
    await fs.mkdir(claudeDir, { recursive: true });

    // Read existing settings or create new
    let settings: Record<string, unknown> = {};
    try {
      const content = await fs.readFile(settingsPath, 'utf-8');
      settings = JSON.parse(content);
    } catch {
      // File doesn't exist or invalid JSON, use empty settings
    }

    // Initialize mcpServers array if not exists
    if (!settings.mcpServers || !Array.isArray(settings.mcpServers)) {
      settings.mcpServers = [];
    }

    const mcpServers = settings.mcpServers as MCPServerConfig[];

    // Check if server with same name already exists
    const existingIndex = mcpServers.findIndex((s) => s.name === serverConfig.name);
    if (existingIndex >= 0) {
      // Update existing
      mcpServers[existingIndex] = serverConfig;
    } else {
      // Add new
      mcpServers.push(serverConfig);
    }

    settings.mcpServers = mcpServers;

    // Write back with pretty formatting
    await fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));

    return { success: true, filePath: settingsPath };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save configuration',
    };
  }
}

export const mcpAddServerTool: Tool = {
  name: 'mcp_add_server',
  description: `Add a new MCP (Model Context Protocol) server configuration.

Supports two server types:
1. SSE (Server-Sent Events): Remote HTTP servers
2. Stdio: Local command-line servers

The configuration is persisted to .claude/settings.json and the server is optionally connected immediately.

Parameters:
- name (required): Unique server name identifier
- type (required): 'sse' or 'stdio'
- serverUrl (SSE required): Server URL for SSE type
- command (Stdio required): Command to run for Stdio type
- args (Stdio optional): Command arguments array
- env (Stdio optional): Environment variables object
- auto_connect (optional): Connect after adding (default: true)

Examples:
- SSE server: { "name": "my-server", "type": "sse", "serverUrl": "https://mcp.example.com/sse" }
- Stdio server: { "name": "fs-server", "type": "stdio", "command": "npx", "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path"] }
- Without auto-connect: { "name": "test", "type": "sse", "serverUrl": "https://...", "auto_connect": false }`,

  generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
  requiresPermission: true,
  permissionLevel: 'write',

  inputSchema: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Unique server name identifier',
      },
      type: {
        type: 'string',
        enum: ['sse', 'stdio'],
        description: 'Server type: sse (remote) or stdio (local)',
      },
      serverUrl: {
        type: 'string',
        description: 'Server URL (required for SSE type)',
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

  async execute(
    params: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    const name = params.name as string;
    const type = params.type as 'sse' | 'stdio';
    const serverUrl = params.serverUrl as string | undefined;
    const command = params.command as string | undefined;
    const args = params.args as string[] | undefined;
    const env = params.env as Record<string, string> | undefined;
    const autoConnect = (params.auto_connect as boolean) ?? true;

    // Validate name
    if (!name || typeof name !== 'string' || name.trim().length === 0) {
      return { success: false, error: 'Server name is required and cannot be empty' };
    }

    // Validate name format (alphanumeric, dash, underscore)
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return {
        success: false,
        error: 'Server name can only contain letters, numbers, dashes, and underscores',
      };
    }

    const mcpClient = getMCPClient();

    // Check if server already exists and connected
    const existingState = mcpClient.getServerState(name);
    if (existingState && existingState.status === 'connected') {
      return {
        success: false,
        error: `Server '${name}' is already connected. Use mcp_get_status to see connected servers.`,
      };
    }

    // Build and validate configuration based on type
    let serverConfig: MCPServerConfig;

    if (type === 'sse') {
      // Validate SSE parameters
      if (!serverUrl) {
        return { success: false, error: 'serverUrl is required for SSE type' };
      }

      const urlValidation = validateSSEUrl(serverUrl);
      if (!urlValidation.valid) {
        return { success: false, error: urlValidation.error };
      }

      serverConfig = {
        name,
        type: 'sse',
        serverUrl,
        enabled: true,
      } as MCPSSEServerConfig;
    } else if (type === 'stdio') {
      // Validate Stdio parameters
      if (!command) {
        return { success: false, error: 'command is required for Stdio type' };
      }

      const cmdValidation = validateStdioCommand(command);
      if (!cmdValidation.valid) {
        logger.warn('Blocked dangerous command for MCP server', { command });
        return { success: false, error: cmdValidation.error };
      }

      serverConfig = {
        name,
        command,
        args: args || [],
        env: env || {},
        enabled: true,
      } as MCPStdioServerConfig;
    } else {
      return { success: false, error: `Invalid server type: ${type}. Use 'sse' or 'stdio'.` };
    }

    // Persist configuration
    const persistResult = await persistMCPConfig(context.workingDirectory, serverConfig);
    if (!persistResult.success) {
      logger.warn('Failed to persist MCP config:', persistResult.error);
    }

    // Add server to MCP client
    mcpClient.addServer(serverConfig);
    logger.info(`Added MCP server: ${name}`, { type, autoConnect });

    // Connect if auto_connect is enabled
    let connectResult: { success: boolean; error?: string; toolCount?: number } = {
      success: true,
    };

    if (autoConnect) {
      try {
        await mcpClient.connect(serverConfig);

        // Get server state to report tools
        const state = mcpClient.getServerState(name);
        connectResult = {
          success: true,
          toolCount: state?.toolCount || 0,
        };

        logger.info(`Connected to MCP server: ${name}`, {
          type,
          toolCount: state?.toolCount,
        });
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Connection failed';
        connectResult = {
          success: false,
          error: errorMessage,
        };
        logger.error(`Failed to connect to MCP server ${name}:`, error);
      }
    }

    // Build output
    const outputParts = [`# MCP Server Added: ${name}`, '', `Type: ${type}`];

    if (type === 'sse') {
      outputParts.push(`URL: ${serverUrl}`);
    } else {
      const cmdDisplay = [command, ...(args || [])].join(' ');
      outputParts.push(`Command: ${cmdDisplay}`);
      if (env && Object.keys(env).length > 0) {
        outputParts.push(`Environment: ${Object.keys(env).join(', ')}`);
      }
    }

    outputParts.push('');
    outputParts.push(
      `Configuration saved: ${persistResult.success ? `Yes (${persistResult.filePath})` : 'No (session only)'}`
    );

    if (autoConnect) {
      outputParts.push('');
      if (connectResult.success) {
        outputParts.push('Connection: Success');
        outputParts.push(`Available tools: ${connectResult.toolCount || 0}`);
        outputParts.push('');
        outputParts.push('Use `mcp_list_tools` to see available tools from this server.');
      } else {
        outputParts.push('Connection: Failed');
        outputParts.push(`Error: ${connectResult.error}`);
        outputParts.push('');
        outputParts.push(
          'The server configuration has been saved. You can try connecting later.'
        );
      }
    } else {
      outputParts.push('');
      outputParts.push('Auto-connect disabled. Use mcp_get_status to see server status.');
    }

    return {
      success: true,
      output: outputParts.join('\n'),
      metadata: {
        name,
        type,
        persisted: persistResult.success,
        connected: autoConnect ? connectResult.success : false,
        toolCount: connectResult.toolCount,
      },
    };
  },
};
