// ============================================================================
// Tool Executor - Executes tools with permission handling
// ============================================================================

import type {
  ToolContext,
  ToolExecutionResult,
  PermissionRequestData,
} from './types';
import type { ToolDefinition } from '../../shared/contract';
import { getToolCache } from '../services/infra/toolCache';
import { createLogger } from '../services/infra/logger';
import {
  getAuditLogger,
  maskSensitiveData,
  isKnownSafeCommand,
  validateCommand,
  getExecPolicyStore,
  type ValidationResult,
} from '../security';
import { createFileCheckpointIfNeeded } from './middleware/fileCheckpointMiddleware';
import { getConfirmationGate } from '../agent/confirmationGate';
import { classifyPermission } from './permissionClassifier';
import { createTraceBuilder } from '../security/decisionTraceBuilder';
import { getDecisionHistory, type DecisionOutcome } from '../security/decisionHistory';
import type { HookManager } from '../hooks/hookManager';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import type {
  ConversationExecutionIntent,
  WorkbenchToolScope,
} from '../../shared/contract/conversationEnvelope';
import { isBashToolName, normalizeToolName, sameToolName } from './toolNames';

const logger = createLogger('ToolExecutor');

/** Record a permission decision to the history buffer */
function recordDecision(
  toolName: string, params: Record<string, unknown>,
  outcome: DecisionOutcome, reason: string, startTime: number
): void {
  const summary = String(params.command || params.file_path || params.path || params.pattern || toolName).substring(0, 80);
  getDecisionHistory().record({
    timestamp: Date.now(), toolName, summary, outcome, reason,
    durationMs: Date.now() - startTime,
  });
}

function commandMatchesScopedPrefix(command: string, prefix: string): boolean {
  const trimmedCommand = command.trimStart();
  return trimmedCommand === prefix
    || trimmedCommand.startsWith(`${prefix} `)
    || trimmedCommand.startsWith(`${prefix}\t`);
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Tool Executor 配置
 * @internal
 */
export interface ToolExecutorConfig {
  requestPermission: (request: PermissionRequestData) => Promise<boolean>;
  workingDirectory: string;
}

/**
 * 工具执行选项
 * @internal
 */
export interface ExecuteOptions {
  generation?: { id: string };
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
  // 模型回调（工具内二次调用模型，如 PPT 内容生成）
  modelCallback?: (prompt: string) => Promise<string>;
  // Hook 系统：传递给工具上下文（subagent/permission 事件触发）
  hookManager?: HookManager;
  // 当前 turn 的显式工具作用域
  toolScope?: WorkbenchToolScope;
  // 当前 turn 的结构化执行意图
  executionIntent?: ConversationExecutionIntent;
  // Run-level cancellation signal propagated from the agent loop.
  abortSignal?: AbortSignal;
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
 * });
 * ```
 *
 * @see ToolRegistry - 工具注册表
 * @see ToolCache - 工具结果缓存
 */
export class ToolExecutor {
  private requestPermission: (request: PermissionRequestData) => Promise<boolean>;
  private workingDirectory: string;
  private auditEnabled = true;

  constructor(config: ToolExecutorConfig) {
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
    const requestedToolName = toolName;
    const normalizedRequestedToolName = normalizeToolName(requestedToolName);
    logger.debug('Executing tool', {
      toolName: requestedToolName,
      normalizedToolName: normalizedRequestedToolName,
      params: JSON.stringify(params).substring(0, 200),
    });

    const resolver = getToolResolver();
    const toolDef = resolver.getDefinition(requestedToolName)
      ?? (normalizedRequestedToolName !== requestedToolName
        ? resolver.getDefinition(normalizedRequestedToolName)
        : undefined);

    if (!toolDef) {
      logger.debug('Tool not found', { toolName: requestedToolName });
      return {
        success: false,
        error: `Unknown tool: ${requestedToolName}`,
      };
    }

    const executionToolName = toolDef.name;
    const policyToolName = normalizeToolName(executionToolName);

    logger.debug('Tool found', { toolName: executionToolName, requestedToolName });

    // Required-field guardrail: 在执行前校验 schema 里声明的 required 字段是否都提供了。
    // 模型经常幻觉工具名并传空参数，护栏把错误往前移到 executor 入口，避免下游 handler 炸。
    const requiredFields = toolDef.inputSchema?.required ?? [];
    const missing = requiredFields.filter((field) => {
      const value = params[field];
      return value === undefined || value === null || (typeof value === 'string' && value.trim() === '');
    });
    if (missing.length > 0) {
      logger.warn('Tool call missing required fields', { toolName: executionToolName, requestedToolName, missing });
      return {
        success: false,
        error: `工具 "${executionToolName}" 缺少必填参数: ${missing.join(', ')}。请检查工具 schema 并重新调用。`,
      };
    }


    // 文件检查点：在写入工具执行前保存原文件
    await createFileCheckpointIfNeeded(executionToolName, params, () => {
      if (!options.sessionId) return null;
      // messageId 从 context 中获取，如果没有则使用工具调用 ID
      const messageId = options.currentToolCallId || `msg_${Date.now()}`;
      return { sessionId: options.sessionId, messageId };
    });

    // Create tool context
    const context: ToolContext & { sessionId?: string } = {
      workingDirectory: this.workingDirectory,
      requestPermission: this.requestPermission,
      abortSignal: options.abortSignal,
      planningService: options.planningService,
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
      // 模型回调（工具内二次调用模型）
      modelCallback: options.modelCallback,
      // Hook 系统（subagent/permission 事件触发）
      hookManager: options.hookManager,
      toolScope: options.toolScope,
      executionIntent: options.executionIntent,
    };

    // Security: Pre-execution validation for bash commands
    const permStartTime = Date.now();
    let commandValidation: ValidationResult | undefined;
    if (isBashToolName(policyToolName) && params.command) {
      commandValidation = validateCommand(params.command as string);

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
            toolName: executionToolName,
            incident: `Blocked command: ${commandValidation.reason}`,
            details: {
              command: maskSensitiveData((params.command as string).substring(0, 200)),
              securityFlags: commandValidation.securityFlags,
            },
            riskLevel: commandValidation.riskLevel,
          });
        }

        // Fire-and-forget: emit PermissionDenied hook
        options.hookManager?.triggerPermissionDenied(
          executionToolName, commandValidation.reason || 'security policy', 'policy',
          options.sessionId || 'unknown',
        ).catch(() => {});
        recordDecision(executionToolName, params, 'monitor-blocked', commandValidation.reason || 'security', permStartTime);

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
    const isPreApproved = this.isToolPreApproved(executionToolName, params, options.preApprovedTools);
    if (isPreApproved) {
      logger.debug('Tool pre-approved by Skill system, skipping permission check', { toolName: executionToolName });
      recordDecision(executionToolName, params, 'auto-approve', 'pre-approved', permStartTime);
    }

    // P0: 安全命令白名单 + exec policy — 已知安全命令跳过审批
    let isSafeCommand = false;
    if (isBashToolName(policyToolName) && params.command && !isPreApproved) {
      const cmd = params.command as string;

      // 1. 检查 exec policy 持久化规则
      try {
        const policyDecision = getExecPolicyStore().match(cmd);
        if (policyDecision === 'allow') {
          isSafeCommand = true;
          logger.debug('Command allowed by exec policy', { command: cmd.substring(0, 80) });
          recordDecision(executionToolName, params, 'policy-allow', 'exec-policy', permStartTime);
        } else if (policyDecision === 'forbidden') {
          recordDecision(executionToolName, params, 'policy-deny', 'exec-policy', permStartTime);
          return {
            success: false,
            error: `Blocked by exec policy: ${cmd.substring(0, 80)}`,
          };
        }
      } catch {
        // exec policy not initialized, skip
      }

      // 2. 检查安全命令白名单
      if (!isSafeCommand && isKnownSafeCommand(cmd)) {
        isSafeCommand = true;
        logger.debug('Command is known safe, skipping approval', { command: cmd.substring(0, 80) });
        recordDecision(executionToolName, params, 'auto-approve', 'safe-command', permStartTime);
      }
    }

    if (toolDef.requiresPermission && !isPreApproved && !isSafeCommand) {
      // P1: Auto-approve classifier — 规则+LLM 自动判断安全性
      let needsUserApproval = true;
      // Lazy trace: only created when needed (deny/ask path)
      const traceBuilder = createTraceBuilder(executionToolName);
      try {
        const classification = await classifyPermission(policyToolName, params, {
          workingDirectory: this.workingDirectory,
          permissionLevel: toolDef.permissionLevel,
        });
        if (classification.decision === 'approve') {
          logger.info('Auto-approved by classifier', {
            tool: executionToolName,
            reason: classification.reason,
            confidence: classification.confidence,
            cached: classification.cached,
          });
          needsUserApproval = false;
          recordDecision(executionToolName, params, 'auto-approve', classification.reason || 'classifier', permStartTime);
        } else if (classification.decision === 'deny') {
          // Collect trace step from classifier
          if (classification.traceStep) {
            traceBuilder.addStep(
              classification.traceStep.layer,
              classification.traceStep.rule,
              classification.traceStep.result,
              classification.traceStep.reason,
            );
          }
          logger.warn('Denied by classifier', {
            tool: executionToolName,
            reason: classification.reason,
          });
          // Fire-and-forget: emit PermissionDenied hook
          options.hookManager?.triggerPermissionDenied(
            executionToolName, classification.reason || 'classifier deny', 'classifier',
            options.sessionId || 'unknown',
          ).catch(() => {});
          recordDecision(executionToolName, params, 'classifier-deny', classification.reason || 'classifier', permStartTime);
          return {
            success: false,
            error: `Denied: ${classification.reason}`,
          };
        } else {
          // 'ask' — collect trace step for permission request
          if (classification.traceStep) {
            traceBuilder.addStep(
              classification.traceStep.layer,
              classification.traceStep.rule,
              classification.traceStep.result,
              classification.traceStep.reason,
            );
          }
        }
      } catch (classifierError) {
        logger.debug('Permission classifier error, falling back to user approval', classifierError);
      }

      if (needsUserApproval) {
      const permissionRequest = this.buildPermissionRequest(toolDef, params);
      permissionRequest.sessionId = options.sessionId;

      // Attach decision trace to permission request
      permissionRequest.decisionTrace = traceBuilder.build('ask');

      // E2: 确认门控 - 为高风险写操作附加预览并强制确认
      try {
        const gate = getConfirmationGate();
        const preview = gate.buildPreview(executionToolName, params);
        const riskLevel = gate.assessRiskLevel(executionToolName, params);
        const shouldForceConfirm = gate.shouldConfirm(
          {
            toolName: executionToolName,
            params,
            preview,
            riskLevel,
          },
          options.sessionId || 'global'
        );

        if (preview) {
          permissionRequest.details.preview = preview;
        }
        if (shouldForceConfirm) {
          permissionRequest.forceConfirm = true;
          permissionRequest.dangerLevel = riskLevel === 'high'
            ? 'danger'
            : (riskLevel === 'medium' ? 'warning' : 'normal');
        }
      } catch (error) {
        logger.debug('ConfirmationGate preview error:', error);
      }

      // PermissionRequest hook: allow hooks to intercept/block before user prompt
      if (options.hookManager) {
        try {
          const permType = (permissionRequest.type === 'dangerous_command' ? 'dangerous'
            : permissionRequest.type === 'command' ? 'execute'
            : permissionRequest.type === 'file_read' ? 'read'
            : permissionRequest.type === 'file_write' || permissionRequest.type === 'file_edit' ? 'write'
            : permissionRequest.type === 'network' ? 'network'
            : 'execute') as 'read' | 'write' | 'execute' | 'network' | 'dangerous';
          const resource = String(
            permissionRequest.details.path
            || permissionRequest.details.command
            || permissionRequest.details.url
            || executionToolName,
          );
          const hookResult = await options.hookManager.triggerPermissionRequest(
            permType,
            resource,
            executionToolName,
            options.sessionId || 'unknown',
            permissionRequest.reason,
          );
          if (!hookResult.shouldProceed) {
            // Fire-and-forget: emit PermissionDenied hook
            options.hookManager?.triggerPermissionDenied(
              executionToolName, hookResult.message || 'blocked', 'hook',
              options.sessionId || 'unknown',
            ).catch(() => {});
            recordDecision(executionToolName, params, 'hook-blocked', hookResult.message || 'hook', permStartTime);
            return {
              success: false,
              error: `Permission denied by hook: ${hookResult.message || 'blocked'}`,
            };
          }
        } catch (hookError) {
          logger.debug('PermissionRequest hook error, continuing to user approval', hookError);
        }
      }

      const approved = await this.requestPermission(permissionRequest);

      if (approved) {
        recordDecision(executionToolName, params, 'ask-approved', 'user', permStartTime);
      }

      // P0: prefix_rule 学习 — 用户批准后生成持久化规则
      if (approved && isBashToolName(policyToolName) && params.command) {
        try {
          getExecPolicyStore().learnFromApproval(params.command as string);
        } catch {
          // exec policy not initialized, skip
        }
      }

      if (!approved) {
        // Log permission denial
        if (this.auditEnabled) {
          const auditLogger = getAuditLogger();
          auditLogger.log({
            eventType: 'permission_check',
            sessionId: options.sessionId || 'unknown',
            toolName: executionToolName,
            input: this.sanitizeParams(params),
            duration: 0,
            success: false,
            error: 'Permission denied by user',
          });
        }
        // Fire-and-forget: emit PermissionDenied hook
        options.hookManager?.triggerPermissionDenied(
          executionToolName, 'Permission denied by user', 'user',
          options.sessionId || 'unknown',
        ).catch(() => {});
        recordDecision(executionToolName, params, 'ask-denied', 'user', permStartTime);

        return {
          success: false,
          error: 'Permission denied by user',
        };
      }
      } // end needsUserApproval
    }

    // Get tool cache
    const toolCache = getToolCache();

    // Check cache for cacheable tools
    if (toolCache.isCacheable(executionToolName)) {
      const cached = toolCache.get(executionToolName, params);
      if (cached) {
        logger.debug('Cache HIT', { toolName: executionToolName });
        return {
          success: true,
          result: cached,
          fromCache: true,
        };
      }
      logger.debug('Cache MISS', { toolName: executionToolName });
    }

    const startTime = Date.now();
    try {
      // Execute the tool via protocol resolver
      context.approvedToolCall = {
        toolName: executionToolName,
        args: params,
      };
      logger.debug('Dispatching to protocol resolver', { toolName: executionToolName, requestedToolName });
      const result = await resolver.execute(executionToolName, params, context);
      const duration = Date.now() - startTime;

      logger.debug('Tool result', { toolName: executionToolName, success: result.success, error: result.error });

      // Cache successful results for cacheable tools
      if (result.success && toolCache.isCacheable(executionToolName) && result.result !== undefined) {
        toolCache.set(executionToolName, params, result.result as import('../../shared/contract').ToolResult);
        logger.debug('Cached result', { toolName: executionToolName });
      }

      // Audit logging
      if (this.auditEnabled) {
        const auditLogger = getAuditLogger();
        auditLogger.logToolUsage({
          sessionId: options.sessionId || 'unknown',
          toolName: executionToolName,
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
      logger.error('Tool threw error', error, { toolName: executionToolName });

      // Audit logging for errors
      if (this.auditEnabled) {
        const auditLogger = getAuditLogger();
        auditLogger.logToolUsage({
          sessionId: options.sessionId || 'unknown',
          toolName: executionToolName,
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
    tool: ToolDefinition,
    params: Record<string, unknown>
  ): PermissionRequestData {
    switch (tool.name) {
      case 'bash':
      case 'Bash':
        return {
          type: this.isDangerousCommand(params.command as string)
            ? 'dangerous_command'
            : 'command',
          tool: tool.name,
          details: { command: params.command },
          reason: 'Execute shell command',
        };

      case 'read_file':
      case 'Read':
        return {
          type: 'file_read',
          tool: tool.name,
          details: { path: params.file_path },
        };

      case 'write_file':
      case 'Write':
        return {
          type: 'file_write',
          tool: tool.name,
          details: {
            path: params.file_path,
            contentLength: (params.content as string)?.length || 0,
          },
        };

      case 'edit_file':
      case 'Edit':
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
      case 'WebFetch':
      case 'web_search':
      case 'WebSearch':
        return {
          type: 'network',
          tool: tool.name,
          details: { url: params.url, query: params.query },
        };

      case 'mcp':
      case 'MCPUnified':
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
          details: { ...params },
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

    // 1. 精确匹配（Bash/bash 语义归一）
    const normalizedToolName = normalizeToolName(toolName);
    for (const approved of preApprovedTools) {
      if (sameToolName(approved, normalizedToolName)) {
        return true;
      }
    }

    // 2. 通配符匹配（如 Bash(git:*)）
    for (const pattern of preApprovedTools) {
      // 匹配格式: ToolName(prefix:*)
      const match = pattern.match(/^([A-Za-z][A-Za-z0-9_.:-]*)\(([A-Za-z0-9._/@+-]+):\*\)$/);
      if (!match) continue;

      const [, patternTool, prefix] = match;

      // 检查工具名是否匹配
      if (!sameToolName(patternTool, normalizedToolName)) continue;

      // 对于 bash 命令，检查命令前缀
      if (isBashToolName(normalizedToolName)) {
        const command = (params.command as string) || '';
        if (commandMatchesScopedPrefix(command, prefix)) {
          return true;
        }
      }
    }

    return false;
  }
}
