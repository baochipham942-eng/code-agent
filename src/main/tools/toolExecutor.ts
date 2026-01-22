// ============================================================================
// Tool Executor - Executes tools with permission handling
// ============================================================================

import type { Generation } from '../../shared/types';
import type {
  ToolRegistry,
  Tool,
  ToolContext,
  ToolExecutionResult,
  PermissionRequestData,
} from './toolRegistry';
import { getToolCache } from '../services';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ToolExecutor');

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Tool Executor 配置
 * @internal
 */
export interface ToolExecutorConfig {
  toolRegistry: ToolRegistry;
  requestPermission: (request: PermissionRequestData) => Promise<boolean>;
  workingDirectory: string;
}

/**
 * 工具执行选项
 * @internal
 */
export interface ExecuteOptions {
  generation: Generation;
  planningService?: unknown; // PlanningService instance for persistent planning
  modelConfig?: unknown; // ModelConfig for subagent execution
  // Plan Mode support (borrowed from Claude Code v2.0)
  setPlanMode?: (active: boolean) => void;
  isPlanMode?: () => boolean;
  emitEvent?: (event: string, data: unknown) => void;
}

// ----------------------------------------------------------------------------
// Tool Executor
// ----------------------------------------------------------------------------

/**
 * Tool Executor - 工具执行器
 *
 * 负责工具的实际执行，包括：
 * - 权限检查（根据 requiresPermission 和 permissionLevel）
 * - 危险命令检测（rm -rf、git push --force 等）
 * - 结果缓存（通过 ToolCache）
 * - 执行上下文构建
 *
 * @example
 * ```typescript
 * const executor = new ToolExecutor({
 *   toolRegistry,
 *   requestPermission: async (req) => confirm(req.reason),
 *   workingDirectory: '/path/to/project',
 * });
 *
 * const result = await executor.execute('bash', { command: 'ls' }, {
 *   generation: { id: 'gen4', name: 'Gen 4' },
 * });
 * ```
 *
 * @see ToolRegistry - 工具注册表
 * @see ToolCache - 工具结果缓存
 */
export class ToolExecutor {
  private toolRegistry: ToolRegistry;
  private requestPermission: (request: PermissionRequestData) => Promise<boolean>;
  private workingDirectory: string;

  constructor(config: ToolExecutorConfig) {
    this.toolRegistry = config.toolRegistry;
    this.requestPermission = config.requestPermission;
    this.workingDirectory = config.workingDirectory;
  }

  /**
   * 设置工作目录
   *
   * @param path - 新的工作目录路径
   */
  setWorkingDirectory(path: string): void {
    this.workingDirectory = path;
  }

  /**
   * 执行指定工具
   *
   * 执行流程：
   * 1. 查找工具并验证代际可用性
   * 2. 构建执行上下文
   * 3. 检查权限（如需要）
   * 4. 检查缓存（如适用）
   * 5. 执行工具并返回结果
   *
   * @param toolName - 工具名称
   * @param params - 工具参数
   * @param options - 执行选项（代际、规划服务等）
   * @returns 工具执行结果
   */
  async execute(
    toolName: string,
    params: Record<string, unknown>,
    options: ExecuteOptions
  ): Promise<ToolExecutionResult> {
    logger.debug('Executing tool', { toolName, params: JSON.stringify(params).substring(0, 200) });

    const tool = this.toolRegistry.get(toolName);

    if (!tool) {
      logger.debug('Tool not found', { toolName });
      return {
        success: false,
        error: `Unknown tool: ${toolName}`,
      };
    }

    logger.debug('Tool found', { toolName, generations: tool.generations.join(','), current: options.generation.id });

    // Check if tool is available for current generation
    if (!tool.generations.includes(options.generation.id)) {
      return {
        success: false,
        error: `Tool ${toolName} is not available in ${options.generation.name}`,
      };
    }

    // Create tool context
    const context: ToolContext = {
      workingDirectory: this.workingDirectory,
      generation: options.generation,
      requestPermission: this.requestPermission,
      planningService: options.planningService,
      // For subagent execution (task, skill tools)
      toolRegistry: this.toolRegistry,
      modelConfig: options.modelConfig,
      // Plan Mode support (borrowed from Claude Code v2.0)
      setPlanMode: options.setPlanMode,
      isPlanMode: options.isPlanMode,
      emitEvent: options.emitEvent,
      // Also set emit as alias for emitEvent (tools use context.emit)
      emit: options.emitEvent,
    };

    // Check permission if required
    if (tool.requiresPermission) {
      const permissionRequest = this.buildPermissionRequest(tool, params);
      const approved = await this.requestPermission(permissionRequest);

      if (!approved) {
        return {
          success: false,
          error: 'Permission denied by user',
        };
      }
    }

    // Get tool cache
    const toolCache = getToolCache();

    // Check cache for cacheable tools
    if (toolCache.isCacheable(toolName)) {
      const cached = toolCache.get(toolName, params);
      if (cached) {
        logger.debug('Cache HIT', { toolName });
        return {
          success: true,
          result: cached,
          fromCache: true,
        };
      }
      logger.debug('Cache MISS', { toolName });
    }

    try {
      // Execute the tool
      logger.debug('Calling tool.execute', { toolName });
      const result = await tool.execute(params, context);
      logger.debug('Tool result', { toolName, success: result.success, error: result.error });

      // Cache successful results for cacheable tools
      if (result.success && toolCache.isCacheable(toolName) && result.result !== undefined) {
        toolCache.set(toolName, params, result.result as import('../../shared/types').ToolResult);
        logger.debug('Cached result', { toolName });
      }

      return result;
    } catch (error) {
      logger.error('Tool threw error', error, { toolName });
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  private buildPermissionRequest(
    tool: Tool,
    params: Record<string, unknown>
  ): PermissionRequestData {
    const details: Record<string, unknown> = {};

    switch (tool.name) {
      case 'bash':
        return {
          type: this.isDangerousCommand(params.command as string)
            ? 'dangerous_command'
            : 'command',
          tool: tool.name,
          details: { command: params.command },
          reason: 'Execute shell command',
        };

      case 'read_file':
        return {
          type: 'file_read',
          tool: tool.name,
          details: { path: params.file_path },
        };

      case 'write_file':
        return {
          type: 'file_write',
          tool: tool.name,
          details: {
            path: params.file_path,
            contentLength: (params.content as string)?.length || 0,
          },
        };

      case 'edit_file':
        return {
          type: 'file_edit',
          tool: tool.name,
          details: {
            path: params.file_path,
            oldString: params.old_string,
            newString: params.new_string,
          },
        };

      case 'web_fetch':
      case 'web_search':
        return {
          type: 'network',
          tool: tool.name,
          details: { url: params.url, query: params.query },
        };

      case 'mcp':
      case 'mcp_read_resource':
        return {
          type: 'network',
          tool: tool.name,
          details: {
            server: params.server,
            tool: params.tool,
            uri: params.uri,
          },
          reason: `调用 MCP 服务器 ${params.server}`,
        };

      default: {
        // Map permission level to permission request type
        const typeMap: Record<string, PermissionRequestData['type']> = {
          read: 'file_read',
          write: 'file_write',
          execute: 'command',
          network: 'network',
        };
        return {
          type: typeMap[tool.permissionLevel] || 'file_read',
          tool: tool.name,
          details: params,
        };
      }
    }
  }

  private isDangerousCommand(command: string): boolean {
    const dangerousPatterns = [
      /rm\s+(-r|-rf|-f)?\s*[\/~]/,
      /rm\s+-rf?\s+\*/,
      />\s*\/dev\/sd/,
      /mkfs/,
      /dd\s+if=/,
      /:\(\)\{.*\}/,
      /git\s+push\s+.*--force/,
      /git\s+reset\s+--hard/,
      /chmod\s+-R\s+777/,
      /sudo\s+rm/,
    ];

    return dangerousPatterns.some((pattern) => pattern.test(command));
  }
}
