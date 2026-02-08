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
import {
  getCommandMonitor,
  getAuditLogger,
  maskSensitiveData,
  type ValidationResult,
} from '../security';
import { createFileCheckpointIfNeeded } from './middleware/fileCheckpointMiddleware';
import { getConfirmationGate } from '../agent/confirmationGate';

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
  // Session ID for cross-session isolation
  sessionId?: string;
  // Skill 系统支持：预授权工具列表（跳过权限确认）
  preApprovedTools?: Set<string>;
  // Current message attachments for multi-agent workflows
  currentAttachments?: Array<{
    type: string;
    category?: string;
    name?: string;
    path?: string;
    data?: string;
    mimeType?: string;
  }>;
  // 当前工具调用 ID（用于 subagent 追踪）
  currentToolCallId?: string;
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
  private auditEnabled = true;

  constructor(config: ToolExecutorConfig) {
    this.toolRegistry = config.toolRegistry;
    this.requestPermission = config.requestPermission;
    this.workingDirectory = config.workingDirectory;
  }

  /**
   * Enable or disable audit logging
   */
  setAuditEnabled(enabled: boolean): void {
    this.auditEnabled = enabled;
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

    // 文件检查点：在写入工具执行前保存原文件
    await createFileCheckpointIfNeeded(toolName, params, () => {
      if (!options.sessionId) return null;
      // messageId 从 context 中获取，如果没有则使用工具调用 ID
      const messageId = options.currentToolCallId || `msg_${Date.now()}`;
      return { sessionId: options.sessionId, messageId };
    });

    // Create tool context
    const context: ToolContext & { sessionId?: string } = {
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
      // Session ID for cross-session isolation (fixes todo pollution)
      sessionId: options.sessionId,
      // Current message attachments for multi-agent workflows
      currentAttachments: options.currentAttachments,
      // 当前工具调用 ID（用于 subagent 追踪）
      currentToolCallId: options.currentToolCallId,
    };

    // Security: Pre-execution validation for bash commands
    let commandValidation: ValidationResult | undefined;
    if (toolName === 'bash' && params.command) {
      const commandMonitor = getCommandMonitor(options.sessionId);
      commandValidation = commandMonitor.preExecute(params.command as string);

      // Block critical risk commands
      if (!commandValidation.allowed) {
        logger.warn('Command blocked by security', {
          command: maskSensitiveData((params.command as string).substring(0, 100)),
          reason: commandValidation.reason,
          flags: commandValidation.securityFlags,
        });

        // Log security incident
        if (this.auditEnabled) {
          const auditLogger = getAuditLogger();
          auditLogger.logSecurityIncident({
            sessionId: options.sessionId || 'unknown',
            toolName: 'bash',
            incident: `Blocked command: ${commandValidation.reason}`,
            details: {
              command: maskSensitiveData((params.command as string).substring(0, 200)),
              securityFlags: commandValidation.securityFlags,
            },
            riskLevel: commandValidation.riskLevel,
          });
        }

        return {
          success: false,
          error: `Security: Command blocked - ${commandValidation.reason}`,
        };
      }

      // Warn about high-risk commands but allow them
      if (commandValidation.riskLevel === 'high') {
        logger.warn('High-risk command detected', {
          command: maskSensitiveData((params.command as string).substring(0, 100)),
          flags: commandValidation.securityFlags,
        });
      }
    }

    // Check permission if required
    // Skill 系统：预授权工具跳过权限检查
    const isPreApproved = this.isToolPreApproved(toolName, params, options.preApprovedTools);
    if (isPreApproved) {
      logger.debug('Tool pre-approved by Skill system, skipping permission check', { toolName });
    }

    if (tool.requiresPermission && !isPreApproved) {
      const permissionRequest = this.buildPermissionRequest(tool, params);

      // E2: 确认门控 - 为写操作附加预览信息
      try {
        const gate = getConfirmationGate();
        const preview = gate.buildPreview(toolName, params);
        if (preview) {
          permissionRequest.details.preview = preview;
        }
      } catch (error) {
        logger.debug('ConfirmationGate preview error:', error);
      }

      const approved = await this.requestPermission(permissionRequest);

      if (!approved) {
        // Log permission denial
        if (this.auditEnabled) {
          const auditLogger = getAuditLogger();
          auditLogger.log({
            eventType: 'permission_check',
            sessionId: options.sessionId || 'unknown',
            toolName,
            input: this.sanitizeParams(params),
            duration: 0,
            success: false,
            error: 'Permission denied by user',
          });
        }

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

    const startTime = Date.now();
    try {
      // Execute the tool
      logger.debug('Calling tool.execute', { toolName });
      const result = await tool.execute(params, context);
      const duration = Date.now() - startTime;

      logger.debug('Tool result', { toolName, success: result.success, error: result.error });

      // Cache successful results for cacheable tools
      if (result.success && toolCache.isCacheable(toolName) && result.result !== undefined) {
        toolCache.set(toolName, params, result.result as import('../../shared/types').ToolResult);
        logger.debug('Cached result', { toolName });
      }

      // Audit logging
      if (this.auditEnabled) {
        const auditLogger = getAuditLogger();
        auditLogger.logToolUsage({
          sessionId: options.sessionId || 'unknown',
          toolName,
          input: this.sanitizeParams(params),
          output: result.result ? this.truncateOutput(String(result.result)) : undefined,
          duration,
          success: result.success,
          error: result.error,
          securityFlags: commandValidation?.securityFlags,
          riskLevel: commandValidation?.riskLevel,
        });
      }

      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Tool threw error', error, { toolName });

      // Audit logging for errors
      if (this.auditEnabled) {
        const auditLogger = getAuditLogger();
        auditLogger.logToolUsage({
          sessionId: options.sessionId || 'unknown',
          toolName,
          input: this.sanitizeParams(params),
          duration,
          success: false,
          error: error instanceof Error ? error.message : 'Unknown error',
          securityFlags: commandValidation?.securityFlags,
          riskLevel: commandValidation?.riskLevel,
        });
      }

      return {
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      };
    }
  }

  /**
   * Sanitize parameters for logging (mask sensitive data)
   */
  private sanitizeParams(params: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(params)) {
      if (typeof value === 'string') {
        sanitized[key] = maskSensitiveData(value);
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }

  /**
   * Truncate output for logging
   */
  private truncateOutput(output: string, maxLength = 1000): string {
    if (output.length > maxLength) {
      return output.substring(0, maxLength) + '...[truncated]';
    }
    return output;
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

  /**
   * 检查工具是否预授权（Skill 系统支持）
   *
   * 支持以下匹配模式：
   * 1. 精确匹配：工具名完全相等（如 "bash", "read_file"）
   * 2. 通配符匹配：Bash(prefix:*) 格式，匹配以指定前缀开头的命令
   *    例如：Bash(git:*) 匹配所有以 "git" 开头的 bash 命令
   *
   * @param toolName - 工具名称
   * @param params - 工具参数
   * @param preApprovedTools - 预授权工具集合
   * @returns 是否预授权
   */
  private isToolPreApproved(
    toolName: string,
    params: Record<string, unknown>,
    preApprovedTools?: Set<string>
  ): boolean {
    if (!preApprovedTools || preApprovedTools.size === 0) {
      return false;
    }

    // 1. 精确匹配（大小写不敏感）
    const toolNameLower = toolName.toLowerCase();
    for (const approved of preApprovedTools) {
      if (approved.toLowerCase() === toolNameLower) {
        return true;
      }
    }

    // 2. 通配符匹配（如 Bash(git:*)）
    for (const pattern of preApprovedTools) {
      // 匹配格式: ToolName(prefix:*)
      const match = pattern.match(/^(\w+)\(([^:]+):\*\)$/);
      if (!match) continue;

      const [, patternTool, prefix] = match;

      // 检查工具名是否匹配
      if (patternTool.toLowerCase() !== toolNameLower) continue;

      // 对于 bash 命令，检查命令前缀
      if (toolNameLower === 'bash') {
        const command = (params.command as string) || '';
        // 去除前导空格后检查前缀
        const trimmedCommand = command.trimStart();
        if (trimmedCommand.startsWith(prefix)) {
          return true;
        }
      }
    }

    return false;
  }
}
