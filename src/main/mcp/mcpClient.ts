// ============================================================================
// MCP Client - Model Context Protocol 客户端实现
// 支持 stdio (本地) 和 SSE/HTTP (远程) 两种传输协议
// ============================================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { ToolDefinition, ToolResult } from '../../shared/types';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('MCPClient');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

// Stdio 服务器配置 (本地命令行)
export interface MCPStdioServerConfig {
  name: string;
  type?: 'stdio';
  command: string;
  args?: string[];
  env?: Record<string, string>;
  enabled: boolean;
}

// SSE 服务器配置 (远程 HTTP)
export interface MCPSSEServerConfig {
  name: string;
  type: 'sse';
  serverUrl: string;
  enabled: boolean;
}

// 统一的服务器配置类型
export type MCPServerConfig = MCPStdioServerConfig | MCPSSEServerConfig;

export interface MCPTool {
  name: string;
  description: string;
  inputSchema: unknown;
  serverName: string;
}

export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
  serverName: string;
}

export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
  serverName: string;
}

// ----------------------------------------------------------------------------
// MCP Client
// ----------------------------------------------------------------------------

export class MCPClient {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, Transport> = new Map();
  private serverConfigs: MCPServerConfig[] = [];
  private tools: MCPTool[] = [];
  private resources: MCPResource[] = [];
  private prompts: MCPPrompt[] = [];

  constructor() {}

  // --------------------------------------------------------------------------
  // Server Management
  // --------------------------------------------------------------------------

  /**
   * 添加 MCP 服务器配置
   */
  addServer(config: MCPServerConfig): void {
    this.serverConfigs.push(config);
  }

  /**
   * 连接到所有启用的服务器
   */
  async connectAll(): Promise<void> {
    for (const config of this.serverConfigs) {
      if (config.enabled) {
        try {
          await this.connect(config);
        } catch (error) {
          logger.error(`Failed to connect to MCP server ${config.name}:`, error);
        }
      }
    }
  }

  /**
   * 连接到单个服务器
   */
  async connect(config: MCPServerConfig): Promise<void> {
    if (this.clients.has(config.name)) {
      logger.info(`MCP server ${config.name} already connected`);
      return;
    }

    logger.info(`Connecting to MCP server: ${config.name}`);

    let transport: Transport;

    // 根据配置类型创建不同的传输
    if (config.type === 'sse') {
      // SSE 远程服务器
      logger.info(`Using SSE transport for ${config.name}: ${config.serverUrl}`);
      transport = new SSEClientTransport(new URL(config.serverUrl));
    } else {
      // Stdio 本地服务器 (默认)
      const stdioConfig = config as MCPStdioServerConfig;
      transport = new StdioClientTransport({
        command: stdioConfig.command,
        args: stdioConfig.args || [],
        env: {
          ...process.env,
          ...stdioConfig.env,
        } as Record<string, string>,
      });
    }

    const client = new Client(
      {
        name: 'code-agent',
        version: '0.1.0',
      },
      {
        capabilities: {},
      }
    );

    await client.connect(transport);

    this.clients.set(config.name, client);
    this.transports.set(config.name, transport);

    // 获取服务器能力
    await this.discoverCapabilities(config.name);

    logger.info(`Connected to MCP server: ${config.name}`);
  }

  /**
   * 断开服务器连接
   */
  async disconnect(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    const transport = this.transports.get(serverName);

    if (client) {
      await client.close();
      this.clients.delete(serverName);
    }

    if (transport) {
      await transport.close();
      this.transports.delete(serverName);
    }

    // 移除该服务器的工具、资源、提示
    this.tools = this.tools.filter((t) => t.serverName !== serverName);
    this.resources = this.resources.filter((r) => r.serverName !== serverName);
    this.prompts = this.prompts.filter((p) => p.serverName !== serverName);
  }

  /**
   * 断开所有连接
   */
  async disconnectAll(): Promise<void> {
    for (const serverName of this.clients.keys()) {
      await this.disconnect(serverName);
    }
  }

  // --------------------------------------------------------------------------
  // Capability Discovery
  // --------------------------------------------------------------------------

  /**
   * 发现服务器能力
   */
  private async discoverCapabilities(serverName: string): Promise<void> {
    const client = this.clients.get(serverName);
    if (!client) return;

    // 获取工具列表
    try {
      const toolsResult = await client.listTools();
      if (toolsResult.tools) {
        for (const tool of toolsResult.tools) {
          this.tools.push({
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema,
            serverName,
          });
        }
      }
    } catch (error) {
      logger.debug(`Server ${serverName} does not support tools`);
    }

    // 获取资源列表
    try {
      const resourcesResult = await client.listResources();
      if (resourcesResult.resources) {
        for (const resource of resourcesResult.resources) {
          this.resources.push({
            uri: resource.uri,
            name: resource.name,
            description: resource.description,
            mimeType: resource.mimeType,
            serverName,
          });
        }
      }
    } catch (error) {
      logger.debug(`Server ${serverName} does not support resources`);
    }

    // 获取提示列表
    try {
      const promptsResult = await client.listPrompts();
      if (promptsResult.prompts) {
        for (const prompt of promptsResult.prompts) {
          this.prompts.push({
            name: prompt.name,
            description: prompt.description,
            arguments: prompt.arguments,
            serverName,
          });
        }
      }
    } catch (error) {
      logger.debug(`Server ${serverName} does not support prompts`);
    }
  }

  // --------------------------------------------------------------------------
  // Tool Operations
  // --------------------------------------------------------------------------

  /**
   * 获取所有可用工具
   */
  getTools(): MCPTool[] {
    return [...this.tools];
  }

  /**
   * 将 MCP 工具转换为内部工具定义格式
   */
  getToolDefinitions(): ToolDefinition[] {
    return this.tools.map((tool) => ({
      name: `mcp_${tool.serverName}_${tool.name}`,
      description: `[MCP:${tool.serverName}] ${tool.description}`,
      inputSchema: tool.inputSchema as ToolDefinition['inputSchema'],
      generations: ['gen4'] as const,
      requiresPermission: true,
      permissionLevel: 'network' as const,
    }));
  }

  /**
   * 调用 MCP 工具
   * @param toolCallId - 工具调用 ID（用于前端匹配）
   * @param serverName - MCP 服务器名称
   * @param toolName - 工具名称
   * @param args - 工具参数
   */
  async callTool(
    toolCallId: string,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>
  ): Promise<ToolResult> {
    const client = this.clients.get(serverName);
    if (!client) {
      return {
        toolCallId,
        success: false,
        error: `MCP server ${serverName} not connected`,
      };
    }

    const startTime = Date.now();

    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });

      // 转换结果
      let output = '';
      if (result.content && Array.isArray(result.content)) {
        for (const content of result.content) {
          if ('text' in content && typeof content.text === 'string') {
            output += content.text;
          } else if ('type' in content && content.type === 'image') {
            output += `[Image: ${(content as { mimeType?: string }).mimeType || 'unknown'}]`;
          } else if ('type' in content && content.type === 'resource') {
            output += `[Resource]`;
          }
        }
      }

      return {
        toolCallId,
        success: !result.isError,
        output,
        duration: Date.now() - startTime,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'MCP tool call failed';
      return {
        toolCallId,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 解析 MCP 工具名称
   */
  parseMCPToolName(fullName: string): { serverName: string; toolName: string } | null {
    // 格式: mcp_<serverName>_<toolName>
    const match = fullName.match(/^mcp_([^_]+)_(.+)$/);
    if (!match) return null;
    return {
      serverName: match[1],
      toolName: match[2],
    };
  }

  // --------------------------------------------------------------------------
  // Resource Operations
  // --------------------------------------------------------------------------

  /**
   * 获取所有可用资源
   */
  getResources(): MCPResource[] {
    return [...this.resources];
  }

  /**
   * 读取资源
   */
  async readResource(serverName: string, uri: string): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server ${serverName} not connected`);
    }

    const result = await client.readResource({ uri });

    let content = '';
    if (result.contents && Array.isArray(result.contents)) {
      for (const item of result.contents) {
        if ('text' in item && typeof item.text === 'string') {
          content += item.text;
        } else if ('blob' in item) {
          content += `[Binary data: ${(item as { mimeType?: string }).mimeType || 'unknown'}]`;
        }
      }
    }

    return content;
  }

  // --------------------------------------------------------------------------
  // Prompt Operations
  // --------------------------------------------------------------------------

  /**
   * 获取所有可用提示
   */
  getPrompts(): MCPPrompt[] {
    return [...this.prompts];
  }

  /**
   * 获取提示内容
   */
  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>
  ): Promise<string> {
    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server ${serverName} not connected`);
    }

    const result = await client.getPrompt({
      name: promptName,
      arguments: args,
    });

    let content = '';
    if (result.messages && Array.isArray(result.messages)) {
      for (const message of result.messages) {
        const msgContent = message.content;
        if (typeof msgContent === 'object' && 'text' in msgContent && typeof msgContent.text === 'string') {
          content += msgContent.text;
        }
      }
    }

    return content;
  }

  // --------------------------------------------------------------------------
  // Status
  // --------------------------------------------------------------------------

  /**
   * 获取连接状态
   */
  getStatus(): {
    connectedServers: string[];
    toolCount: number;
    resourceCount: number;
    promptCount: number;
  } {
    return {
      connectedServers: Array.from(this.clients.keys()),
      toolCount: this.tools.length,
      resourceCount: this.resources.length,
      promptCount: this.prompts.length,
    };
  }

  /**
   * 检查服务器是否连接
   */
  isConnected(serverName: string): boolean {
    return this.clients.has(serverName);
  }
}

// ----------------------------------------------------------------------------
// Default MCP Server Configurations
// ----------------------------------------------------------------------------

export const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [
  // ========== SSE 远程服务器 ==========

  // DeepWiki - 解读 GitHub 项目文档 (官方免费服务)
  // 工具: read_wiki_structure, read_wiki_contents, ask_question
  {
    name: 'deepwiki',
    type: 'sse',
    serverUrl: 'https://mcp.deepwiki.com/sse',
    enabled: true,
  },

  // ========== Stdio 本地服务器 ==========

  // 文件系统服务器 - 核心能力
  {
    name: 'filesystem',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-filesystem', process.env.HOME || '/'],
    enabled: false, // 默认禁用，避免与内置工具冲突
  },
  // Git 服务器 - 版本控制
  {
    name: 'git',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-git'],
    enabled: false, // 默认禁用，可在设置中启用
  },
  // GitHub 服务器
  {
    name: 'github',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-github'],
    env: {
      GITHUB_PERSONAL_ACCESS_TOKEN: process.env.GITHUB_TOKEN || '',
    },
    enabled: !!process.env.GITHUB_TOKEN,
  },
  // SQLite 服务器
  {
    name: 'sqlite',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-sqlite'],
    enabled: false,
  },
  // Brave Search 服务器
  {
    name: 'brave-search',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-brave-search'],
    env: {
      BRAVE_API_KEY: process.env.BRAVE_API_KEY || '',
    },
    enabled: !!process.env.BRAVE_API_KEY,
  },
  // Memory 服务器 - 知识图谱记忆
  {
    name: 'memory',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-memory'],
    enabled: false, // 默认禁用，可在设置中启用
  },
];

// ----------------------------------------------------------------------------
// Singleton Instance
// ----------------------------------------------------------------------------

let mcpClientInstance: MCPClient | null = null;

export function getMCPClient(): MCPClient {
  if (!mcpClientInstance) {
    mcpClientInstance = new MCPClient();
  }
  return mcpClientInstance;
}

export async function initMCPClient(configs?: MCPServerConfig[]): Promise<MCPClient> {
  const client = getMCPClient();

  // 添加默认服务器配置
  for (const config of DEFAULT_MCP_SERVERS) {
    client.addServer(config);
  }

  // 添加自定义配置
  if (configs) {
    for (const config of configs) {
      client.addServer(config);
    }
  }

  // 连接到所有启用的服务器
  await client.connectAll();

  return client;
}
