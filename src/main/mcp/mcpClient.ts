// ============================================================================
// MCP Client - Model Context Protocol 客户端实现
// 支持三种传输协议：
// - stdio (本地命令行)
// - SSE/HTTP (远程)
// - in-process (进程内，无需 IPC)
// ============================================================================

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { ToolDefinition, ToolResult } from '../../shared/types';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { createLogger } from '../services/infra/logger';
import { getCloudConfigService, type MCPServerCloudConfig } from '../services/cloud/cloudConfigService';
import { getConfigService } from '../services/core/configService';
import { MCP_TIMEOUTS } from '../../shared/constants';
import { getToolSearchService } from '../tools/search';

// Import types from the new types module
import type {
  MCPServerConfig,
  MCPStdioServerConfig,
  MCPSSEServerConfig,
  MCPHttpStreamableServerConfig,
  MCPInProcessServerConfig,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPServerStatus,
  MCPServerState,
  InProcessMCPServerInterface,
} from './types';
import { isStdioConfig, isSSEConfig, isHttpStreamableConfig, isInProcessConfig } from './types';

// Import In-Process Servers
import { createMemoryKVServer } from './servers/memoryKVServer';
import { createCodeIndexServer } from './servers/codeIndexServer';

// Re-export types for backward compatibility
export type {
  MCPServerConfig,
  MCPStdioServerConfig,
  MCPSSEServerConfig,
  MCPHttpStreamableServerConfig,
  MCPInProcessServerConfig,
  MCPTool,
  MCPResource,
  MCPPrompt,
  MCPServerStatus,
  MCPServerState,
  InProcessMCPServerInterface,
};
export { isStdioConfig, isSSEConfig, isHttpStreamableConfig, isInProcessConfig };

const logger = createLogger('MCPClient');

export class MCPClient {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, Transport> = new Map();
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private serverStates: Map<string, MCPServerState> = new Map();
  // 进程内服务器实例存储
  private inProcessServers: Map<string, InProcessMCPServerInterface> = new Map();
  private tools: MCPTool[] = [];
  private resources: MCPResource[] = [];
  private prompts: MCPPrompt[] = [];
  // 懒加载：正在连接中的服务器 Promise（防止重复连接）
  private connectingServers: Map<string, Promise<void>> = new Map();

  constructor() {}

  // --------------------------------------------------------------------------
  // Server Management
  // --------------------------------------------------------------------------

  /**
   * 添加 MCP 服务器配置
   * Stdio 服务器默认使用懒加载（按需启动）
   */
  addServer(config: MCPServerConfig): void {
    const name = config.name;
    this.serverConfigs.set(name, config);

    // 判断是否是懒加载服务器（Stdio 类型且 lazyLoad 未显式设置为 false）
    const isLazyLoad = isStdioConfig(config) && config.lazyLoad !== false;

    this.serverStates.set(name, {
      config,
      status: isLazyLoad ? 'lazy' : 'disconnected',
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
   * 懒加载服务器（Stdio）跳过，等待首次调用时按需连接
   */
  async connectAll(): Promise<void> {
    for (const config of this.serverConfigs.values()) {
      if (!config.enabled) continue;

      // 跳过懒加载服务器（Stdio 类型且 lazyLoad 未设为 false）
      if (isStdioConfig(config) && config.lazyLoad !== false) {
        logger.debug(`Skipping lazy-load server: ${config.name} (will connect on first use)`);
        continue;
      }

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

  // Connection timeout in milliseconds (configured in shared/constants.ts)
  // SSE: 30 seconds (remote server should respond quickly)
  // Stdio: 120 seconds (npx may need to download packages on first run)
  private static readonly SSE_CONNECT_TIMEOUT = MCP_TIMEOUTS.SSE_CONNECT;
  private static readonly STDIO_CONNECT_TIMEOUT = MCP_TIMEOUTS.STDIO_CONNECT;
  // First-time Stdio connection (package download): 180 seconds
  private static readonly STDIO_FIRST_RUN_TIMEOUT = MCP_TIMEOUTS.FIRST_RUN;

  /**
   * 连接到单个服务器
   * 支持 Stdio、SSE 和进程内三种类型
   */
  async connect(config: MCPServerConfig): Promise<void> {
    // 检查是否已连接（进程内服务器使用单独的 Map）
    if (isInProcessConfig(config)) {
      if (this.inProcessServers.has(config.name)) {
        logger.info(`In-process MCP server ${config.name} already connected`);
        return;
      }
    } else {
      if (this.clients.has(config.name)) {
        logger.info(`MCP server ${config.name} already connected`);
        return;
      }
    }

    // 更新状态为连接中
    const state = this.serverStates.get(config.name);
    if (state) {
      state.status = 'connecting';
      state.error = undefined;
    }

    logger.info(`Connecting to MCP server: ${config.name} (type: ${config.type || 'stdio'})`);

    try {
      // 处理进程内服务器
      if (isInProcessConfig(config)) {
        await this.connectInProcess(config);
        return;
      }

      // 处理外部服务器（Stdio/SSE）
      let transport: Transport;
      let connectTimeout: number;

      // 根据配置类型创建不同的传输
      if (isHttpStreamableConfig(config)) {
        // HTTP Streamable 远程服务器 (现代 MCP 传输协议)
        logger.info(`Using HTTP Streamable transport for ${config.name}: ${config.serverUrl}`);

        // Build URL with optional headers
        const url = new URL(config.serverUrl);
        const requestInit: RequestInit = {};

        if (config.headers) {
          requestInit.headers = config.headers;
        }

        transport = new StreamableHTTPClientTransport(url, {
          requestInit,
        });
        connectTimeout = MCPClient.SSE_CONNECT_TIMEOUT;
      } else if (isSSEConfig(config)) {
        // SSE 远程服务器
        logger.info(`Using SSE transport for ${config.name}: ${config.serverUrl}`);

        // SSE transport with optional headers
        const url = new URL(config.serverUrl);
        const eventSourceInit: EventSourceInit = {};

        // Note: SSE doesn't support custom headers in standard EventSource
        // Headers are typically passed via URL params or handled server-side
        transport = new SSEClientTransport(url, {
          eventSourceInit,
        });
        connectTimeout = MCPClient.SSE_CONNECT_TIMEOUT;
      } else {
        // Stdio 本地服务器 (默认)
        const stdioConfig = config as MCPStdioServerConfig;
        logger.info(`Using Stdio transport for ${config.name}: ${stdioConfig.command} ${(stdioConfig.args || []).join(' ')}`);

        transport = new StdioClientTransport({
          command: stdioConfig.command,
          args: stdioConfig.args || [],
          env: {
            ...process.env,
            ...stdioConfig.env,
          } as Record<string, string>,
        });

        // 首次连接使用更长超时（npx 可能需要下载包）
        // 检测是否是 npx 命令（可能需要下载包）
        const isNpxCommand = stdioConfig.command === 'npx' ||
          stdioConfig.command.endsWith('/npx') ||
          (stdioConfig.args || []).some(arg => arg.includes('npx'));

        connectTimeout = isNpxCommand
          ? MCPClient.STDIO_FIRST_RUN_TIMEOUT
          : MCPClient.STDIO_CONNECT_TIMEOUT;

        logger.debug(`Stdio connection timeout: ${connectTimeout}ms (npx: ${isNpxCommand})`);
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

      // 使用超时机制包装连接
      const connectWithTimeout = async (): Promise<void> => {
        return new Promise<void>((resolve, reject) => {
          let isSettled = false;

          const timeoutId = setTimeout(() => {
            if (!isSettled) {
              isSettled = true;
              // 超时时尝试关闭 transport，防止资源泄漏
              transport.close().catch(() => {
                // 忽略关闭错误
              });

              // 生成更有帮助的错误消息
              let errorMsg = `Connection to ${config.name} timed out after ${Math.round(connectTimeout / 1000)}s.`;
              if (isStdioConfig(config)) {
                const stdioConfig = config as MCPStdioServerConfig;
                if (stdioConfig.command === 'npx') {
                  const packageName = stdioConfig.args?.find(arg => arg.startsWith('@') || !arg.startsWith('-')) || 'package';
                  errorMsg += ` This may be due to slow network or package download issues. `;
                  errorMsg += `Try running 'npx -y ${packageName}' manually to pre-download the package.`;
                }
              }
              reject(new Error(errorMsg));
            }
          }, connectTimeout);

          client.connect(transport)
            .then(() => {
              if (!isSettled) {
                isSettled = true;
                clearTimeout(timeoutId);
                resolve();
              }
            })
            .catch((err) => {
              if (!isSettled) {
                isSettled = true;
                clearTimeout(timeoutId);
                reject(err);
              }
            });
        });
      };

      await connectWithTimeout();

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
      // 确保 transport 被关闭，防止资源泄漏
      // 注意：超时情况下 connectWithTimeout 已尝试关闭，这里做二次保障
      if (this.transports.has(config.name)) {
        try {
          await this.transports.get(config.name)?.close();
          this.transports.delete(config.name);
        } catch {
          // 忽略关闭错误（可能 transport 未创建或已关闭）
        }
      }

      // 更新状态为错误
      if (state) {
        state.status = 'error';
        state.error = error instanceof Error ? error.message : 'Unknown error';
      }
      throw error;
    }
  }

  /**
   * 连接进程内服务器
   */
  private async connectInProcess(config: MCPInProcessServerConfig): Promise<void> {
    const state = this.serverStates.get(config.name);

    try {
      // 创建或获取服务器实例
      let server: InProcessMCPServerInterface;
      if (config.serverFactory) {
        server = config.serverFactory();
      } else {
        throw new Error(`In-process server ${config.name} has no serverFactory`);
      }

      // 启动服务器
      if (server.start) {
        await server.start();
      }

      // 存储服务器实例
      this.inProcessServers.set(config.name, server);

      // 发现进程内服务器的能力
      await this.discoverInProcessCapabilities(config.name, server);

      // 更新状态为已连接
      if (state) {
        state.status = 'connected';
        state.toolCount = this.tools.filter(t => t.serverName === config.name).length;
        state.resourceCount = this.resources.filter(r => r.serverName === config.name).length;
      }

      logger.info(`Connected to in-process MCP server: ${config.name}`);
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
   * 发现进程内服务器的能力
   */
  private async discoverInProcessCapabilities(
    serverName: string,
    server: InProcessMCPServerInterface
  ): Promise<void> {
    // 获取工具列表
    try {
      const tools = await server.listTools();
      for (const tool of tools) {
        this.tools.push(tool);
      }
    } catch {
      logger.debug(`In-process server ${serverName} does not support tools`);
    }

    // 获取资源列表
    try {
      const resources = await server.listResources();
      for (const resource of resources) {
        this.resources.push(resource);
      }
    } catch {
      logger.debug(`In-process server ${serverName} does not support resources`);
    }

    // 获取提示列表
    try {
      const prompts = await server.listPrompts();
      for (const prompt of prompts) {
        this.prompts.push(prompt);
      }
    } catch {
      logger.debug(`In-process server ${serverName} does not support prompts`);
    }
  }

  /**
   * 断开服务器连接
   * 支持外部服务器和进程内服务器
   */
  async disconnect(serverName: string): Promise<void> {
    // 断开外部服务器
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

    // 断开进程内服务器
    const inProcessServer = this.inProcessServers.get(serverName);
    if (inProcessServer) {
      if (inProcessServer.stop) {
        await inProcessServer.stop();
      }
      this.inProcessServers.delete(serverName);
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
    // 断开外部服务器
    for (const serverName of this.clients.keys()) {
      await this.disconnect(serverName);
    }
    // 断开进程内服务器
    for (const serverName of this.inProcessServers.keys()) {
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

    // 注册 MCP 工具到 ToolSearchService
    this.registerMCPToolsToSearch(serverName);
  }

  /**
   * 将 MCP 工具注册到 ToolSearchService
   * 使模型可以通过 tool_search 发现 MCP 工具
   */
  private registerMCPToolsToSearch(serverName: string): void {
    try {
      const toolSearchService = getToolSearchService();
      const serverTools = this.tools.filter(t => t.serverName === serverName);

      const mcpMetas = serverTools.map(tool => ({
        name: `mcp__${serverName}__${tool.name}`,
        shortDescription: tool.description || `MCP tool from ${serverName}`,
        tags: ['mcp', 'network'] as ('mcp' | 'network')[],
        aliases: [tool.name, serverName],
        source: 'mcp' as const,
        mcpServer: serverName,
        generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'],
      }));

      toolSearchService.registerMCPTools(mcpMetas);
      logger.debug(`Registered ${mcpMetas.length} MCP tools from ${serverName} to ToolSearchService`);
    } catch (error) {
      logger.warn(`Failed to register MCP tools to ToolSearchService`, { serverName, error });
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
   * 命名格式：mcp__serverName__toolName（双下划线，与 Claude Code 一致）
   */
  getToolDefinitions(): ToolDefinition[] {
    return this.tools.map((tool) => ({
      name: `mcp__${tool.serverName}__${tool.name}`,
      description: `[MCP:${tool.serverName}] ${tool.description}`,
      inputSchema: tool.inputSchema as ToolDefinition['inputSchema'],
      generations: ['gen4', 'gen5', 'gen6', 'gen7', 'gen8'] as const,
      requiresPermission: true,
      permissionLevel: 'network' as const,
    }));
  }

  /**
   * 确保服务器已连接（支持懒加载）
   * 如果服务器处于 lazy 状态，触发连接
   * 使用 connectingServers Map 防止重复连接
   */
  async ensureConnected(serverName: string): Promise<boolean> {
    // 已连接
    if (this.clients.has(serverName) || this.inProcessServers.has(serverName)) {
      return true;
    }

    const config = this.serverConfigs.get(serverName);
    if (!config) {
      logger.warn(`Server config not found: ${serverName}`);
      return false;
    }

    if (!config.enabled) {
      logger.warn(`Server ${serverName} is disabled`);
      return false;
    }

    // 检查是否正在连接中（防止并发连接）
    const existingPromise = this.connectingServers.get(serverName);
    if (existingPromise) {
      logger.debug(`Server ${serverName} is already connecting, waiting...`);
      try {
        await existingPromise;
        return this.clients.has(serverName) || this.inProcessServers.has(serverName);
      } catch {
        return false;
      }
    }

    // 开始懒加载连接
    const state = this.serverStates.get(serverName);
    if (state?.status === 'lazy' || state?.status === 'disconnected' || state?.status === 'error') {
      logger.info(`Lazy-loading MCP server: ${serverName}`);

      const connectPromise = this.connect(config).then(() => {
        this.connectingServers.delete(serverName);
      }).catch((error) => {
        this.connectingServers.delete(serverName);
        throw error;
      });

      this.connectingServers.set(serverName, connectPromise);

      try {
        await connectPromise;
        return this.clients.has(serverName) || this.inProcessServers.has(serverName);
      } catch (error) {
        logger.error(`Failed to lazy-load server ${serverName}:`, error);
        return false;
      }
    }

    return false;
  }

  /**
   * 调用 MCP 工具
   * 支持外部服务器和进程内服务器
   * 支持懒加载：如果服务器未连接，自动触发连接
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
    // 优先检查进程内服务器（无需 IPC，更快）
    const inProcessServer = this.inProcessServers.get(serverName);
    if (inProcessServer) {
      return this.callInProcessTool(toolCallId, serverName, toolName, args, inProcessServer);
    }

    // 懒加载：如果服务器未连接，尝试连接
    let client = this.clients.get(serverName);
    if (!client) {
      const state = this.serverStates.get(serverName);
      if (state?.status === 'lazy' || state?.status === 'disconnected') {
        logger.info(`Server ${serverName} not connected, triggering lazy-load for tool: ${toolName}`);
        const connected = await this.ensureConnected(serverName);
        if (!connected) {
          const errorMsg = state?.error || 'Failed to connect to server';
          return {
            toolCallId,
            success: false,
            error: `MCP server ${serverName} connection failed: ${errorMsg}`,
          };
        }
        client = this.clients.get(serverName);
      }

      if (!client) {
        return {
          toolCallId,
          success: false,
          error: `MCP server ${serverName} not connected`,
        };
      }
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

        const reconnectResult = await this.reconnect(serverName);
        if (reconnectResult.success) {
          // 重连成功，重试一次工具调用（使用较短超时）
          logger.info(`Reconnected to ${serverName}, retrying tool call...`);
          const retryClient = this.clients.get(serverName);
          if (retryClient) {
            try {
              const retryTimeoutPromise = new Promise<never>((_, reject) => {
                setTimeout(() => {
                  reject(new Error(`MCP tool call retry timed out after ${MCP_TIMEOUTS.TOOL_RETRY}ms`));
                }, MCP_TIMEOUTS.TOOL_RETRY);
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
   * 调用进程内服务器工具
   * 无需 IPC 通信，直接调用
   */
  private async callInProcessTool(
    toolCallId: string,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    server: InProcessMCPServerInterface
  ): Promise<ToolResult> {
    logger.info(`Calling in-process MCP tool: ${serverName}/${toolName}`, { args });

    try {
      const result = await server.callTool(toolName, args, toolCallId);
      logger.info(`In-process MCP tool completed: ${serverName}/${toolName}`, { duration: result.duration });
      return result;
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'In-process tool call failed';
      logger.error(`In-process MCP tool failed: ${serverName}/${toolName}`, { error: errorMessage });
      return {
        toolCallId,
        success: false,
        error: errorMessage,
      };
    }
  }

  /**
   * 重连指定服务器（用于超时后恢复）
   * 返回 { success: boolean; error?: string }
   */
  async reconnect(serverName: string): Promise<{ success: boolean; error?: string }> {
    const config = this.serverConfigs.get(serverName);
    if (!config) {
      const errorMsg = `Server config not found for ${serverName}`;
      logger.error(`Cannot reconnect: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }

    if (!config.enabled) {
      const errorMsg = `Server ${serverName} is disabled`;
      logger.warn(`Cannot reconnect: ${errorMsg}`);
      return { success: false, error: errorMsg };
    }

    logger.info(`Attempting to reconnect to MCP server: ${serverName}`);
    try {
      await this.disconnect(serverName);
      await this.connect(config);
      logger.info(`Successfully reconnected to MCP server: ${serverName}`);
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      logger.error(`Failed to reconnect to MCP server ${serverName}:`, error);
      return { success: false, error: errorMsg };
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
   * 支持外部服务器和进程内服务器
   */
  async readResource(serverName: string, uri: string): Promise<string> {
    // 优先检查进程内服务器
    const inProcessServer = this.inProcessServers.get(serverName);
    if (inProcessServer) {
      return inProcessServer.readResource(uri);
    }

    // 检查外部服务器
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
   * 支持外部服务器和进程内服务器
   */
  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>
  ): Promise<string> {
    // 优先检查进程内服务器
    const inProcessServer = this.inProcessServers.get(serverName);
    if (inProcessServer) {
      return inProcessServer.getPrompt(promptName, args);
    }

    // 检查外部服务器
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
   * 包含外部服务器和进程内服务器
   */
  getStatus(): {
    connectedServers: string[];
    inProcessServers: string[];
    toolCount: number;
    resourceCount: number;
    promptCount: number;
  } {
    return {
      connectedServers: Array.from(this.clients.keys()),
      inProcessServers: Array.from(this.inProcessServers.keys()),
      toolCount: this.tools.length,
      resourceCount: this.resources.length,
      promptCount: this.prompts.length,
    };
  }

  /**
   * 检查服务器是否连接
   * 包含外部服务器和进程内服务器
   */
  isConnected(serverName: string): boolean {
    return this.clients.has(serverName) || this.inProcessServers.has(serverName);
  }

  /**
   * 获取进程内服务器实例
   */
  getInProcessServer(serverName: string): InProcessMCPServerInterface | undefined {
    return this.inProcessServers.get(serverName);
  }

  /**
   * 注册进程内服务器实例（直接注册，不通过配置）
   * 用于动态注册服务器实例
   */
  async registerInProcessServer(server: InProcessMCPServerInterface): Promise<void> {
    if (this.inProcessServers.has(server.name)) {
      logger.warn(`In-process server ${server.name} already registered, skipping`);
      return;
    }

    // 启动服务器
    if (server.start) {
      await server.start();
    }

    // 存储服务器实例
    this.inProcessServers.set(server.name, server);

    // 创建对应的配置和状态
    const config: MCPInProcessServerConfig = {
      name: server.name,
      type: 'in-process',
      enabled: true,
    };
    this.serverConfigs.set(server.name, config);
    this.serverStates.set(server.name, {
      config,
      status: 'connected',
      toolCount: 0,
      resourceCount: 0,
    });

    // 发现能力
    await this.discoverInProcessCapabilities(server.name, server);

    // 更新状态
    const state = this.serverStates.get(server.name);
    if (state) {
      state.toolCount = this.tools.filter(t => t.serverName === server.name).length;
      state.resourceCount = this.resources.filter(r => r.serverName === server.name).length;
    }

    logger.info(`Registered in-process MCP server: ${server.name}`);
  }
}

// ----------------------------------------------------------------------------
// Default MCP Server Configurations
// ----------------------------------------------------------------------------

/**
 * Get default MCP server configurations
 * Uses configService for API keys (secure storage > env variable)
 */
export function getDefaultMCPServers(): MCPServerConfig[] {
  const configService = getConfigService();
  const braveApiKey = configService?.getServiceApiKey('brave') || process.env.BRAVE_API_KEY || '';
  const githubToken = configService?.getServiceApiKey('github') || process.env.GITHUB_TOKEN || '';

  return [
    // ========== SSE 远程服务器 ==========

    // DeepWiki - 解读 GitHub 项目文档 (官方免费服务)
    // 工具: read_wiki_structure, read_wiki_contents, ask_question
    // 注意: /sse 端点已废弃，使用 /mcp (Streamable HTTP)
    {
      name: 'deepwiki',
      type: 'http-streamable',
      serverUrl: 'https://mcp.deepwiki.com/mcp',
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
        GITHUB_PERSONAL_ACCESS_TOKEN: githubToken,
      },
      enabled: !!githubToken,
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
        BRAVE_API_KEY: braveApiKey,
      },
      enabled: !!braveApiKey,
    },
    // Memory 服务器 - 知识图谱记忆
    {
      name: 'memory',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-memory'],
      enabled: false, // 默认禁用，可在设置中启用
    },

    // ========== Phase 1: Sequential Thinking ==========
    // Sequential Thinking 服务器 - 动态问题分解和逐步推理
    {
      name: 'sequential-thinking',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      enabled: true, // 默认启用，提升复杂任务处理能力
    },

    // ========== Phase 3: Puppeteer ==========
    // Puppeteer 服务器 - 浏览器自动化
    {
      name: 'puppeteer',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-puppeteer'],
      enabled: false, // 默认禁用，需要时启用
    },

    // ========== Phase 3: Docker ==========
    // Docker 服务器 - 容器管理
    {
      name: 'docker',
      command: 'npx',
      args: ['-y', 'mcp-server-docker'],
      enabled: false, // 默认禁用，需要 Docker 环境
    },
  ];
}

// Legacy export for backward compatibility
export const DEFAULT_MCP_SERVERS: MCPServerConfig[] = [];

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

  if (type === 'http-streamable') {
    return {
      name: id,
      type: 'http-streamable',
      serverUrl: config.url!,
      headers: resolveEnvVars(config.headers),
      enabled: shouldEnable,
      requiredEnvVars,
    } as MCPHttpStreamableServerConfig;
  } else if (type === 'sse') {
    return {
      name: id,
      type: 'sse',
      serverUrl: config.url!,
      headers: resolveEnvVars(config.headers),
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
    logger.warn('No MCP servers in cloud config, using default servers');
    const defaultServers = getDefaultMCPServers();
    for (const config of defaultServers) {
      client.addServer(config);
    }
  }

  // 添加自定义配置（优先级最高）
  if (customConfigs) {
    for (const config of customConfigs) {
      client.addServer(config);
    }
  }

  // 注册内置的 In-Process 服务器
  try {
    logger.info('Registering built-in in-process MCP servers...');

    // Memory KV Server - 简单的键值存储
    const memoryKVServer = createMemoryKVServer();
    await client.registerInProcessServer(memoryKVServer);

    // Code Index Server - 代码索引和符号查找
    const codeIndexServer = createCodeIndexServer();
    await client.registerInProcessServer(codeIndexServer);

    logger.info('Built-in in-process MCP servers registered');
  } catch (error) {
    logger.error('Failed to register in-process servers:', error);
    // 不阻止其他服务器连接
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
