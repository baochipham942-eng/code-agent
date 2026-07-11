// ============================================================================
// MCP Tool Registry - 工具/资源/提示的发现、注册和调用
// ============================================================================

import type { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool, Resource, Prompt } from '@modelcontextprotocol/sdk/types.js';
import type { ToolDefinition, ToolResult } from '../../shared/contract';
import { createLogger } from '../services/infra/logger';
import { withTimeout } from '../services/infra/timeoutController';
import { maskSensitiveData } from '../security';
import { MCP_TIMEOUTS } from '../../shared/constants';
import { spillToolResultArchive, buildSpillNotice } from '../utils/toolResultSpill';
import { getToolSearchService } from '../services/toolSearch';
import type {
  MCPTool,
  MCPToolAnnotations,
  MCPToolExecution,
  MCPServerTaskCapabilities,
  MCPResource,
  MCPPrompt,
  InProcessMCPServerInterface,
} from './types';
import { CUA_DRIVER_SERVER_NAME } from './types';
import {
  getActiveRunTraceContext,
  serializeRunTraceContext,
} from '../telemetry/runTraceContext';

const logger = createLogger('MCPToolRegistry');

interface MCPToolRegistryCallOptions {
  timeoutMs?: number;
  abortSignal?: AbortSignal;
  /** 会话 ID（GAP-009: 超阈值输出落盘到 session 临时目录） */
  sessionId?: string;
}

function buildCancelledToolResult(toolCallId: string, startTime: number): ToolResult {
  return {
    toolCallId,
    success: false,
    error: 'cancelled',
    duration: Date.now() - startTime,
    metadata: {
      cancelledByRun: true,
    },
  };
}

function activeMcpRequestMeta(): { traceparent: string; tracestate?: string } | undefined {
  const active = getActiveRunTraceContext();
  if (!active) return undefined;
  const serialized = serializeRunTraceContext(active);
  return {
    traceparent: serialized.traceparent,
    ...(serialized.tracestate ? { tracestate: serialized.tracestate } : {}),
  };
}

/**
 * 将 SDK 返回的 Tool 映射为内部 MCPTool
 */
function mapSdkToolToMCPTool(serverName: string, tool: Tool): MCPTool {
  // SDK 返回的 annotations 包含 readOnlyHint/destructiveHint/openWorldHint/idempotentHint
  const annotations = (tool as { annotations?: MCPToolAnnotations }).annotations;
  const execution = (tool as { execution?: MCPToolExecution }).execution;
  return {
    name: tool.name,
    description: tool.description || '',
    inputSchema: tool.inputSchema,
    serverName,
    ...(annotations ? { annotations } : {}),
    ...(execution ? { execution } : {}),
  };
}

function mapMCPAnnotationsToPermission(
  annotations?: MCPToolAnnotations,
): Pick<ToolDefinition, 'requiresPermission' | 'permissionLevel' | 'readOnly'> {
  if (annotations?.destructiveHint) {
    return { requiresPermission: true, permissionLevel: 'execute', readOnly: false };
  }

  if (annotations?.readOnlyHint && !annotations.openWorldHint) {
    return { requiresPermission: false, permissionLevel: 'read', readOnly: true };
  }

  // 兜底 network 档：多数 MCP server 不写 annotations，无法证明只读。
  // readOnly 只在显式 readOnlyHint 时为真——readOnly 探索档据此区分
  // 「只读联网（放行）」与「潜在变更类 MCP 工具（强制确认）」。
  return {
    requiresPermission: true,
    permissionLevel: 'network',
    readOnly: annotations?.readOnlyHint === true,
  };
}

/**
 * cua-driver 工具权限映射。
 * cua 工具多不携带 MCP annotations，若走通用映射会全部落到 network 档，粒度不准。
 * 这里按 DeepChat plugins/cua/policies 对齐：只读类自动放行，桌面动作类需审批。
 */
// 工具名核对自实测 cua-driver v0.5.1 `list-tools`
const CUA_READONLY_TOOLS = new Set<string>([
  'check_permissions',
  'check_for_update',
  'list_apps',
  'list_windows',
  'get_screen_size',
  'get_window_state',
  'get_accessibility_tree',
  'get_cursor_position',
  'get_config',
  'get_recording_state',
  'get_agent_cursor_state',
  'start_session',
  'end_session',
  'screenshot', // 仅 --claude-code-computer-use-compat 模式存在；普通模式截图走 get_window_state
]);

function mapCuaToolPermission(
  toolName: string,
): Pick<ToolDefinition, 'requiresPermission' | 'permissionLevel' | 'readOnly'> {
  if (CUA_READONLY_TOOLS.has(toolName)) {
    return { requiresPermission: false, permissionLevel: 'read', readOnly: true };
  }
  // 其余为桌面动作（click/type_text/set_value/launch_app/drag/hotkey/…）→ 需审批
  return { requiresPermission: true, permissionLevel: 'execute', readOnly: false };
}

function redactLogArgs(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactLogArgs);
  }
  if (!value || typeof value !== 'object') {
    return typeof value === 'string' ? maskSensitiveData(value) : value;
  }

  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (/(token|password|passwd|secret|api[_-]?key|authorization|auth|credential)/i.test(key)) {
      redacted[key] = '[REDACTED]';
    } else {
      redacted[key] = redactLogArgs(nested);
    }
  }
  return redacted;
}

function isMcpContent(value: unknown): value is { type?: string; text?: string; mimeType?: string } {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  return (
    (record.type === undefined || typeof record.type === 'string')
    && (record.text === undefined || typeof record.text === 'string')
    && (record.mimeType === undefined || typeof record.mimeType === 'string')
  );
}

function mcpContentToText(value: unknown, includeNonText: boolean): string {
  if (!isMcpContent(value)) return '';
  if (typeof value.text === 'string') return value.text;
  if (!includeNonText) return '';
  if (value.type === 'image') return `[Image: ${value.mimeType || 'unknown'}]`;
  if (value.type === 'resource') return '[Resource]';
  return '';
}

/**
 * MCP 工具/资源/提示注册表
 * 负责能力发现、注册和调用操作
 */
export class MCPToolRegistry {
  tools: MCPTool[] = [];
  resources: MCPResource[] = [];
  prompts: MCPPrompt[] = [];
  private serverTaskCapabilities = new Map<string, MCPServerTaskCapabilities>();

  // --------------------------------------------------------------------------
  // Capability Discovery
  // --------------------------------------------------------------------------

  /**
   * 发现外部服务器能力
   */
  async discoverCapabilities(serverName: string, client: Client): Promise<void> {
    const capabilities = client.getServerCapabilities();
    const tasks = capabilities?.tasks;
    this.serverTaskCapabilities.set(serverName, {
      toolsCall: Boolean(tasks?.requests?.tools?.call),
      list: Boolean(tasks?.list),
      cancel: Boolean(tasks?.cancel),
    });
    const shouldProbe = (capability: 'tools' | 'resources' | 'prompts') =>
      !capabilities || Boolean(capabilities[capability]);

    // 获取工具列表
    if (shouldProbe('tools')) {
      try {
        const toolsResult = await client.listTools();
        if (toolsResult.tools) {
          for (const tool of toolsResult.tools) {
            this.tools.push(mapSdkToolToMCPTool(serverName, tool));
          }
        }
      } catch {
        logger.debug(`Server ${serverName} does not support tools`);
      }
    } else {
      logger.debug(`Server ${serverName} does not support tools`);
    }

    // 获取资源列表
    if (shouldProbe('resources')) {
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
    } else {
      logger.debug(`Server ${serverName} does not support resources`);
    }

    // 获取提示列表
    if (shouldProbe('prompts')) {
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
    } else {
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
      this.registerMCPToolsToSearch(serverName);
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
      // 先清掉该 server 旧的元数据，避免 listChanged 后 stale 工具残留
      toolSearchService.unregisterMCPServer(serverName);
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
    this.serverTaskCapabilities.delete(serverName);
  }

  // --------------------------------------------------------------------------
  // listChanged Refresh — server 动态增删能力后的热刷新
  // --------------------------------------------------------------------------

  /**
   * 用 server 推送的最新工具列表替换该 server 的工具，并同步 ToolSearchService
   */
  refreshServerTools(serverName: string, sdkTools: Tool[]): void {
    this.tools = this.tools.filter((t) => t.serverName !== serverName);
    for (const tool of sdkTools) {
      this.tools.push(mapSdkToolToMCPTool(serverName, tool));
    }
    this.registerMCPToolsToSearch(serverName);
    logger.info(`Refreshed ${sdkTools.length} tools from ${serverName} (listChanged)`);
  }

  /**
   * 用 server 推送的最新资源列表替换该 server 的资源
   */
  refreshServerResources(serverName: string, sdkResources: Resource[]): void {
    this.resources = this.resources.filter((r) => r.serverName !== serverName);
    for (const resource of sdkResources) {
      this.resources.push({
        uri: resource.uri,
        name: resource.name,
        description: resource.description,
        mimeType: resource.mimeType,
        serverName,
      });
    }
    logger.info(`Refreshed ${sdkResources.length} resources from ${serverName} (listChanged)`);
  }

  /**
   * 用 server 推送的最新提示列表替换该 server 的提示
   */
  refreshServerPrompts(serverName: string, sdkPrompts: Prompt[]): void {
    this.prompts = this.prompts.filter((p) => p.serverName !== serverName);
    for (const prompt of sdkPrompts) {
      this.prompts.push({
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments,
        serverName,
      });
    }
    logger.info(`Refreshed ${sdkPrompts.length} prompts from ${serverName} (listChanged)`);
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
      const permission =
        tool.serverName === CUA_DRIVER_SERVER_NAME
          ? mapCuaToolPermission(tool.name)
          : mapMCPAnnotationsToPermission(tool.annotations);
      const def: ToolDefinition & { metadata?: {
        annotations?: MCPToolAnnotations;
        execution?: MCPToolExecution;
        serverTaskCapabilities?: MCPServerTaskCapabilities;
      } } = {
        name: `mcp__${tool.serverName}__${tool.name}`,
        description: `[MCP:${tool.serverName}] ${tool.description}`,
        inputSchema: tool.inputSchema as ToolDefinition['inputSchema'],
        ...permission,
      };
      const taskCapabilities = this.serverTaskCapabilities.get(tool.serverName);
      if (tool.annotations || tool.execution || taskCapabilities) {
        def.metadata = {
          ...(tool.annotations ? { annotations: tool.annotations } : {}),
          ...(tool.execution ? { execution: tool.execution } : {}),
          ...(taskCapabilities ? { serverTaskCapabilities: taskCapabilities } : {}),
        };
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

  getTaskCapabilityDeclaration(serverName: string, toolName: string): {
    server: MCPServerTaskCapabilities;
    toolTaskSupport?: MCPToolExecution['taskSupport'];
  } | undefined {
    const server = this.serverTaskCapabilities.get(serverName);
    const tool = this.tools.find((candidate) =>
      candidate.serverName === serverName && candidate.name === toolName);
    if (!server || !tool) return undefined;
    return { server, toolTaskSupport: tool.execution?.taskSupport };
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
    if (fullName.startsWith('mcp__')) {
      const rest = fullName.slice('mcp__'.length);
      const separator = rest.indexOf('__');
      if (separator <= 0 || separator + 2 >= rest.length) return null;
      return {
        serverName: rest.slice(0, separator),
        toolName: rest.slice(separator + 2),
      };
    }

    const legacyMatch = fullName.match(/^mcp_([^_]+)_(.+)$/);
    if (!legacyMatch) return null;
    return {
      serverName: legacyMatch[1],
      toolName: legacyMatch[2],
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
    options: MCPToolRegistryCallOptions = {},
  ): Promise<ToolResult> {
    const startTime = Date.now();
    const timeoutMs = options.timeoutMs ?? 60000;
    const abortSignal = options.abortSignal;
    if (abortSignal?.aborted) {
      return buildCancelledToolResult(toolCallId, startTime);
    }

    logger.info(`Calling MCP tool: ${serverName}/${toolName}`, { args: redactLogArgs(args), timeoutMs });

    try {
      // withTimeout 自动清理 timer
      const result = await withTimeout(
        client.callTool({
          name: toolName,
          arguments: args,
          _meta: activeMcpRequestMeta(),
        }, undefined, { timeout: timeoutMs, signal: abortSignal }),
        timeoutMs,
        `MCP tool call timed out after ${timeoutMs}ms`,
      );

      logger.info(`MCP tool completed: ${serverName}/${toolName}`, { duration: Date.now() - startTime });

      // 转换结果
      let output = '';
      if (result.content && Array.isArray(result.content)) {
        for (const content of result.content) {
          output += mcpContentToText(content, true);
        }
      }

      // Truncate oversized output to prevent context overflow
      // GAP-009: 截断前落盘完整输出，模型可用 Read/Grep 回查
      const truncatedOutput = truncateMcpOutput(output, serverName, toolName, {
        sessionId: options.sessionId,
        toolCallId,
      });

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
    abortSignal?: AbortSignal,
  ): Promise<ToolResult | null> {
    if (abortSignal?.aborted) {
      return buildCancelledToolResult(toolCallId, startTime);
    }

    try {
      // withTimeout 自动清理 timer
      const retryResult = await withTimeout(
        client.callTool(
          { name: toolName, arguments: args, _meta: activeMcpRequestMeta() },
          undefined,
          { timeout: MCP_TIMEOUTS.TOOL_RETRY, signal: abortSignal },
        ),
        MCP_TIMEOUTS.TOOL_RETRY,
        `MCP tool call retry timed out after ${MCP_TIMEOUTS.TOOL_RETRY}ms`,
      );

      logger.info(`MCP tool retry succeeded: ${serverName}/${toolName}`);

      let output = '';
      if (retryResult.content && Array.isArray(retryResult.content)) {
        for (const content of retryResult.content) {
          output += mcpContentToText(content, false);
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
    abortSignal?: AbortSignal,
  ): Promise<ToolResult> {
    logger.info(`Calling in-process MCP tool: ${serverName}/${toolName}`, { args: redactLogArgs(args) });

    try {
      const startTime = Date.now();
      if (abortSignal?.aborted) {
        return buildCancelledToolResult(toolCallId, startTime);
      }
      const result = await server.callTool(toolName, args, toolCallId);
      logger.info(`In-process MCP tool completed: ${serverName}/${toolName}`, { duration: result.duration });
      if (abortSignal?.aborted) {
        return buildCancelledToolResult(toolCallId, Date.now() - (result.duration ?? 0));
      }
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
 * GAP-009: 截断前落盘完整输出到 session 临时目录，截断文本尾部附加路径提示。
 */
function truncateMcpOutput(
  output: string,
  serverName: string,
  toolName: string,
  spillCtx?: { sessionId?: string; toolCallId?: string },
): string {
  if (output.length <= MCP_MAX_OUTPUT_CHARS) {
    return output;
  }

  const spillResult = spillToolResultArchive({
    content: output,
    toolName: `mcp__${serverName}__${toolName}`,
    sessionId: spillCtx?.sessionId,
    toolCallId: spillCtx?.toolCallId,
    reason: 'mcp-output-limit',
  });

  const keepStart = Math.floor(MCP_MAX_OUTPUT_CHARS * 0.7);
  const keepEnd = Math.floor(MCP_MAX_OUTPUT_CHARS * 0.2);

  const truncated =
    output.slice(0, keepStart) +
    `\n\n... [${output.length - keepStart - keepEnd} characters omitted] ...\n\n` +
    output.slice(-keepEnd) +
    TRUNCATION_NOTICE +
    (spillResult ? buildSpillNotice(spillResult.archiveRef) : '');

  logger.warn(
    `MCP output truncated: ${serverName}/${toolName} ` +
    `(${output.length} → ${truncated.length} chars${spillResult ? `, full output spilled to ${spillResult.filePath}` : ''})`
  );

  return truncated;
}
