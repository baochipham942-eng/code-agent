// ============================================================================
// In-Process MCP Server - 进程内 MCP 服务器实现
// 用于将内置工具暴露为 MCP 服务，无需跨进程通信
// ============================================================================

import type { ToolResult } from '../../shared/types';
import { createLogger } from '../services/infra/logger';
import type {
  MCPTool,
  MCPResource,
  MCPPrompt,
  InProcessMCPServerInterface,
  ToolHandler,
  ToolRegistration,
  ResourceHandler,
  ResourceRegistration,
  PromptHandler,
  PromptRegistration,
} from './types';

const logger = createLogger('InProcessMCPServer');

// ----------------------------------------------------------------------------
// InProcessMCPServer - 进程内 MCP 服务器基类
// ----------------------------------------------------------------------------

/**
 * 进程内 MCP 服务器实现
 *
 * 用于将内置工具暴露为 MCP 服务，避免跨进程通信开销。
 *
 * 使用方式：
 * 1. 继承此类并实现 registerTools/registerResources/registerPrompts
 * 2. 或者直接实例化并调用 addTool/addResource/addPrompt 方法
 *
 * @example
 * ```typescript
 * // 方式 1：继承
 * class MyServer extends InProcessMCPServer {
 *   constructor() {
 *     super('my-server');
 *   }
 *
 *   protected async registerTools(): Promise<void> {
 *     this.addTool({
 *       definition: { name: 'my_tool', ... },
 *       handler: async (args, id) => ({ toolCallId: id, success: true, output: 'done' })
 *     });
 *   }
 * }
 *
 * // 方式 2：直接使用
 * const server = new InProcessMCPServer('my-server');
 * server.addTool({ definition: {...}, handler: async (args, id) => {...} });
 * await server.start();
 * ```
 */
export class InProcessMCPServer implements InProcessMCPServerInterface {
  public readonly name: string;

  private tools: Map<string, ToolRegistration> = new Map();
  private resources: Map<string, ResourceRegistration> = new Map();
  private prompts: Map<string, PromptRegistration> = new Map();
  private initialized: boolean = false;

  constructor(name: string) {
    this.name = name;
  }

  // --------------------------------------------------------------------------
  // Registration Methods
  // --------------------------------------------------------------------------

  /**
   * 添加工具
   */
  addTool(registration: ToolRegistration): void {
    const toolName = registration.definition.name;
    if (this.tools.has(toolName)) {
      logger.warn(`Tool ${toolName} already registered, overwriting`);
    }
    this.tools.set(toolName, registration);
    logger.debug(`Registered tool: ${toolName}`);
  }

  /**
   * 添加资源
   */
  addResource(registration: ResourceRegistration): void {
    if (this.resources.has(registration.uri)) {
      logger.warn(`Resource ${registration.uri} already registered, overwriting`);
    }
    this.resources.set(registration.uri, registration);
    logger.debug(`Registered resource: ${registration.uri}`);
  }

  /**
   * 添加提示
   */
  addPrompt(registration: PromptRegistration): void {
    if (this.prompts.has(registration.name)) {
      logger.warn(`Prompt ${registration.name} already registered, overwriting`);
    }
    this.prompts.set(registration.name, registration);
    logger.debug(`Registered prompt: ${registration.name}`);
  }

  /**
   * 批量添加工具
   */
  addTools(registrations: ToolRegistration[]): void {
    for (const reg of registrations) {
      this.addTool(reg);
    }
  }

  /**
   * 批量添加资源
   */
  addResources(registrations: ResourceRegistration[]): void {
    for (const reg of registrations) {
      this.addResource(reg);
    }
  }

  /**
   * 批量添加提示
   */
  addPrompts(registrations: PromptRegistration[]): void {
    for (const reg of registrations) {
      this.addPrompt(reg);
    }
  }

  // --------------------------------------------------------------------------
  // Protected Registration Hooks (for subclasses)
  // --------------------------------------------------------------------------

  /**
   * 注册工具（子类重写）
   */
  protected async registerTools(): Promise<void> {
    // 子类重写此方法以注册工具
  }

  /**
   * 注册资源（子类重写）
   */
  protected async registerResources(): Promise<void> {
    // 子类重写此方法以注册资源
  }

  /**
   * 注册提示（子类重写）
   */
  protected async registerPrompts(): Promise<void> {
    // 子类重写此方法以注册提示
  }

  // --------------------------------------------------------------------------
  // InProcessMCPServerInterface Implementation
  // --------------------------------------------------------------------------

  /**
   * 启动服务器
   */
  async start(): Promise<void> {
    if (this.initialized) {
      logger.debug(`Server ${this.name} already initialized`);
      return;
    }

    logger.info(`Starting in-process MCP server: ${this.name}`);

    // 调用子类的注册方法
    await this.registerTools();
    await this.registerResources();
    await this.registerPrompts();

    this.initialized = true;
    logger.info(`In-process MCP server ${this.name} started with ${this.tools.size} tools, ${this.resources.size} resources, ${this.prompts.size} prompts`);
  }

  /**
   * 停止服务器
   */
  async stop(): Promise<void> {
    logger.info(`Stopping in-process MCP server: ${this.name}`);
    this.tools.clear();
    this.resources.clear();
    this.prompts.clear();
    this.initialized = false;
  }

  /**
   * 获取可用工具列表
   */
  async listTools(): Promise<MCPTool[]> {
    return Array.from(this.tools.values()).map((reg) => ({
      name: reg.definition.name,
      description: reg.definition.description,
      inputSchema: reg.definition.inputSchema,
      serverName: this.name,
    }));
  }

  /**
   * 获取可用资源列表
   */
  async listResources(): Promise<MCPResource[]> {
    return Array.from(this.resources.values()).map((reg) => ({
      uri: reg.uri,
      name: reg.name,
      description: reg.description,
      mimeType: reg.mimeType,
      serverName: this.name,
    }));
  }

  /**
   * 获取可用提示列表
   */
  async listPrompts(): Promise<MCPPrompt[]> {
    return Array.from(this.prompts.values()).map((reg) => ({
      name: reg.name,
      description: reg.description,
      arguments: reg.arguments,
      serverName: this.name,
    }));
  }

  /**
   * 调用工具
   */
  async callTool(
    toolName: string,
    args: Record<string, unknown>,
    toolCallId: string
  ): Promise<ToolResult> {
    const registration = this.tools.get(toolName);
    if (!registration) {
      return {
        toolCallId,
        success: false,
        error: `Tool ${toolName} not found in server ${this.name}`,
      };
    }

    const startTime = Date.now();
    logger.debug(`Calling in-process tool: ${this.name}/${toolName}`, { args });

    try {
      const result = await registration.handler(args, toolCallId);
      const duration = Date.now() - startTime;
      logger.debug(`In-process tool completed: ${this.name}/${toolName}`, { duration });
      return {
        ...result,
        duration,
      };
    } catch (error) {
      const duration = Date.now() - startTime;
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`In-process tool failed: ${this.name}/${toolName}`, { error: errorMessage, duration });
      return {
        toolCallId,
        success: false,
        error: errorMessage,
        duration,
      };
    }
  }

  /**
   * 读取资源
   */
  async readResource(uri: string): Promise<string> {
    const registration = this.resources.get(uri);
    if (!registration) {
      throw new Error(`Resource ${uri} not found in server ${this.name}`);
    }

    logger.debug(`Reading in-process resource: ${this.name}/${uri}`);
    try {
      return await registration.handler(uri);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Failed to read resource: ${this.name}/${uri}`, { error: errorMessage });
      throw error;
    }
  }

  /**
   * 获取提示内容
   */
  async getPrompt(promptName: string, args?: Record<string, string>): Promise<string> {
    const registration = this.prompts.get(promptName);
    if (!registration) {
      throw new Error(`Prompt ${promptName} not found in server ${this.name}`);
    }

    logger.debug(`Getting in-process prompt: ${this.name}/${promptName}`, { args });
    try {
      return await registration.handler(args);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`Failed to get prompt: ${this.name}/${promptName}`, { error: errorMessage });
      throw error;
    }
  }

  // --------------------------------------------------------------------------
  // Utility Methods
  // --------------------------------------------------------------------------

  /**
   * 检查工具是否存在
   */
  hasTool(toolName: string): boolean {
    return this.tools.has(toolName);
  }

  /**
   * 检查资源是否存在
   */
  hasResource(uri: string): boolean {
    return this.resources.has(uri);
  }

  /**
   * 检查提示是否存在
   */
  hasPrompt(promptName: string): boolean {
    return this.prompts.has(promptName);
  }

  /**
   * 获取工具数量
   */
  getToolCount(): number {
    return this.tools.size;
  }

  /**
   * 获取资源数量
   */
  getResourceCount(): number {
    return this.resources.size;
  }

  /**
   * 获取提示数量
   */
  getPromptCount(): number {
    return this.prompts.size;
  }

  /**
   * 检查服务器是否已初始化
   */
  isInitialized(): boolean {
    return this.initialized;
  }
}

// ----------------------------------------------------------------------------
// Factory Function
// ----------------------------------------------------------------------------

/**
 * 创建进程内 MCP 服务器
 */
export function createInProcessServer(name: string): InProcessMCPServer {
  return new InProcessMCPServer(name);
}
