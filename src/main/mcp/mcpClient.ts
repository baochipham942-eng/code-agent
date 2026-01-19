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
import { getCloudConfigService, type MCPServerCloudConfig } from '../services/cloud/cloudConfigService';

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

// 服务器连接状态
export type MCPServerStatus = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface MCPServerState {
  config: MCPServerConfig;
  status: MCPServerStatus;
  error?: string;
  toolCount: number;
  resourceCount: number;
}

export class MCPClient {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, Transport> = new Map();
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private serverStates: Map<string, MCPServerState> = new Map();
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
    const name = config.name;
    this.serverConfigs.set(name, config);
    this.serverStates.set(name, {
      config,
      status: 'disconnected',
      toolCount: 0,
      resourceCount: 0,
    });
  }

  /**
   * 移除 MCP 服务器
   */
  async removeServer(serverName: string): Promise<void> {
    // 先断开连接
    if (this.clients.has(serverName)) {
      await this.disconnect(serverName);
    }
    // 移除配置和状态
    this.serverConfigs.delete(serverName);
    this.serverStates.delete(serverName);
    logger.info(`Removed MCP server: ${serverName}`);
  }

  /**
   * 获取所有服务器状态
   */
  getServerStates(): MCPServerState[] {
    return Array.from(this.serverStates.values());
  }

  /**
   * 获取单个服务器状态
   */
  getServerState(serverName: string): MCPServerState | undefined {
    return this.serverStates.get(serverName);
  }

  /**
   * 更新服务器配置（用于热更新）
   * 注意：此方法会完全替换配置，而非部分更新
   */
  async updateServerConfig(serverName: string, newConfig: MCPServerConfig): Promise<void> {
    const existing = this.serverConfigs.get(serverName);
    if (!existing) {
      throw new Error(`Server ${serverName} not found`);
    }

    this.serverConfigs.set(serverName, newConfig);

    // 如果连接状态变化，处理重连
    const wasEnabled = existing.enabled;
    const nowEnabled = newConfig.enabled;

    if (wasEnabled && !nowEnabled) {
      // 禁用服务器
      await this.disconnect(serverName);
    } else if (!wasEnabled && nowEnabled) {
      // 启用服务器
      await this.connect(newConfig);
    } else if (wasEnabled && nowEnabled) {
      // 配置变更，重连
      await this.reconnect(serverName);
    }

    // 更新状态
    const state = this.serverStates.get(serverName);
    if (state) {
      state.config = newConfig;
    }
  }

  /**
   * 启用/禁用服务器
   */
  async setServerEnabled(serverName: string, enabled: boolean): Promise<void> {
    const config = this.serverConfigs.get(serverName);
    if (!config) {
      throw new Error(`Server ${serverName} not found`);
    }

    const wasEnabled = config.enabled;
    config.enabled = enabled;

    if (wasEnabled && !enabled) {
      await this.disconnect(serverName);
    } else if (!wasEnabled && enabled) {
      await this.connect(config);
    }
  }

  /**
   * 连接到所有启用的服务器
   */
  async connectAll(): Promise<void> {
    for (const config of this.serverConfigs.values()) {
      if (config.enabled) {
        try {
          await this.connect(config);
        } catch (error) {
          logger.error(`Failed to connect to MCP server ${config.name}:`, error);
          // 更新状态为错误
          const state = this.serverStates.get(config.name);
          if (state) {
            state.status = 'error';
            state.error = error instanceof Error ? error.message : 'Unknown error';
          }
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

    // 更新状态为连接中
    const state = this.serverStates.get(config.name);
    if (state) {
      state.status = 'connecting';
      state.error = undefined;
    }

    logger.info(`Connecting to MCP server: ${config.name}`);

    let transport: Transport;

    try {
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

      // 更新状态为已连接
      if (state) {
        state.status = 'connected';
        state.toolCount = this.tools.filter(t => t.serverName === config.name).length;
        state.resourceCount = this.resources.filter(r => r.serverName === config.name).length;
      }

      logger.info(`Connected to MCP server: ${config.name}`);
    } catch (error) {
      // 更新状态为错误
      if (state) {
        state.status = 'error';
        state.error = error instanceof Error ? error.message : 'Unknown error';
      }
      throw error;
    }
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

    // 更新状态
    const state = this.serverStates.get(serverName);
    if (state) {
      state.status = 'disconnected';
      state.toolCount = 0;
      state.resourceCount = 0;
    }
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
    } catch {
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
    } catch {
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
    } catch {
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
    args: Record<string, unknown>,
    timeoutMs: number = 60000 // 默认 60 秒超时
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
    logger.info(`Calling MCP tool: ${serverName}/${toolName}`, { args, timeoutMs });

    try {
      // 使用 Promise.race 实现超时机制
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      });

      const result = await Promise.race([
        client.callTool({
          name: toolName,
          arguments: args,
        }),
        timeoutPromise,
      ]);

      logger.info(`MCP tool completed: ${serverName}/${toolName}`, { duration: Date.now() - startTime });

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
      logger.error(`MCP tool failed: ${serverName}/${toolName}`, { error: errorMessage, duration: Date.now() - startTime });

      // 如果是超时或连接错误，尝试自动重连后重试一次
      const isConnectionError = errorMessage.includes('timed out') ||
        errorMessage.includes('Connection closed') ||
        errorMessage.includes('not connected');

      if (isConnectionError) {
        logger.warn(`MCP server ${serverName} connection issue, attempting reconnect and retry...`);

        const reconnected = await this.reconnect(serverName);
        if (reconnected) {
          // 重连成功，重试一次工具调用（使用较短超时）
          logger.info(`Reconnected to ${serverName}, retrying tool call...`);
          const retryClient = this.clients.get(serverName);
          if (retryClient) {
            try {
              const retryTimeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => {
                  reject(new Error(`MCP tool call retry timed out after 30000ms`));
                }, 30000); // 重试用 30 秒超时
              });

              const retryResult = await Promise.race([
                retryClient.callTool({ name: toolName, arguments: args }),
                retryTimeoutPromise,
              ]);

              logger.info(`MCP tool retry succeeded: ${serverName}/${toolName}`);

              let output = '';
              if (retryResult.content && Array.isArray(retryResult.content)) {
                for (const content of retryResult.content) {
                  if ('text' in content && typeof content.text === 'string') {
                    output += content.text;
                  }
                }
              }

              return {
                toolCallId,
                success: !retryResult.isError,
                output,
                duration: Date.now() - startTime,
              };
            } catch (retryError) {
              logger.error(`MCP tool retry also failed: ${serverName}/${toolName}`, retryError);
            }
          }
        }
      }

      return {
        toolCallId,
        success: false,
        error: errorMessage,
        duration: Date.now() - startTime,
      };
    }
  }

  /**
   * 重连指定服务器（用于超时后恢复）
   */
  async reconnect(serverName: string): Promise<boolean> {
    const config = this.serverConfigs.get(serverName);
    if (!config) {
      logger.error(`Cannot reconnect: server config not found for ${serverName}`);
      return false;
    }

    logger.info(`Attempting to reconnect to MCP server: ${serverName}`);
    try {
      await this.disconnect(serverName);
      await this.connect(config);
      logger.info(`Successfully reconnected to MCP server: ${serverName}`);
      return true;
    } catch (error) {
      logger.error(`Failed to reconnect to MCP server ${serverName}:`, error);
      return false;
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
// Cloud Config to Internal Config Conversion
// ----------------------------------------------------------------------------

/**
 * 将云端 MCP 配置转换为内部配置格式
 * 支持环境变量替换（如 ${GITHUB_TOKEN}）
 */
function convertCloudConfigToInternal(cloudConfig: MCPServerCloudConfig): MCPServerConfig {
  const { id, name, type, enabled, config, requiredEnvVars } = cloudConfig;

  // 检查必需的环境变量
  let shouldEnable = enabled;
  if (requiredEnvVars && requiredEnvVars.length > 0) {
    const missingVars = requiredEnvVars.filter(v => !process.env[v]);
    if (missingVars.length > 0) {
      logger.debug(`MCP server ${name} disabled: missing env vars: ${missingVars.join(', ')}`);
      shouldEnable = false;
    }
  }

  // 替换环境变量占位符
  const resolveEnvVars = (obj: Record<string, string> | undefined): Record<string, string> | undefined => {
    if (!obj) return undefined;
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(obj)) {
      // 替换 ${VAR_NAME} 格式
      result[key] = value.replace(/\$\{(\w+)\}/g, (_, varName) => process.env[varName] || '');
    }
    return result;
  };

  if (type === 'sse') {
    return {
      name: id,
      type: 'sse',
      serverUrl: config.url!,
      enabled: shouldEnable,
    } as MCPSSEServerConfig;
  } else {
    return {
      name: id,
      command: config.command!,
      args: config.args?.map(arg =>
        arg === '~' ? (process.env.HOME || '/') : arg
      ),
      env: resolveEnvVars(config.env),
      enabled: shouldEnable,
    } as MCPStdioServerConfig;
  }
}

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

/**
 * 初始化 MCP 客户端
 * 优先使用云端配置，失败时使用内置配置
 */
export async function initMCPClient(customConfigs?: MCPServerConfig[]): Promise<MCPClient> {
  const client = getMCPClient();

  // 从云端配置服务获取 MCP 配置
  const cloudConfigService = getCloudConfigService();
  const cloudMCPServers = cloudConfigService.getMCPServers();

  if (cloudMCPServers.length > 0) {
    logger.info(`Loading ${cloudMCPServers.length} MCP servers from cloud config`);
    for (const cloudConfig of cloudMCPServers) {
      const internalConfig = convertCloudConfigToInternal(cloudConfig);
      client.addServer(internalConfig);
    }
  } else {
    logger.warn('No MCP servers in cloud config, using fallback');
  }

  // 添加自定义配置（优先级最高）
  if (customConfigs) {
    for (const config of customConfigs) {
      client.addServer(config);
    }
  }

  // 连接到所有启用的服务器
  await client.connectAll();

  return client;
}

/**
 * 从云端配置刷新 MCP 服务器
 * 用于热更新场景
 */
export async function refreshMCPServersFromCloud(): Promise<void> {
  const client = getMCPClient();
  const cloudConfigService = getCloudConfigService();

  // 刷新云端配置
  await cloudConfigService.refresh();
  const cloudMCPServers = cloudConfigService.getMCPServers();

  logger.info(`Refreshing MCP servers from cloud config: ${cloudMCPServers.length} servers`);

  // 获取当前配置的服务器名称
  const currentServerNames = new Set(client.getServerStates().map(s => s.config.name));
  const newServerNames = new Set(cloudMCPServers.map(s => s.id));

  // 移除云端已删除的服务器
  for (const name of currentServerNames) {
    if (!newServerNames.has(name)) {
      await client.removeServer(name);
    }
  }

  // 添加或更新服务器
  for (const cloudConfig of cloudMCPServers) {
    const internalConfig = convertCloudConfigToInternal(cloudConfig);
    if (currentServerNames.has(cloudConfig.id)) {
      // 更新现有配置
      await client.updateServerConfig(cloudConfig.id, internalConfig);
    } else {
      // 添加新服务器
      client.addServer(internalConfig);
      if (internalConfig.enabled) {
        try {
          await client.connect(internalConfig);
        } catch (error) {
          logger.error(`Failed to connect to new MCP server ${cloudConfig.id}:`, error);
        }
      }
    }
  }
}
