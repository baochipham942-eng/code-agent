// ============================================================================
// MCP Client - Model Context Protocol 客户端编排器
// 支持三种传输协议：
// - stdio (本地命令行)
// - SSE/HTTP (远程)
// - in-process (进程内，无需 IPC)
//
// 拆分子模块：
// - mcpTransport.ts — 传输层创建和连接管理
// - mcpToolRegistry.ts — 工具/资源/提示发现、注册和调用
// - mcpDefaultServers.ts — 默认服务器配置 + 云端配置转换 + 初始化/刷新
// ============================================================================

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolDefinition, ToolResult } from '../../shared/types';
import { createLogger } from '../services/infra/logger';

// Import types from the types module
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
import { isStdioConfig, isInProcessConfig } from './types';

// Import sub-modules
import { createTransport, createMCPSDKClient, connectWithTimeout } from './mcpTransport';
import { MCPToolRegistry } from './mcpToolRegistry';
import {
  getDefaultMCPServers as _getDefaultMCPServers,
  DEFAULT_MCP_SERVERS as _DEFAULT_MCP_SERVERS,
  initMCPClient as _initMCPClient,
  refreshMCPServersFromCloud as _refreshMCPServersFromCloud,
} from './mcpDefaultServers';

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
export { isStdioConfig } from './types';
export { isSSEConfig } from './types';
export { isHttpStreamableConfig } from './types';
export { isInProcessConfig } from './types';

const logger = createLogger('MCPClient');

export class MCPClient {
  private clients: Map<string, Client> = new Map();
  private transports: Map<string, Transport> = new Map();
  private serverConfigs: Map<string, MCPServerConfig> = new Map();
  private serverStates: Map<string, MCPServerState> = new Map();
  private inProcessServers: Map<string, InProcessMCPServerInterface> = new Map();
  private registry = new MCPToolRegistry();
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
    if (this.clients.has(serverName)) {
      await this.disconnect(serverName);
    }
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
   */
  async updateServerConfig(serverName: string, newConfig: MCPServerConfig): Promise<void> {
    const existing = this.serverConfigs.get(serverName);
    if (!existing) {
      throw new Error(`Server ${serverName} not found`);
    }

    this.serverConfigs.set(serverName, newConfig);

    const wasEnabled = existing.enabled;
    const nowEnabled = newConfig.enabled;

    if (wasEnabled && !nowEnabled) {
      await this.disconnect(serverName);
    } else if (!wasEnabled && nowEnabled) {
      await this.connect(newConfig);
    } else if (wasEnabled && nowEnabled) {
      await this.reconnect(serverName);
    }

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

      if (isStdioConfig(config) && config.lazyLoad !== false) {
        logger.debug(`Skipping lazy-load server: ${config.name} (will connect on first use)`);
        continue;
      }

      try {
        await this.connect(config);
      } catch (error) {
        logger.error(`Failed to connect to MCP server ${config.name}:`, error);
        const state = this.serverStates.get(config.name);
        if (state) {
          state.status = 'error';
          state.error = error instanceof Error ? error.message : 'Unknown error';
        }
      }
    }
  }

  // --------------------------------------------------------------------------
  // Connection
  // --------------------------------------------------------------------------

  /**
   * 连接到单个服务器
   */
  async connect(config: MCPServerConfig): Promise<void> {
    // 检查是否已连接
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

    const state = this.serverStates.get(config.name);
    if (state) {
      state.status = 'connecting';
      state.error = undefined;
    }

    logger.info(`Connecting to MCP server: ${config.name} (type: ${config.type || 'stdio'})`);

    try {
      // 进程内服务器
      if (isInProcessConfig(config)) {
        await this.connectInProcess(config);
        return;
      }

      // 外部服务器（Stdio/SSE/HTTP Streamable）
      const { transport, connectTimeout } = createTransport(config);
      const client = createMCPSDKClient();

      await connectWithTimeout(client, transport, config, connectTimeout);

      this.clients.set(config.name, client);
      this.transports.set(config.name, transport);

      // 发现服务器能力
      await this.registry.discoverCapabilities(config.name, client);

      // 更新状态
      if (state) {
        state.status = 'connected';
        state.toolCount = this.registry.getToolCount(config.name);
        state.resourceCount = this.registry.getResourceCount(config.name);
      }

      logger.info(`Connected to MCP server: ${config.name}`);
    } catch (error) {
      // 清理 transport 防止资源泄漏
      if (this.transports.has(config.name)) {
        try {
          await this.transports.get(config.name)?.close();
          this.transports.delete(config.name);
        } catch {
          // 忽略关闭错误
        }
      }

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
      let server: InProcessMCPServerInterface;
      if (config.serverFactory) {
        server = config.serverFactory();
      } else {
        throw new Error(`In-process server ${config.name} has no serverFactory`);
      }

      if (server.start) {
        await server.start();
      }

      this.inProcessServers.set(config.name, server);
      await this.registry.discoverInProcessCapabilities(config.name, server);

      if (state) {
        state.status = 'connected';
        state.toolCount = this.registry.getToolCount(config.name);
        state.resourceCount = this.registry.getResourceCount(config.name);
      }

      logger.info(`Connected to in-process MCP server: ${config.name}`);
    } catch (error) {
      if (state) {
        state.status = 'error';
        state.error = error instanceof Error ? error.message : 'Unknown error';
      }
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Disconnection
  // --------------------------------------------------------------------------

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

    const inProcessServer = this.inProcessServers.get(serverName);
    if (inProcessServer) {
      if (inProcessServer.stop) {
        await inProcessServer.stop();
      }
      this.inProcessServers.delete(serverName);
    }

    this.registry.removeServerCapabilities(serverName);

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
    for (const serverName of this.inProcessServers.keys()) {
      await this.disconnect(serverName);
    }
  }

  /**
   * 重连指定服务器
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

  // --------------------------------------------------------------------------
  // Lazy Loading
  // --------------------------------------------------------------------------

  /**
   * 确保服务器已连接（支持懒加载）
   */
  async ensureConnected(serverName: string): Promise<boolean> {
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

  // --------------------------------------------------------------------------
  // Tool Operations (delegated to registry)
  // --------------------------------------------------------------------------

  getTools(): MCPTool[] {
    return this.registry.getTools();
  }

  getToolDefinitions(): ToolDefinition[] {
    return this.registry.getToolDefinitions();
  }

  parseMCPToolName(fullName: string): { serverName: string; toolName: string } | null {
    return this.registry.parseMCPToolName(fullName);
  }

  /**
   * 调用 MCP 工具
   */
  async callTool(
    toolCallId: string,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    timeoutMs: number = 60000,
  ): Promise<ToolResult> {
    // 优先检查进程内服务器
    const inProcessServer = this.inProcessServers.get(serverName);
    if (inProcessServer) {
      return this.registry.callInProcessTool(toolCallId, serverName, toolName, args, inProcessServer);
    }

    // 懒加载
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

    try {
      return await this.registry.callExternalTool(toolCallId, serverName, toolName, args, client, timeoutMs);
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'MCP tool call failed';

      // 连接错误时尝试重连+重试
      const isConnectionError = errorMessage.includes('timed out') ||
        errorMessage.includes('Connection closed') ||
        errorMessage.includes('not connected');

      if (isConnectionError) {
        logger.warn(`MCP server ${serverName} connection issue, attempting reconnect and retry...`);

        const reconnectResult = await this.reconnect(serverName);
        if (reconnectResult.success) {
          logger.info(`Reconnected to ${serverName}, retrying tool call...`);
          const retryClient = this.clients.get(serverName);
          if (retryClient) {
            const retryResult = await this.registry.retryToolCall(
              toolCallId, serverName, toolName, args, retryClient, startTime,
            );
            if (retryResult) return retryResult;
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

  // --------------------------------------------------------------------------
  // Resource Operations (delegated to registry)
  // --------------------------------------------------------------------------

  getResources(): MCPResource[] {
    return this.registry.getResources();
  }

  async readResource(serverName: string, uri: string): Promise<string> {
    const inProcessServer = this.inProcessServers.get(serverName);
    if (inProcessServer) {
      return inProcessServer.readResource(uri);
    }

    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server ${serverName} not connected`);
    }

    return this.registry.readExternalResource(client, uri);
  }

  // --------------------------------------------------------------------------
  // Prompt Operations (delegated to registry)
  // --------------------------------------------------------------------------

  getPrompts(): MCPPrompt[] {
    return this.registry.getPrompts();
  }

  async getPrompt(
    serverName: string,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<string> {
    const inProcessServer = this.inProcessServers.get(serverName);
    if (inProcessServer) {
      return inProcessServer.getPrompt(promptName, args);
    }

    const client = this.clients.get(serverName);
    if (!client) {
      throw new Error(`MCP server ${serverName} not connected`);
    }

    return this.registry.getExternalPrompt(client, promptName, args);
  }

  // --------------------------------------------------------------------------
  // Status
  // --------------------------------------------------------------------------

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
      toolCount: this.registry.tools.length,
      resourceCount: this.registry.resources.length,
      promptCount: this.registry.prompts.length,
    };
  }

  isConnected(serverName: string): boolean {
    return this.clients.has(serverName) || this.inProcessServers.has(serverName);
  }

  getInProcessServer(serverName: string): InProcessMCPServerInterface | undefined {
    return this.inProcessServers.get(serverName);
  }

  /**
   * 注册进程内服务器实例（直接注册，不通过配置）
   */
  async registerInProcessServer(server: InProcessMCPServerInterface): Promise<void> {
    if (this.inProcessServers.has(server.name)) {
      logger.warn(`In-process server ${server.name} already registered, skipping`);
      return;
    }

    if (server.start) {
      await server.start();
    }

    this.inProcessServers.set(server.name, server);

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

    await this.registry.discoverInProcessCapabilities(server.name, server);

    const state = this.serverStates.get(server.name);
    if (state) {
      state.toolCount = this.registry.getToolCount(server.name);
      state.resourceCount = this.registry.getResourceCount(server.name);
    }

    logger.info(`Registered in-process MCP server: ${server.name}`);
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

// ----------------------------------------------------------------------------
// Re-export init/refresh/defaults (preserving original API signatures)
// ----------------------------------------------------------------------------

export function getDefaultMCPServers(): MCPServerConfig[] {
  return _getDefaultMCPServers();
}

export const DEFAULT_MCP_SERVERS = _DEFAULT_MCP_SERVERS;

export async function initMCPClient(customConfigs?: MCPServerConfig[]): Promise<MCPClient> {
  return _initMCPClient(getMCPClient, customConfigs);
}

export async function refreshMCPServersFromCloud(): Promise<void> {
  return _refreshMCPServersFromCloud(getMCPClient);
}
