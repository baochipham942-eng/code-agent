// ============================================================================
// MCP Tool Registry - 工具/资源/提示的发现、注册和调用
// ============================================================================

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { ToolDefinition, ToolResult } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import { MCP_TIMEOUTS } from '../../shared/constants';
import { getToolSearchService } from '../tools/search';
import type {
  MCPTool,
  MCPToolAnnotations,
  MCPResource,
  MCPPrompt,
  InProcessMCPServerInterface,
} from './types';

const logger = createLogger('MCPToolRegistry');

/**
 * MCP 工具/资源/提示注册表
 * 负责能力发现、注册和调用操作
 */
export class MCPToolRegistry {
  tools: MCPTool[] = [];
  resources: MCPResource[] = [];
  prompts: MCPPrompt[] = [];

  // --------------------------------------------------------------------------
  // Capability Discovery
  // --------------------------------------------------------------------------

  /**
   * 发现外部服务器能力
   */
  async discoverCapabilities(serverName: string, client: Client): Promise<void> {
    // 获取工具列表
    try {
      const toolsResult = await client.listTools();
      if (toolsResult.tools) {
        for (const tool of toolsResult.tools) {
          // SDK 返回的 annotations 包含 readOnlyHint/destructiveHint/openWorldHint/idempotentHint
          const annotations = (tool as { annotations?: MCPToolAnnotations }).annotations;
          this.tools.push({
            name: tool.name,
            description: tool.description || '',
            inputSchema: tool.inputSchema,
            serverName,
            ...(annotations ? { annotations } : {}),
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
   * 发现进程内服务器能力
   */
  async discoverInProcessCapabilities(
    serverName: string,
    server: InProcessMCPServerInterface,
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
   * 将 MCP 工具注册到 ToolSearchService
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
      }));

      toolSearchService.registerMCPTools(mcpMetas);
      logger.debug(`Registered ${mcpMetas.length} MCP tools from ${serverName} to ToolSearchService`);
    } catch (error) {
      logger.warn(`Failed to register MCP tools to ToolSearchService`, { serverName, error });
    }
  }

  // --------------------------------------------------------------------------
  // Remove server capabilities
  // --------------------------------------------------------------------------

  /**
   * 移除指定服务器的所有工具、资源、提示
   */
  removeServerCapabilities(serverName: string): void {
    this.tools = this.tools.filter((t) => t.serverName !== serverName);
    this.resources = this.resources.filter((r) => r.serverName !== serverName);
    this.prompts = this.prompts.filter((p) => p.serverName !== serverName);
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
    return this.tools.map((tool) => {
      const def: ToolDefinition & { metadata?: { annotations?: MCPToolAnnotations } } = {
        name: `mcp__${tool.serverName}__${tool.name}`,
        description: `[MCP:${tool.serverName}] ${tool.description}`,
        inputSchema: tool.inputSchema as ToolDefinition['inputSchema'],
        requiresPermission: true,
        permissionLevel: 'network' as const,
      };
      if (tool.annotations) {
        def.metadata = { annotations: tool.annotations };
      }
      return def;
    });
  }

  /**
   * 构建 MCP 工具注解映射表
   * key: 完整工具名 (mcp__serverName__toolName)
   * value: 工具注解
   */
  getToolAnnotationsMap(): Map<string, MCPToolAnnotations> {
    const map = new Map<string, MCPToolAnnotations>();
    for (const tool of this.tools) {
      if (tool.annotations) {
        map.set(`mcp__${tool.serverName}__${tool.name}`, tool.annotations);
      }
    }
    return map;
  }

  /**
   * 获取指定服务器的工具数
   */
  getToolCount(serverName: string): number {
    return this.tools.filter(t => t.serverName === serverName).length;
  }

  /**
   * 获取指定服务器的资源数
   */
  getResourceCount(serverName: string): number {
    return this.resources.filter(r => r.serverName === serverName).length;
  }

  /**
   * 解析 MCP 工具名称
   */
  parseMCPToolName(fullName: string): { serverName: string; toolName: string } | null {
    const match = fullName.match(/^mcp_([^_]+)_(.+)$/);
    if (!match) return null;
    return {
      serverName: match[1],
      toolName: match[2],
    };
  }

  // --------------------------------------------------------------------------
  // Tool Call
  // --------------------------------------------------------------------------

  /**
   * 调用外部 MCP 工具（通过 SDK Client）
   */
  async callExternalTool(
    toolCallId: string,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    client: Client,
    timeoutMs: number = 60000,
  ): Promise<ToolResult> {
    const startTime = Date.now();
    logger.info(`Calling MCP tool: ${serverName}/${toolName}`, { args, timeoutMs });

    try {
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

      // Truncate oversized output to prevent context overflow
      const truncatedOutput = truncateMcpOutput(output, serverName, toolName);

      return {
        toolCallId,
        success: !result.isError,
        output: truncatedOutput,
        duration: Date.now() - startTime,
      };
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : 'MCP tool call failed';
      logger.error(`MCP tool failed: ${serverName}/${toolName}`, { error: errorMessage, duration: Date.now() - startTime });
      throw error;
    }
  }

  /**
   * 重试工具调用（使用较短超时）
   */
  async retryToolCall(
    toolCallId: string,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    client: Client,
    startTime: number,
  ): Promise<ToolResult | null> {
    try {
      const retryTimeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => {
          reject(new Error(`MCP tool call retry timed out after ${MCP_TIMEOUTS.TOOL_RETRY}ms`));
        }, MCP_TIMEOUTS.TOOL_RETRY);
      });

      const retryResult = await Promise.race([
        client.callTool({ name: toolName, arguments: args }),
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
      return null;
    }
  }

  /**
   * 调用进程内服务器工具
   */
  async callInProcessTool(
    toolCallId: string,
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    server: InProcessMCPServerInterface,
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
   * 读取资源（外部服务器）
   */
  async readExternalResource(client: Client, uri: string): Promise<string> {
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
   * 获取提示内容（外部服务器）
   */
  async getExternalPrompt(
    client: Client,
    promptName: string,
    args?: Record<string, string>,
  ): Promise<string> {
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

}

// ============================================================================
// MCP 输出截断
// ============================================================================

/** Max output size in characters before truncation (~50K chars ≈ ~12K tokens) */
const MCP_MAX_OUTPUT_CHARS = 50_000;
/** Truncated output suffix */
const TRUNCATION_NOTICE = '\n\n[Output truncated: exceeded size limit. Use more specific queries to reduce output.]';

/**
 * Truncate oversized MCP tool output to prevent context window overflow.
 * Preserves the first and last portions for context continuity.
 */
function truncateMcpOutput(output: string, serverName: string, toolName: string): string {
  if (output.length <= MCP_MAX_OUTPUT_CHARS) {
    return output;
  }

  const keepStart = Math.floor(MCP_MAX_OUTPUT_CHARS * 0.7);
  const keepEnd = Math.floor(MCP_MAX_OUTPUT_CHARS * 0.2);

  const truncated =
    output.slice(0, keepStart) +
    `\n\n... [${output.length - keepStart - keepEnd} characters omitted] ...\n\n` +
    output.slice(-keepEnd) +
    TRUNCATION_NOTICE;

  logger.warn(
    `MCP output truncated: ${serverName}/${toolName} ` +
    `(${output.length} → ${truncated.length} chars)`
  );

  return truncated;
}
