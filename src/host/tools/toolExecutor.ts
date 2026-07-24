// ============================================================================
// Tool Executor - Executes tools with permission handling
// ============================================================================

import type { ToolContext, ToolExecutionResult, PermissionRequestData } from './types';
import * as nodePath from 'path';
import type { ToolDefinition } from '../../shared/contract';
import type { PermissionBoundaryId } from '../../shared/contract/permissionBoundary';
import { PermissionRequestReason } from '../../shared/contract/permission';
import { getToolCache } from '../services/infra/toolCache';
import { createLogger } from '../services/infra/logger';
import { getAuditLogger, maskSensitiveData, isKnownSafeCommand, validateCommand, getShellSafetyMode, getExecPolicyStore, getPolicyEnforcer, type PolicyEnforcer, type PolicyCheckResult, type ValidationResult } from '../security';
import { createFileCheckpointIfNeeded } from './middleware/fileCheckpointMiddleware';
import { getConfirmationGate } from '../agent/confirmationGate';
import { type ClassificationResult } from './permissionClassifier';
import type { SkillToolBoundary } from '../../shared/contract/agentSkill';
import type { NeoTagRunContext } from '../../shared/contract/tag';
import type { SwarmRunScope } from '../../shared/contract/swarm';
import { createTraceBuilder } from '../security/decisionTraceBuilder';
import { getWriteIsolationManager, getWriteIsolationScope, type WriteIsolationMetadata } from '../security/writeIsolation';
import type { HookManager } from '../hooks/hookManager';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import type { ConversationExecutionIntent, WorkbenchToolScope } from '../../shared/contract/conversationEnvelope';
import { isBashToolName, normalizeToolName } from './toolNames';
import { finalizeSurfaceAwareToolResult } from './artifacts/surfaceExecutionToolResultPipeline';
import { recordDecision } from './toolExecutorDecisionTrace';
import { checkNeoTagToolGuard } from './neoTagToolGuard';
import { type PermissionMode } from '../permissions/modes';
import {
  readOnlyDenialError,
  readOnlyForcesConfirmationFor,
  resolveSessionPermissionMode,
  resolveToolPermissionClassification,
} from './toolPermissionClassification';
import { isRunPathInsideWorkspace, resolveCanonicalRunPath, type RunContext } from '../runtime/runContext';
import { resolveWorkspacePath } from '../runtime/workspaceScope';
import { isDangerousCommand, sanitizeToolParams, toolMatchesPatternSet, truncateToolOutput } from './toolExecutorHelpers';
import { prepareNativeToolCheckpoint } from './nativeToolCheckpoint';
import { annotateToolExecution, requestPermissionWithTelemetry } from './toolExecutionTelemetry';
import { recordCachedToolReplay } from './cachedToolReplay';
import { createToolExecutionLedger } from './toolExecutionLedger';
import { type ExecutionTopology } from '../permissions';
import { boundaryIdForRequestType } from './permissionBoundaryMapping';
import { evaluateGuardFabricGate } from './guardFabricGate';
import { completeArtifactLocatorGuardedWrite } from './artifacts/artifactLocatorHost';

const logger = createLogger('ToolExecutor');

import { validateToolInputSchema, formatToolSchemaValidationError } from './toolSchemaValidator';

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
  /** Topology used by GuardFabric. Defaults to main for zero behavior change. */
  executionTopology?: ExecutionTopology;
  /**
   * 权限档覆盖：subagent 传父子收缩后的 effectiveMode，禁止回读父会话档
   * （否则父会话开 bypass 时被收缩的子 agent 会借会话档扩权）。主 agent 不传。
   */
  permissionModeOverride?: PermissionMode;
  /** Present only for immutable per-run executors. */
  runContext?: RunContext;
  /** Optional final dispatch hop. Returning null falls back to the protocol resolver. */
  dispatchTool?: ToolExecutionDelegate;
}

export type ToolExecutionDelegate = (toolName: string, params: Record<string, unknown>, context: ToolContext, options: ExecuteOptions) => Promise<ToolExecutionResult | null>;

/**
 * 工具执行选项
 * @internal
 */
export interface ExecuteOptions {
  /** Native Run identity only. Never substitute sessionId or Team runId. */
  runId?: string; turnId?: string;
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
  /** Per-call GuardFabric topology. Defaults to the executor topology, then main. */
  executionTopology?: ExecutionTopology;
  // 当前 agent 在 spawn 链路中的嵌套深度（主 agent = 0）。
  spawnDepth?: number;
  // 会话级 spawn 深度覆盖，执行层会 clamp 到硬上限。
  spawnMaxDepth?: number;
  // 根 agent / 根 session 的 spawn tree id，整棵树共享同一并发槽位池。
  spawnTreeId?: string;
  // Agent Team 的不可变 run/tree scope；嵌套工具调用必须原样透传。
  swarmRunScope?: SwarmRunScope;
  // 超额 spawn 等待 tree 槽位的超时时间。
  spawnQueueTimeoutMs?: number;
  // 父 agent 启动时间，用于按父剩余时间收紧子 agent 执行窗口。
  spawnParentStartedAt?: number;
  // 父 agent 执行超时时间，用于计算子 agent 可用剩余窗口。
  spawnParentTimeoutMs?: number;
  // 父 agent 当前剩余预算，作为子 agent 的预算上限。
  parentRemainingBudget?: number;
  // SpawnGuard tree parent id；不同于 agentId，后者用于工具隔离。
  spawnParentAgentId?: string;
  // goal loop 等受控循环内的后台子 agent 不主动唤醒 idle 父会话。
  suppressBackgroundSubagentIdleWake?: boolean;
  // 持久化角色 ID（agent 注册 id）。subagent 执行时由 subagentExecutor 灌入，
  // MemoryWrite/Read 的 scope='role' 路由按这个 id 定位 roles/<id>/ 目录。
  agentRole?: string;
  // Skill 系统支持：预授权工具列表（跳过权限确认）
  preApprovedTools?: Set<string>;
  // GAP-001: Skill allowed-tools 限权边界。设置后，边界外的工具调用强制用户审批
  //（不能被预授权/安全白名单/classifier 自动放行）。
  skillToolBoundary?: SkillToolBoundary;
  // Current message attachments for multi-agent workflows
  currentAttachments?: Array<{ type: string; category?: string; name?: string; path?: string; data?: string; mimeType?: string }>;
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
  // Approved Neo Tag work card runtime context.
  neoTag?: NeoTagRunContext;
  // Run-level cancellation signal propagated from the agent loop.
  abortSignal?: AbortSignal;
  // Subagent 执行策略 — 存在即表示这是 subagent 调用。
  // ToolExecutor 在权限决策前先过这道闸：工具白名单 + 收缩策略。
  // 策略只能收紧（deny），不能放宽：'deny' 直接拒，'ask' 继续走常规管道
  // （validateCommand / classifyPermission / exec policy / 审计 / cache）。
  // 这保证 subagent 与主 agent 走同一条 ToolExecutor 管道，而非绕过权限的旁路。
  subagentPolicy?: { allowedTools: Set<string>; check: (toolName: string, params: Record<string, unknown>) => 'deny' | 'ask' };
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
  private readonly runContext?: RunContext;
  private readonly dispatchTool?: ToolExecutionDelegate;
  private executionTopology: ExecutionTopology;
  private auditEnabled = true;
  private permissionModeOverride?: PermissionMode;

  constructor(config: ToolExecutorConfig) {
    this.requestPermission = config.requestPermission;
    this.workingDirectory = nodePath.resolve(config.workingDirectory);
    this.permissionModeOverride = config.permissionModeOverride;
    this.runContext = config.runContext;
    this.dispatchTool = config.dispatchTool;
    this.executionTopology = config.executionTopology ?? 'main';
    if (this.runContext && this.workingDirectory !== this.runContext.cwd) {
      throw new Error(
        `Run-scoped ToolExecutor cwd mismatch for ${this.runContext.runId}: ${this.workingDirectory}`,
      );
    }
  }

  /** 事后标注拓扑（cron 等构造时不知拓扑的路径用）；须在首次执行/forRun 派生前调用。 */
  setExecutionTopology(topology: ExecutionTopology): void {
    this.executionTopology = topology;
  }

  /** Create an executor whose workspace/cwd cannot be changed after construction. */
  forRun(runContext: RunContext, dispatchTool?: ToolExecutionDelegate): ToolExecutor {
    const executor = new ToolExecutor({
      requestPermission: this.requestPermission,
      workingDirectory: runContext.cwd,
      // run-scoped 派生必须继承收缩档，否则子 agent 的 effectiveMode 在此丢失、扩权洞重开
      permissionModeOverride: this.permissionModeOverride,
      executionTopology: this.executionTopology,
      runContext,
      dispatchTool: dispatchTool ?? this.dispatchTool,
    });
    executor.setAuditEnabled(this.auditEnabled);
    return executor;
  }

  getRunContext(): RunContext | undefined {
    return this.runContext;
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
    if (this.runContext) {
      throw new Error(`Run-scoped ToolExecutor workspace is immutable: ${this.runContext.runId}`);
    }
    this.workingDirectory = nodePath.resolve(path);
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
    rawParams: Record<string, unknown>,
    options: ExecuteOptions
  ): Promise<ToolExecutionResult> {
    if (this.runContext && options.runId && options.runId !== this.runContext.runId) {
      return {
        success: false,
        error: `Run context mismatch: expected ${this.runContext.runId}, received ${options.runId}`,
        metadata: { code: 'RUN_CONTEXT_MISMATCH' },
      };
    }
    if (this.runContext && options.sessionId && options.sessionId !== this.runContext.sessionId) {
      return {
        success: false,
        error: `Run session mismatch: expected ${this.runContext.sessionId}, received ${options.sessionId}`,
        metadata: { code: 'RUN_CONTEXT_MISMATCH' },
      };
    }
    const effectiveRunId = this.runContext?.runId ?? options.runId;
    const effectiveSessionId = this.runContext?.sessionId ?? options.sessionId;
    const parentNativeRunId = options.swarmRunScope?.parentNativeRunId;
    if (parentNativeRunId && parentNativeRunId !== effectiveRunId) {
      return {
        success: false,
        error: `Agent Team parent run mismatch: expected ${parentNativeRunId}, received ${effectiveRunId ?? 'none'}`,
        metadata: { code: 'RUN_CONTEXT_MISMATCH' },
      };
    }
    const requestedToolName = toolName;
    const normalizedRequestedToolName = normalizeToolName(requestedToolName);
    const boundParams = this.bindRunScopedParams(normalizedRequestedToolName, rawParams);
    if ('error' in boundParams) {
      return {
        success: false,
        error: boundParams.error,
        metadata: { code: 'RUN_WORKSPACE_BOUNDARY' },
      };
    }
    const params = boundParams.params;
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

    if (this.runContext && toolDef.permissionLevel === 'write' && !isBashToolName(policyToolName)) {
      const rawTarget = [
        params.file_path,
        params.path,
        params.output_path,
        params.outputPath,
        params.notebook_path,
        params.document_path,
        params.presentation_path,
      ].find((value) => typeof value === 'string' && value.trim()) as string | undefined;
      const target = rawTarget
        ? (nodePath.isAbsolute(rawTarget)
          ? nodePath.resolve(rawTarget)
          : nodePath.resolve(this.executionCwd, rawTarget))
        : this.executionCwd;
      const readableMatch = resolveWorkspacePath(this.runContext.workspaceScope, target, 'read');
      if (readableMatch && readableMatch.root.access !== 'read_write') {
        return {
          success: false,
          error: `Project Source is read-only: ${readableMatch.root.path}`,
          metadata: {
            code: 'PROJECT_SOURCE_READ_ONLY',
            projectId: this.runContext.workspaceScope.projectId,
            sourceId: readableMatch.root.sourceId,
            sourceRole: readableMatch.root.role,
            sourceAccess: readableMatch.root.access,
            relativePathWithinSource: readableMatch.relativePath,
            workspaceScopeVersion: this.runContext.workspaceScope.version,
          },
        };
      }
    }

    annotateToolExecution({
      toolCallId: options.currentToolCallId,
      toolName: executionToolName,
      permissionClass: toolDef.permissionLevel,
      runId: effectiveRunId,
      bridged: Boolean(this.dispatchTool),
    });

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

    // Executor-level schema guardrail: direct ToolExecutor callers may bypass the
    // agent runtime's lighter validator, so keep this fail-closed before permission/dispatch.
    const schemaIssues = validateToolInputSchema(toolDef.inputSchema, params);
    if (schemaIssues.length > 0) {
      logger.warn('Tool call failed schema validation', { toolName: executionToolName, requestedToolName, issues: schemaIssues });
      return {
        success: false,
        error: formatToolSchemaValidationError(executionToolName, schemaIssues),
      };
    }

    const permStartTime = Date.now();
    const executionTopology = options.executionTopology ?? this.executionTopology;
    let guardFabricForcesApproval = false;
    let guardFabricTraceStep: import('../../shared/contract/decisionTrace').DecisionStep | undefined;
    const guardFabricGate = evaluateGuardFabricGate({
      executionToolName,
      policyToolName,
      params,
      topology: executionTopology,
      sessionId: effectiveSessionId,
      agentId: options.agentId,
    });
    if (guardFabricGate.deny) {
      recordDecision(
        executionToolName,
        params,
        'policy-deny',
        guardFabricGate.deny.reason,
        permStartTime,
        guardFabricGate.deny.trace,
      );
      return {
        success: false,
        error: guardFabricGate.deny.error,
      };
    }
    if (guardFabricGate.forceApproval) {
      guardFabricForcesApproval = true;
      guardFabricTraceStep = guardFabricGate.traceStep;
    }

    // Create tool context
    const context: ToolContext & { sessionId?: string } = {
      runId: effectiveRunId, turnId: options.turnId,
      sessionId: effectiveSessionId,
      workspace: this.workspaceRoot,
      workspaceScope: this.runContext?.workspaceScope,
      workingDirectory: this.executionCwd,
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
      // Per-agent BrowserPool / ComputerSurface isolation
      agentId: options.agentId,
      spawnDepth: options.spawnDepth,
      spawnMaxDepth: options.spawnMaxDepth,
      spawnTreeId: options.spawnTreeId,
      swarmRunScope: options.swarmRunScope,
      spawnQueueTimeoutMs: options.spawnQueueTimeoutMs,
      spawnParentStartedAt: options.spawnParentStartedAt,
      spawnParentTimeoutMs: options.spawnParentTimeoutMs,
      parentRemainingBudget: options.parentRemainingBudget,
      spawnParentAgentId: options.spawnParentAgentId,
      suppressBackgroundSubagentIdleWake: options.suppressBackgroundSubagentIdleWake,
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
      neoTag: options.neoTag,
    };

    if (options.neoTag) {
      const neoTagGuard = checkNeoTagToolGuard(executionToolName, params);
      if (!neoTagGuard.allowed) {
        logger.warn('Blocked by Neo Tag safety guard', {
          toolName: executionToolName,
          reason: neoTagGuard.reason,
          workCardId: options.neoTag.workCardId,
          runId: options.neoTag.runId,
        });
        recordDecision(executionToolName, params, 'policy-deny', neoTagGuard.reason, permStartTime);
        return {
          success: false,
          error: neoTagGuard.reason,
        };
      }
    }

    // Security: Pre-execution validation for bash commands
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
            sessionId: effectiveSessionId || 'unknown',
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
          effectiveSessionId || 'unknown',
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
    const policyEnforcer = getPolicyEnforcer(resolveCanonicalRunPath(this.workspaceRoot));
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
            sessionId: effectiveSessionId || 'unknown',
            toolName: executionToolName,
            incident: `Blocked by policy: ${policyCheck.reason}`,
            details: { section: policyCheck.section },
            riskLevel: 'critical',
          });
        }

        // Fire-and-forget: emit PermissionDenied hook
        options.hookManager?.triggerPermissionDenied(
          executionToolName, policyCheck.reason || 'security policy', 'policy',
          effectiveSessionId || 'unknown',
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
      && !toolMatchesPatternSet(executionToolName, params, new Set(options.skillToolBoundary.allowedTools))
      ? options.skillToolBoundary
      : undefined;

    // B1 第 4 档「只读探索」判定：语义与档位改写规则集中在 toolPermissionClassification.ts
    const sessionPermissionMode = resolveSessionPermissionMode(this.permissionModeOverride, options.sessionId);
    const readOnlyForcesConfirmation = readOnlyForcesConfirmationFor(sessionPermissionMode, toolDef);

    // Check permission if required
    // Skill 系统：预授权工具跳过权限检查（但不能跳过边界违规检查）
    const isPreApproved = !boundaryViolation
      && !guardFabricForcesApproval
      && options.preApprovedTools !== undefined
      && options.preApprovedTools.size > 0
      && toolMatchesPatternSet(executionToolName, params, options.preApprovedTools);
    if (isPreApproved) {
      logger.debug('Tool pre-approved by Skill system, skipping permission check', { toolName: executionToolName });
      recordDecision(executionToolName, params, 'auto-approve', 'pre-approved', permStartTime);
    }

    // P0: 安全命令白名单 + exec policy — 已知安全命令跳过审批
    let isSafeCommand = false;
    if (isBashToolName(policyToolName) && params.command && !isPreApproved && !guardFabricForcesApproval) {
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

    if (toolDef.requiresPermission && (guardFabricForcesApproval || policyForcesConfirmation || boundaryViolation || readOnlyForcesConfirmation || (!isPreApproved && !isSafeCommand))) {
      // P1: Auto-approve classifier — 规则+LLM 自动判断安全性
      let needsUserApproval = true;
      // Lazy trace: only created when needed (deny/ask path)
      const traceBuilder = createTraceBuilder(executionToolName);
      if (guardFabricTraceStep) {
        traceBuilder.addStep(
          guardFabricTraceStep.layer,
          guardFabricTraceStep.rule,
          guardFabricTraceStep.result,
          guardFabricTraceStep.reason,
        );
      }
      if (!guardFabricForcesApproval) {
        try {
          // 三分支解析 + readOnly/档位改写规则见 toolPermissionClassification.ts
          const classification: ClassificationResult = await resolveToolPermissionClassification({
            executionToolName,
            policyToolName,
            params,
            policyForcesConfirmation,
            boundaryViolation,
            workingDirectory: resolveCanonicalRunPath(this.executionCwd),
            workspaceRoot: resolveCanonicalRunPath(this.workspaceRoot),
            permissionLevel: toolDef.permissionLevel,
            permStartTime,
            readOnlyForcesConfirmation,
            sessionPermissionMode,
          });
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
              effectiveSessionId || 'unknown',
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
      }

      if (needsUserApproval) {
      const permissionRequest = this.buildPermissionRequest(toolDef, params);
      permissionRequest.sessionId = effectiveSessionId;

      // B1 readOnly（审出 HIGH）：最终审批层的自动放行捷径（agentOrchestrator 的
      // devModeAutoApprove / autoApprove[level]、renderer PermissionCard 的
      // always/session 权限记忆）全部对 forceConfirm 让路——只读探索档下
      // 写入/执行必须逐次真人确认，且不写入/不消费权限记忆。
      if (readOnlyForcesConfirmation || guardFabricForcesApproval) {
        permissionRequest.forceConfirm = true;
      }

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
          effectiveSessionId || 'global'
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
            effectiveSessionId || 'unknown',
            permissionRequest.reason,
          );
          if (!hookResult.shouldProceed) {
            // Fire-and-forget: emit PermissionDenied hook
            options.hookManager?.triggerPermissionDenied(
              executionToolName, hookResult.message || 'blocked', 'hook',
              effectiveSessionId || 'unknown',
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

      const approved = await requestPermissionWithTelemetry({
        request: permissionRequest,
        toolCallId: options.currentToolCallId,
        requestPermission: this.requestPermission,
      });

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
            sessionId: effectiveSessionId || 'unknown',
            toolName: executionToolName,
            input: sanitizeToolParams(params),
            duration: 0,
            success: false,
            error: 'Permission denied by user',
          });
        }
        // Fire-and-forget: emit PermissionDenied hook
        options.hookManager?.triggerPermissionDenied(
          executionToolName, 'Permission denied by user', 'user',
          effectiveSessionId || 'unknown',
        ).catch(() => {});
        recordDecision(executionToolName, params, 'ask-denied', 'user', permStartTime);

        // 只读探索档（审出 MED）：无审批 UI 的运行环境（web 聊天 /api/agent/run 走
        // CLI 非交互 handler、CLI run/batch）对 forceConfirm 请求自动拒绝（fail-closed）。
        // 泛用的 "Permission denied by user" 在该路径是误导——给模型可转述的真实原因与出路。
        return {
          success: false,
          error: readOnlyForcesConfirmation ? readOnlyDenialError(executionToolName) : 'Permission denied by user',
        };
      }
      } // end needsUserApproval
    }

    const toolCache = getToolCache();
    const toolCacheScope = {
      sessionId: effectiveSessionId,
      workingDirectory: this.workspaceRoot,
    };
    const canUseToolCache = toolCache.isCacheable(executionToolName);

    // Check cache for cacheable tools
    if (canUseToolCache) {
      const cached = toolCache.get(executionToolName, params, toolCacheScope);
      if (cached) {
        logger.debug('Cache HIT', { toolName: executionToolName });
        recordCachedToolReplay({
          cached,
          params,
          toolName: executionToolName,
          sessionId: effectiveSessionId,
          toolCallId: options.currentToolCallId,
          auditEnabled: this.auditEnabled,
        });
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
      this.workspaceRoot,
      toolDef.permissionLevel,
      this.executionCwd,
    );
    let releaseWriteIsolation: (() => void) | undefined;
    let writeIsolationMetadata: WriteIsolationMetadata | undefined;
    const startTime = Date.now();

    // ADR-022 第二期 · 崩溃重放：工具放行后即将真正执行，落 begin 生命周期事件；
    // 执行返回/抛错时落 complete。崩溃发生在两者之间 → 留下未闭合 begin = 现场。全程 fail-safe。
    const executionLedger = createToolExecutionLedger({
      toolName: executionToolName,
      sessionId: effectiveSessionId,
      params,
      startedAt: startTime,
    });
    const { executionId } = executionLedger;
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
        if (!effectiveSessionId) return null;
        // messageId 从 context 中获取，如果没有则使用工具调用 ID
        const messageId = options.currentToolCallId || `msg_${Date.now()}`;
        return { sessionId: effectiveSessionId, messageId };
      }, this.executionCwd);

      // Execute the tool via protocol resolver
      context.approvedToolCall = {
        toolName: executionToolName,
        args: params,
      };
      logger.debug('Dispatching to protocol resolver', { toolName: executionToolName, requestedToolName });
      executionLedger.begin();
      const durableCheckpoint = await prepareNativeToolCheckpoint({
        runId: effectiveRunId,
        sessionId: effectiveSessionId,
        toolName: executionToolName,
        toolDefinition: toolDef,
        toolCallId: options.currentToolCallId,
        executionId,
        startedAt: startTime,
      });
      const delegatedResult = this.dispatchTool
        ? await this.dispatchTool(executionToolName, params, context, options)
        : null;
      const rawResult = delegatedResult
        ?? await resolver.execute(executionToolName, params, context);
      const resultWithSurfaceProjection = await finalizeSurfaceAwareToolResult({
        toolName: executionToolName,
        arguments: params,
        result: rawResult,
        workingDirectory: this.workspaceRoot,
        conversationId: effectiveSessionId, runId: effectiveRunId, turnId: options.turnId, agentId: options.agentId,
        toolCallId: options.currentToolCallId || executionId, startedAt: startTime,
      });
      const result = writeIsolationMetadata
        ? {
          ...resultWithSurfaceProjection,
          metadata: {
            ...(resultWithSurfaceProjection.metadata ?? {}),
            writeIsolation: writeIsolationMetadata,
          },
        }
        : resultWithSurfaceProjection;
      const duration = Date.now() - startTime;

      logger.debug('Tool result', { toolName: executionToolName, success: result.success, error: result.error });

      await completeArtifactLocatorGuardedWrite({
        success: result.success,
        toolName: executionToolName,
        arguments: params,
        workingDirectory: this.executionCwd,
        sessionId: effectiveSessionId,
        agentId: options.agentId,
        toolCallId: options.currentToolCallId,
      });

      if (result.success && writeIsolationScope) {
        if (writeIsolationScope.kind === 'file') {
          toolCache.invalidateForPath(writeIsolationScope.targetPath, toolCacheScope);
        } else {
          toolCache.invalidateForWorkspace(toolCacheScope);
        }
      }

      // Cache successful results for cacheable tools
      if (result.success && canUseToolCache && result.result !== undefined) {
        toolCache.set(
          executionToolName,
          params,
          result.result as import('../../shared/contract').ToolResult,
          toolCacheScope,
        );
        logger.debug('Cached result', { toolName: executionToolName });
      }

      // Audit logging
      if (this.auditEnabled) {
        const auditLogger = getAuditLogger();
        auditLogger.logToolUsage({
          sessionId: effectiveSessionId || 'unknown',
          toolName: executionToolName,
          input: sanitizeToolParams(params),
          output: result.result ? truncateToolOutput(String(result.result)) : undefined,
          duration,
          success: result.success,
          error: result.error,
          securityFlags: commandValidation?.securityFlags,
          riskLevel: commandValidation?.riskLevel,
        });
      }

      executionLedger.complete(result.success ? 'success' : 'error', result.error);
      await durableCheckpoint.complete(result.success);
      return result;
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error('Tool threw error', error, { toolName: executionToolName });
      executionLedger.complete('error', error instanceof Error ? error.message : 'Unknown error');

      // Audit logging for errors
      if (this.auditEnabled) {
        const auditLogger = getAuditLogger();
        auditLogger.logToolUsage({
          sessionId: effectiveSessionId || 'unknown',
          toolName: executionToolName,
          input: sanitizeToolParams(params),
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

  private buildPermissionRequest(
    tool: ToolDefinition,
    params: Record<string, unknown>
  ): PermissionRequestData {
    switch (tool.name) {
      case 'bash':
      case 'Bash':
        return {
          type: isDangerousCommand(params.command as string)
            ? 'dangerous_command'
            : 'command',
          tool: tool.name,
          details: { command: params.command },
          reason: 'Execute shell command',
          reasonCode: PermissionRequestReason.ShellHighRisk,
          boundary: {
            id: 'command.shell',
            reason: '本次命令会在当前工作区的 shell 环境执行。',
          },
        };

      case 'read_file':
      case 'Read':
        return {
          type: 'file_read',
          tool: tool.name,
          details: { path: params.file_path },
          boundary: {
            id: this.getFileBoundaryId(params.file_path, false),
            reason: '读取文件内容用于完成当前任务。',
          },
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
          reasonCode: this.fileWriteReasonCode(params.file_path),
          boundary: {
            id: this.getFileBoundaryId(params.file_path, true),
            reason: '写入文件内容会修改目标路径。',
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
          reasonCode: this.fileWriteReasonCode(params.file_path),
          boundary: {
            id: this.getFileBoundaryId(params.file_path, true),
            reason: '追加内容会修改目标路径。',
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
          reasonCode: this.fileWriteReasonCode(params.file_path),
          boundary: {
            id: this.getFileBoundaryId(params.file_path, true),
            reason: '编辑操作会修改目标文件内容。',
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
          reasonCode: PermissionRequestReason.NetworkEgress,
          boundary: {
            id: 'network.web_request',
            reason: '本次工具会访问外部网络资源。',
          },
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
            toolName: params.tool,
            uri: params.uri,
          },
          reason: `调用 MCP 服务器 ${params.server}`,
          reasonCode: PermissionRequestReason.McpTool,
          boundary: {
            id: 'mcp.server_tool',
            reason: `调用 MCP 服务器 ${params.server}`,
          },
        };

      default: {
        // Map permission level to permission request type
        const typeMap: Record<string, PermissionRequestData['type']> = {
          read: 'file_read',
          write: 'file_write',
          execute: 'command',
          network: 'network',
        };
        const requestType = typeMap[tool.permissionLevel] || 'file_read';
        return {
          type: requestType,
          tool: tool.name,
          details: { ...params },
          reasonCode: PermissionRequestReason.Unknown,
          boundary: {
            id: boundaryIdForRequestType(requestType),
            reason: '根据工具权限级别推断的数据边界。',
          },
        };
      }
    }
  }

  /**
   * 写文件类操作的结构化原因码：仅当目标在工作区之外时归类为 FileWriteOutsideWorkspace，
   * 工作区内写入返回 undefined（boundary 文案已足够，避免误标“工作区外”）。
   */
  private fileWriteReasonCode(rawPath: unknown): PermissionRequestReason | undefined {
    return this.getFileBoundaryId(rawPath, true) === 'file.external_write'
      ? PermissionRequestReason.FileWriteOutsideWorkspace
      : undefined;
  }

  private getFileBoundaryId(rawPath: unknown, isWrite: boolean): PermissionBoundaryId {
    const filePath = typeof rawPath === 'string' ? rawPath : '';
    if (!filePath) return isWrite ? 'file.project_write' : 'file.project_read';

    const workspace = this.workspaceRoot;
    const resolvedPath = nodePath.isAbsolute(filePath)
      ? nodePath.resolve(filePath)
      : nodePath.resolve(this.executionCwd, filePath);
    const match = this.runContext
      ? resolveWorkspacePath(this.runContext.workspaceScope, resolvedPath, isWrite ? 'read_write' : 'read')
      : undefined;
    const inWorkspace = this.runContext
      ? Boolean(match)
      : isRunPathInsideWorkspace(resolvedPath, workspace);

    if (inWorkspace) return isWrite ? 'file.project_write' : 'file.project_read';
    return isWrite ? 'file.external_write' : 'file.external_read';
  }

  private get executionCwd(): string {
    return this.runContext?.cwd ?? this.workingDirectory;
  }

  private get workspaceRoot(): string {
    return this.runContext?.workspace ?? this.workingDirectory;
  }

  private bindRunScopedParams(
    toolName: string,
    params: Record<string, unknown>,
  ): { params: Record<string, unknown> } | { error: string } {
    if (!this.runContext || !isBashToolName(toolName)) {
      return { params };
    }

    const requestedDirectory = params.working_directory;
    if (typeof requestedDirectory !== 'string' || !requestedDirectory.trim()) {
      return { params };
    }

    const candidate = nodePath.isAbsolute(requestedDirectory)
      ? nodePath.resolve(requestedDirectory)
      : nodePath.resolve(this.executionCwd, requestedDirectory);
    if (!resolveWorkspacePath(this.runContext.workspaceScope, candidate, 'read')) {
      return {
        error: `Run ${this.runContext.runId} cannot execute outside Project Sources: ${candidate}`,
      };
    }

    return {
      params: {
        ...params,
        working_directory: candidate,
      },
    };
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
      const unresolvedPolicyPath = nodePath.isAbsolute(filePath) || filePath === '~' || filePath.startsWith('~/')
        ? filePath
        : nodePath.resolve(this.executionCwd, filePath);
      const policyPath = filePath === '~' || filePath.startsWith('~/')
        ? filePath
        : resolveCanonicalRunPath(unresolvedPolicyPath);
      const fileCheck = enforcer.checkFilePath(policyPath, toolDef.permissionLevel);
      if (!fileCheck.allowed) return fileCheck;
    }

    // 4. 网络域名白名单
    if (toolDef.permissionLevel === 'network' && typeof params.url === 'string') {
      const networkCheck = enforcer.checkNetwork(params.url);
      if (!networkCheck.allowed) return networkCheck;
    }

    return { allowed: true };
  }

}
