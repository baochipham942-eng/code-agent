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
  getShellSafetyMode,
  getExecPolicyStore,
  getPolicyEnforcer,
  type PolicyEnforcer,
  type PolicyCheckResult,
  type ValidationResult,
} from '../security';
import { createFileCheckpointIfNeeded } from './middleware/fileCheckpointMiddleware';
import { getConfirmationGate } from '../agent/confirmationGate';
import { classifyPermission, type ClassificationResult } from './permissionClassifier';
import type { SkillToolBoundary } from '../../shared/contract/agentSkill';
import { createTraceBuilder, createTraceStep } from '../security/decisionTraceBuilder';
import { getDecisionHistory, type DecisionOutcome as HistoryDecisionOutcome } from '../security/decisionHistory';
import {
  getWriteIsolationManager,
  getWriteIsolationScope,
  type WriteIsolationMetadata,
} from '../security/writeIsolation';
import type {
  DecisionLayer,
  DecisionOutcome as TraceDecisionOutcome,
  DecisionTrace,
} from '../../shared/contract/decisionTrace';
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
  outcome: HistoryDecisionOutcome, reason: string, startTime: number, trace?: DecisionTrace
): void {
  const summary = String(params.command || params.file_path || params.path || params.pattern || toolName).substring(0, 80);
  const decisionTrace = trace ?? buildHistoryDecisionTrace(toolName, outcome, reason, startTime);
  getDecisionHistory().record({
    timestamp: Date.now(), toolName, summary, outcome, reason,
    durationMs: Date.now() - startTime,
    decisionTrace,
  });
}

function historyOutcomeToTraceOutcome(outcome: HistoryDecisionOutcome): TraceDecisionOutcome {
  if (outcome === 'auto-approve' || outcome === 'ask-approved' || outcome === 'policy-allow') return 'allow';
  return 'deny';
}

function historyOutcomeToLayer(outcome: HistoryDecisionOutcome): DecisionLayer {
  if (outcome === 'policy-allow' || outcome === 'policy-deny' || outcome === 'monitor-blocked') {
    return outcome === 'monitor-blocked' ? 'guard_fabric' : 'policy_enforcer';
  }
  if (outcome === 'classifier-deny' || outcome === 'auto-approve') return 'permission_classifier';
  if (outcome === 'hook-blocked') return 'plugin_hook';
  return 'plan_approval';
}

function buildHistoryDecisionTrace(
  toolName: string,
  outcome: HistoryDecisionOutcome,
  reason: string,
  startTime: number,
): DecisionTrace {
  const result = historyOutcomeToTraceOutcome(outcome);
  return {
    toolName,
    finalOutcome: result,
    steps: [{
      layer: historyOutcomeToLayer(outcome),
      rule: outcome,
      result,
      reason,
      durationMs: Date.now() - startTime,
      timestamp: Date.now(),
    }],
    totalDurationMs: Date.now() - startTime,
  };
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
  planningService?: unknown; // PlanningService instance for persistent planning
  modelConfig?: unknown; // ModelConfig for subagent execution
  // Plan Mode support (borrowed from Claude Code v2.0)
  setPlanMode?: (active: boolean) => void;
  isPlanMode?: () => boolean;
  emitEvent?: (event: string, data: unknown) => void;
  // Session ID for cross-session isolation
  sessionId?: string;
  // Agent ID for per-agent BrowserPool / ComputerSurface isolation。子 agent 派活
  // 时由 subagent pipeline 灌入；主 agent 留 undefined → default agent。
  agentId?: string;
  // 当前 agent 在 spawn 链路中的嵌套深度（主 agent = 0）。
  spawnDepth?: number;
  // 会话级 spawn 深度覆盖，执行层会 clamp 到硬上限。
  spawnMaxDepth?: number;
  // 根 agent / 根 session 的 spawn tree id，整棵树共享同一并发槽位池。
  spawnTreeId?: string;
  // 超额 spawn 等待 tree 槽位的超时时间。
  spawnQueueTimeoutMs?: number;
  // 持久化角色 ID（agent 注册 id）。subagent 执行时由 subagentExecutor 灌入，
  // MemoryWrite/Read 的 scope='role' 路由按这个 id 定位 roles/<id>/ 目录。
  agentRole?: string;
  // Skill 系统支持：预授权工具列表（跳过权限确认）
  preApprovedTools?: Set<string>;
  // GAP-001: Skill allowed-tools 限权边界。设置后，边界外的工具调用强制用户审批
  //（不能被预授权/安全白名单/classifier 自动放行）。
  skillToolBoundary?: SkillToolBoundary;
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
  // Subagent 执行策略 — 存在即表示这是 subagent 调用。
  // ToolExecutor 在权限决策前先过这道闸：工具白名单 + 收缩策略。
  // 策略只能收紧（deny），不能放宽：'deny' 直接拒，'ask' 继续走常规管道
  // （validateCommand / classifyPermission / exec policy / 审计 / cache）。
  // 这保证 subagent 与主 agent 走同一条 ToolExecutor 管道，而非绕过权限的旁路。
  subagentPolicy?: {
    allowedTools: Set<string>;
    check: (toolName: string, params: Record<string, unknown>) => 'deny' | 'ask';
  };
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
   * 1. 查找工具定义
   * 2. 构建执行上下文
   * 3. 检查权限（如需要）
   * 4. 检查缓存（如适用）
   * 5. 执行工具并返回结果
   *
   * @param toolName - 工具名称
   * @param params - 工具参数
   * @param options - 执行选项（规划服务、模型配置等）
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

    // Subagent 收缩闸：subagent 调用必须先过工具白名单 + 收缩策略。
    // 策略只能收紧不能放宽——'deny' 直接拒，'ask' 继续走下面的常规管道。
    if (options.subagentPolicy) {
      if (!options.subagentPolicy.allowedTools.has(executionToolName)) {
        logger.warn('Tool not in subagent allowlist', { toolName: executionToolName });
        return {
          success: false,
          error: `Tool not allowed for subagent: ${executionToolName}`,
        };
      }
      if (options.subagentPolicy.check(executionToolName, params) === 'deny') {
        logger.warn('Denied by subagent permission policy', { toolName: executionToolName });
        recordDecision(executionToolName, params, 'policy-deny', 'subagent policy', Date.now());
        return {
          success: false,
          error: `Denied by subagent permission policy: ${executionToolName}`,
        };
      }
    }

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
      // Per-agent BrowserPool / ComputerSurface isolation
      agentId: options.agentId,
      spawnDepth: options.spawnDepth,
      spawnMaxDepth: options.spawnMaxDepth,
      spawnTreeId: options.spawnTreeId,
      spawnQueueTimeoutMs: options.spawnQueueTimeoutMs,
      // 持久化角色 ID（MemoryWrite/Read scope='role' 路由用）
      agentRole: options.agentRole,
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

    // P0: Policy Enforcer — code-agent-policy.toml 硬规则（system/user/project 三层合并）。
    // deny 不可被任何后续层推翻（skill 预授权 / 安全命令白名单 / classifier / 用户审批）。
    // 无 policy 文件时 getPolicyEnforcer 返回 null，零开销。
    const policyEnforcer = getPolicyEnforcer(this.workingDirectory);
    if (policyEnforcer?.isActive) {
      const policyCheck = this.checkAgainstPolicy(policyEnforcer, executionToolName, policyToolName, params, toolDef);
      if (!policyCheck.allowed) {
        logger.warn('Blocked by policy enforcer', {
          toolName: executionToolName,
          section: policyCheck.section,
          reason: policyCheck.reason,
        });
        policyEnforcer.logToolCall(executionToolName, params, 'blocked', policyCheck.reason);

        if (this.auditEnabled) {
          getAuditLogger().logSecurityIncident({
            sessionId: options.sessionId || 'unknown',
            toolName: executionToolName,
            incident: `Blocked by policy: ${policyCheck.reason}`,
            details: { section: policyCheck.section },
            riskLevel: 'critical',
          });
        }

        // Fire-and-forget: emit PermissionDenied hook
        options.hookManager?.triggerPermissionDenied(
          executionToolName, policyCheck.reason || 'security policy', 'policy',
          options.sessionId || 'unknown',
        ).catch(() => {});

        const trace = policyCheck.traceStep
          ? createTraceBuilder(executionToolName)
            .addStep(
              policyCheck.traceStep.layer,
              policyCheck.traceStep.rule,
              policyCheck.traceStep.result,
              policyCheck.traceStep.reason,
            )
            .build('deny')
          : undefined;
        recordDecision(executionToolName, params, 'policy-deny', policyCheck.reason || 'policy', permStartTime, trace);

        return {
          success: false,
          error: `Blocked by policy: ${policyCheck.reason}`,
        };
      }
      policyEnforcer.logToolCall(executionToolName, params, 'allowed');
    }

    // Policy tools.always_confirm: 强制走用户审批，无视预授权/安全白名单/classifier 放行
    const policyForcesConfirmation = policyEnforcer?.requiresConfirmation(executionToolName) ?? false;

    // GAP-001: Skill allowed-tools 限权边界 — 边界外的工具调用强制用户审批。
    // 对所有 skill 来源生效（user/project skill 不能扩权，但它声明的边界必须被尊重）。
    // 只约束 requiresPermission 的工具（只读工具不受限）。
    const boundaryViolation = options.skillToolBoundary
      && toolDef.requiresPermission
      && !this.toolMatchesPatternSet(executionToolName, params, new Set(options.skillToolBoundary.allowedTools))
      ? options.skillToolBoundary
      : undefined;

    // Check permission if required
    // Skill 系统：预授权工具跳过权限检查（但不能跳过边界违规检查）
    const isPreApproved = !boundaryViolation
      && this.isToolPreApproved(executionToolName, params, options.preApprovedTools);
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

      // 3. lenient 模式（已决策 2026-06-10，朋友测试包默认）：硬毙清单照拦
      //    （validateCommand critical 在前置闸已挡），其余未识别命令放行不进审批。
      //    confirmationGate 的 HIGH_RISK_PATTERNS 仍独立生效，最高危命令保留确认。
      if (!isSafeCommand && getShellSafetyMode() === 'lenient') {
        const lenientCheck = commandValidation ?? validateCommand(cmd);
        if (lenientCheck.allowed) {
          isSafeCommand = true;
          logger.debug('Command auto-approved by lenient safety mode', { command: cmd.substring(0, 80) });
          recordDecision(executionToolName, params, 'auto-approve', 'lenient-mode', permStartTime);
        }
      }
    }

    if (toolDef.requiresPermission && (policyForcesConfirmation || boundaryViolation || (!isPreApproved && !isSafeCommand))) {
      // P1: Auto-approve classifier — 规则+LLM 自动判断安全性
      let needsUserApproval = true;
      // Lazy trace: only created when needed (deny/ask path)
      const traceBuilder = createTraceBuilder(executionToolName);
      try {
        // Policy always_confirm / skill 边界违规命中时跳过 classifier，直接进用户审批
        let classification: ClassificationResult;
        if (policyForcesConfirmation) {
          classification = {
            decision: 'ask',
            reason: `Tool "${executionToolName}" requires confirmation by policy (tools.always_confirm)`,
            confidence: 1,
            cached: false,
            traceStep: createTraceStep(
              'policy_enforcer',
              'tools.always_confirm',
              'ask',
              'Tool requires confirmation by policy',
              permStartTime,
            ),
          };
        } else if (boundaryViolation) {
          classification = {
            decision: 'ask',
            reason: `Tool "${executionToolName}" is outside skill "${boundaryViolation.skillName}" allowed-tools boundary (${boundaryViolation.allowedTools.join(', ')})`,
            confidence: 1,
            cached: false,
            traceStep: createTraceStep(
              'permission_classifier',
              'skill.allowed-tools-boundary',
              'ask',
              `Outside skill "${boundaryViolation.skillName}" tool boundary`,
              permStartTime,
            ),
          };
        } else {
          classification = await classifyPermission(policyToolName, params, {
            workingDirectory: this.workingDirectory,
            permissionLevel: toolDef.permissionLevel,
          });
        }
        if (classification.decision === 'approve') {
          logger.info('Auto-approved by classifier', {
            tool: executionToolName,
            reason: classification.reason,
            confidence: classification.confidence,
            cached: classification.cached,
          });
          needsUserApproval = false;
          const trace = classification.traceStep
            ? createTraceBuilder(executionToolName)
              .addStep(
                classification.traceStep.layer,
                classification.traceStep.rule,
                classification.traceStep.result,
                classification.traceStep.reason,
              )
              .build('allow')
            : undefined;
          recordDecision(executionToolName, params, 'auto-approve', classification.reason || 'classifier', permStartTime, trace);
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
          recordDecision(executionToolName, params, 'classifier-deny', classification.reason || 'classifier', permStartTime, traceBuilder.build('deny'));
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

    const writeIsolationScope = getWriteIsolationScope(
      executionToolName,
      params,
      this.workingDirectory,
      toolDef.permissionLevel,
    );
    let releaseWriteIsolation: (() => void) | undefined;
    let writeIsolationMetadata: WriteIsolationMetadata | undefined;
    const startTime = Date.now();
    try {
      if (writeIsolationScope) {
        const waitStart = Date.now();
        releaseWriteIsolation = await getWriteIsolationManager().acquire(writeIsolationScope, options.abortSignal);
        writeIsolationMetadata = {
          kind: writeIsolationScope.kind,
          targetPath: writeIsolationScope.targetPath,
          lockKey: writeIsolationScope.lockKey,
          waitMs: Date.now() - waitStart,
        };
      }

      // 文件检查点：写隔离锁拿到后再保存原文件，避免并行 worker 竞争同一目标。
      await createFileCheckpointIfNeeded(executionToolName, params, () => {
        if (!options.sessionId) return null;
        // messageId 从 context 中获取，如果没有则使用工具调用 ID
        const messageId = options.currentToolCallId || `msg_${Date.now()}`;
        return { sessionId: options.sessionId, messageId };
      });

      // Execute the tool via protocol resolver
      context.approvedToolCall = {
        toolName: executionToolName,
        args: params,
      };
      logger.debug('Dispatching to protocol resolver', { toolName: executionToolName, requestedToolName });
      const rawResult = await resolver.execute(executionToolName, params, context);
      const result = writeIsolationMetadata
        ? {
          ...rawResult,
          metadata: {
            ...(rawResult.metadata ?? {}),
            writeIsolation: writeIsolationMetadata,
          },
        }
        : rawResult;
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
    } finally {
      releaseWriteIsolation?.();
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

      case 'append_file':
      case 'Append':
        return {
          type: 'file_write',
          tool: tool.name,
          details: {
            path: params.file_path,
            contentLength: (params.content as string)?.length || 0,
            final: params.final === true,
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
  /**
   * GAP-002: 按工具类型路由到 PolicyEnforcer 对应的检查方法。
   * 返回第一个命中的 deny；全部通过返回 { allowed: true }。
   */
  private checkAgainstPolicy(
    enforcer: PolicyEnforcer,
    executionToolName: string,
    policyToolName: string,
    params: Record<string, unknown>,
    toolDef: ToolDefinition,
  ): PolicyCheckResult {
    // 1. 工具禁用清单（所有工具）
    const toolCheck = enforcer.checkTool(executionToolName);
    if (!toolCheck.allowed) return toolCheck;

    // 2. Shell 命令规则（denied_commands 正则 / allowed_command_prefixes / allow_shell）
    if (isBashToolName(policyToolName) && typeof params.command === 'string') {
      const commandCheck = enforcer.checkCommand(params.command);
      if (!commandCheck.allowed) return commandCheck;
    }

    // 3. 文件路径规则（denied_paths / denied_file_patterns / writable_paths）
    const filePath = typeof params.file_path === 'string'
      ? params.file_path
      : typeof params.path === 'string'
        ? params.path
        : undefined;
    if (filePath && (toolDef.permissionLevel === 'read' || toolDef.permissionLevel === 'write')) {
      const fileCheck = enforcer.checkFilePath(filePath, toolDef.permissionLevel);
      if (!fileCheck.allowed) return fileCheck;
    }

    // 4. 网络域名白名单
    if (toolDef.permissionLevel === 'network' && typeof params.url === 'string') {
      const networkCheck = enforcer.checkNetwork(params.url);
      if (!networkCheck.allowed) return networkCheck;
    }

    return { allowed: true };
  }

  private isToolPreApproved(
    toolName: string,
    params: Record<string, unknown>,
    preApprovedTools?: Set<string>
  ): boolean {
    if (!preApprovedTools || preApprovedTools.size === 0) {
      return false;
    }
    return this.toolMatchesPatternSet(toolName, params, preApprovedTools);
  }

  /**
   * 工具调用是否匹配模式集合（精确名 / Bash(prefix:*) 前缀模式）。
   * 同时服务于：Skill 预授权（扩权）与 Skill allowed-tools 边界（限权，GAP-001）。
   */
  private toolMatchesPatternSet(
    toolName: string,
    params: Record<string, unknown>,
    patterns: Set<string>
  ): boolean {
    if (patterns.size === 0) {
      return false;
    }

    // 1. 精确匹配（Bash/bash 语义归一）
    const normalizedToolName = normalizeToolName(toolName);
    for (const candidate of patterns) {
      if (sameToolName(candidate, normalizedToolName)) {
        return true;
      }
    }

    // 2. 通配符匹配（如 Bash(git:*)）
    for (const pattern of patterns) {
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
