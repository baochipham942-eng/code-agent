// ============================================================================
// Tool Executor - Executes tools with permission handling
// ============================================================================

import type { ToolContext, ToolExecutionResult, PermissionRequestData } from './types';
import * as nodePath from 'path';
import * as nodeFs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { AgentFailureCode, type ToolDefinition } from '../../shared/contract';
import type { PermissionBoundaryId } from '../../shared/contract/permissionBoundary';
import {
  createHostReason,
  hostReasonModelText,
  HostReasonCode,
  PermissionRequestReason,
} from '../../shared/contract/permission';
import { getToolCache } from '../services/infra/toolCache';
import { getSessionAutomationService } from '../services/sessionAutomation/sessionAutomationService';
import { createLogger } from '../services/infra/logger';
import { getAuditLogger, maskSensitiveData, isKnownSafeCommand, validateCommand, getShellSafetyMode, getExecPolicyStore, getPolicyEnforcer, type PolicyEnforcer, type PolicyCheckResult, type ValidationResult } from '../security';
import { createFileCheckpointIfNeeded } from './middleware/fileCheckpointMiddleware';
import { getFileCheckpointService } from '../services/checkpoint';
import { getConfirmationGate } from '../agent/confirmationGate';
import {
  bashCommandRequiresPermission,
  readArgumentsRequirePermission,
  recursiveRmIsContainedInWorkspace,
  type ClassificationResult,
} from './permissionClassifier';
import type { SkillToolBoundary } from '../../shared/contract/agentSkill';
import type { NeoTagRunContext } from '../../shared/contract/tag';
import type { SwarmRunScope } from '../../shared/contract/swarm';
import { createTraceBuilder } from '../security/decisionTraceBuilder';
import { getWriteIsolationManager, getWriteIsolationScope, type WriteIsolationMetadata } from '../security/writeIsolation';
import type { HookManager } from '../hooks/hookManager';
import { getToolResolver } from '../tools/dispatch/toolResolver';
import type { ConversationExecutionIntent, WorkbenchToolScope } from '../../shared/contract/conversationEnvelope';
import { isBashToolName, normalizeToolName } from './toolNames';
import { isToolDeniedByRunPolicy } from './runToolPolicy';
import { finalizeSurfaceAwareToolResult } from './artifacts/surfaceExecutionToolResultPipeline';
import { recordDecision } from './toolExecutorDecisionTrace';
import { checkNeoTagToolGuard } from './neoTagToolGuard';
import type { PermissionMode } from '../permissions/modes';
import {
  browserComputerConsequenceForcesClassification,
  CLASSIFIER_ERROR_TRACE_RULE,
  INJECTED_PERMISSION_HANDLER_TRACE_RULE,
  commandAnalysisDenialError,
  permissionDenialError,
  readOnlyDenialError,
  readOnlyForcesConfirmationFor,
  resolveSessionPermissionMode,
  resolveToolPermissionClassification,
} from './toolPermissionClassification';
import { getPermissionModeManager } from '../permissions/modes';
import { normalizePermissionAskResult, type RequestPermissionResult } from '../../shared/contract/permission';
import { applyEditedArgs } from '../../shared/contract/permissionEdit';
import { EXTERNAL_SIDE_EFFECT_TRACE_RULE, EXTERNAL_SIDE_EFFECT_TRACE_REASON, isExternalSideEffectTool, extractStandingGrantTarget } from './externalSideEffect';
import { isRunPathInsideWorkspace, resolveCanonicalRunPath, type RunContext } from '../runtime/runContext';
import { resolveBackgroundWorkspaceAuthority } from '../runtime/workspaceAuthority';
import { resolveWorkspacePath } from '../runtime/workspaceScope';
import { isDangerousCommand, sanitizeToolParams, toolMatchesPatternSet, truncateToolOutput } from './toolExecutorHelpers';
import { prepareNativeToolCheckpoint } from './nativeToolCheckpoint';
import { annotateToolExecution, getApprovalWaitMs, reportUndeclaredToolParams, requestPermissionWithTelemetry } from './toolExecutionTelemetry';
import type { ToolLedgerOrigin } from '../../shared/constants/toolLedger';
import { recordCachedToolReplay } from './cachedToolReplay';
import { createToolExecutionLedger } from './toolExecutionLedger';
import { classifyToolReplaySafety } from './toolReplaySafety';
import { type ExecutionTopology } from '../permissions';
import { boundaryIdForRequestType } from './permissionBoundaryMapping';
import {
  connectorExternalWriteReason,
  findConnectorToolMetadata,
} from '../../shared/contract/workbenchTools';
import { evaluateGuardFabricGate } from './guardFabricGate';
import { classifyShellDesktopAutomation } from '../permissions/shellDesktopAutomation';
import { completeArtifactLocatorGuardedWrite } from './artifacts/artifactLocatorHost';
import { ensureFailedToolResultError } from './toolResultError';
import { probeHeadlessPermission, requestDirectiveMemoryConfirmation } from '../memory/directiveMemoryConfirmation';
import {
  DIRECTIVE_MEMORY_HEADLESS_NO_UI_ERROR,
  directiveMemoryConfirmationFailureError,
} from '../memory/directiveMemoryMessages';
import { hasInteractiveUi } from '../platform/windowBridge';
import { getMemoryDir } from '../lightMemory/indexLoader';
import {
  assessDirectiveMemoryWrite,
  createDirectiveMemoryWriteGrant,
} from '../memory/directiveMemoryPathAuthority';
import { resolveToolWriteTargets } from './writeTargets';
import {
  createFileOwnershipActor,
  getFileOwnershipRegistry,
} from '../services/infra/fileOwnershipRegistry';
import { getResourceLockManager } from '../services/infra/resourceLockManager';
import { fileReadTracker } from './fileReadTracker';
import { checkExternalModification } from './utils/externalModificationDetector';
import { getFileMutationActorId } from './modules/file/fileMutationIdentity';
import {
  createChildRunTraceContext,
  getActiveRunTraceContext,
  withRunTraceContext,
} from '../telemetry/runTraceContext';
import type { TurnTraceRecorder } from '../agent/runtime/turnTrace';
import type { SkillDiscoveryService } from '../services/skills/skillDiscoveryService';
import type { TelemetryCollector } from '../telemetry/telemetryCollector';

const logger = createLogger('ToolExecutor');
const FILE_MUTATION_LOCK_HOLD_TIMEOUT_MS = 60_000;
const FILE_MUTATION_LOCK_WAIT_TIMEOUT_MS = 10_000;

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await nodeFs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

const DELETE_FLAG_PREFIXES = ['recursive_delete', 'root_delete', 'home_delete', 'system_dir_delete', 'container_dir_delete', 'wildcard_delete', 'current_dir_delete', 'sudo_rm'];
const COMMAND_FILE_COUNT_LIMIT = 10_000;

function extractDeleteTarget(command: string, securityFlags: string[]): string | undefined {
  if (!securityFlags.some((flag) => DELETE_FLAG_PREFIXES.some((prefix) => flag.startsWith(prefix)))) return undefined;
  const match = command.match(/(?:^|[;&|]\s*)rm\s+(?:(?:-[^\s]+|--[^\s]+)\s+)*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/u);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

async function countAffectedFiles(targetPath: string): Promise<number | undefined> {
  try {
    const root = await nodeFs.lstat(targetPath);
    if (!root.isDirectory()) return 1;
    let count = 0;
    const pending = [targetPath];
    while (pending.length > 0 && count < COMMAND_FILE_COUNT_LIMIT) {
      const directory = pending.pop();
      if (!directory) break;
      const entries = await nodeFs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory() && !entry.isSymbolicLink()) pending.push(nodePath.join(directory, entry.name));
        else count += 1;
        if (count >= COMMAND_FILE_COUNT_LIMIT) break;
      }
    }
    return count;
  } catch {
    return undefined;
  }
}

import { validateToolInputSchema, formatToolSchemaValidationError, stripUndeclaredToolParams } from './toolSchemaValidator';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------

/**
 * Tool Executor 配置
 * @internal
 */
export interface ToolExecutorConfig {
  /**
   * 审批处理器。返回裸 boolean 仍然合法（false 等价「真人拒绝」）；返回
   * `PermissionAskResult` 时必须自报 `denialSource`——账本与给模型的文案都靠它区分
   * 「人拒的」与「机器拒的」（见 `PermissionDenialSource`）。
   */
  requestPermission: (request: PermissionRequestData) => Promise<RequestPermissionResult>;
  /** Route every permissioned tool through requestPermission, bypassing auto-approve shortcuts. */
  forcePermissionHandler?: boolean;
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
  /** 账本来源由所有构造入口显式声明。 */
  ledgerOrigin?: ToolLedgerOrigin;
  /** Run-scoped telemetry owner propagated through subagent tools. */
  telemetryCollector?: TelemetryCollector;
}

export type ToolExecutionDelegate = (toolName: string, params: Record<string, unknown>, context: ToolContext, options: ExecuteOptions) => Promise<ToolExecutionResult | null>;

/**
 * 工具执行选项
 * @internal
 */
export interface ExecuteOptions {
  /** Native Run identity only. Never substitute sessionId or Team runId. */
  runId?: string; turnId?: string;
  /** Stable user message that originated this native turn. */
  sourceMessageId?: string;
  /** 当前 agent run 的 JSONL trace；补偿登记必须与所属 turn 同账。 */
  turnTrace?: TurnTraceRecorder;
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
  // Run-level tool denylist. Dynamic discovery must inherit the same boundary.
  deniedToolNames?: readonly string[];
  // Run-level tool allowlist（CLI --tools 等）。非空 = 精确白名单：名单外工具
  // 在执行层同样硬拒（schema 面过滤之外的兜底闸，覆盖嵌套/直接 executor 调用）。
  allowedToolNames?: readonly string[];
  skillDiscoveryService?: SkillDiscoveryService;
  // 内部标记：本次调用由 ctx.executeTool 发起（PTC 脚本里的一次 tools.X()）。
  // 唯一作用是不给嵌套出来的 context 再签发 executeTool —— 一层封顶，防递归。
  nestedToolCall?: boolean;
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
  private requestPermission: (request: PermissionRequestData) => Promise<RequestPermissionResult>;
  /**
   * ToolContext 侧的窄契约：工具内联审批只关心放行与否。富返回值只在本文件的权限闸内
   * 消费——若把富对象直接交给 `if (!approved)` 那类调用点，`{approved:false}` 恒真会变成
   * **静默 fail-open**。这一层归一化就是为了让那种事不可能发生。
   */
  private readonly requestPermissionForTools: (request: PermissionRequestData) => Promise<boolean>;
  private workingDirectory: string;
  private readonly runContext?: RunContext;
  private readonly dispatchTool?: ToolExecutionDelegate;
  private executionTopology: ExecutionTopology;
  private auditEnabled = true;
  private permissionModeOverride?: PermissionMode;
  private readonly forcePermissionHandler: boolean;
  private readonly ledgerOrigin: ToolLedgerOrigin;
  private readonly telemetryCollector?: TelemetryCollector;

  constructor(config: ToolExecutorConfig) {
    this.requestPermission = config.requestPermission;
    this.requestPermissionForTools = async (request) => normalizePermissionAskResult(
      await this.requestPermission(request),
    ).approved;
    this.workingDirectory = nodePath.resolve(config.workingDirectory);
    this.permissionModeOverride = config.permissionModeOverride;
    this.forcePermissionHandler = config.forcePermissionHandler === true;
    this.runContext = config.runContext;
    this.dispatchTool = config.dispatchTool;
    this.executionTopology = config.executionTopology ?? 'main';
    this.ledgerOrigin = config.ledgerOrigin ?? 'desktop';
    this.telemetryCollector = config.telemetryCollector;
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

  /** 当前执行拓扑。requestPermission 用它判断无人值守场景下能否免审批放行只读 MCP 工具。 */
  getExecutionTopology(): ExecutionTopology {
    return this.executionTopology;
  }

  /** 旁路账本沿用工具执行入口已声明的来源，避免再从用户文本猜测试会话。 */
  getLedgerOrigin(): ToolLedgerOrigin {
    return this.ledgerOrigin;
  }

  /** Create an executor whose workspace/cwd cannot be changed after construction. */
  forRun(
    runContext: RunContext,
    dispatchTool?: ToolExecutionDelegate,
    requestPermission?: ToolExecutorConfig['requestPermission'],
    forcePermissionHandler = false,
  ): ToolExecutor {
    const executor = new ToolExecutor({
      requestPermission: requestPermission ?? this.requestPermission,
      forcePermissionHandler: forcePermissionHandler || this.forcePermissionHandler,
      workingDirectory: runContext.cwd,
      // run-scoped 派生必须继承收缩档，否则子 agent 的 effectiveMode 在此丢失、扩权洞重开
      permissionModeOverride: this.permissionModeOverride,
      executionTopology: this.executionTopology,
      runContext,
      dispatchTool: dispatchTool ?? this.dispatchTool,
      ledgerOrigin: this.ledgerOrigin,
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
    const active = getActiveRunTraceContext();
    if (!active) {
      return this.executeInCorrelationContext(toolName, rawParams, options);
    }
    const toolTraceContext = createChildRunTraceContext(active, {
      turnId: options.turnId?.trim() || active.turnId,
      toolCallId: options.currentToolCallId?.trim() || null,
    });
    return withRunTraceContext(
      toolTraceContext,
      () => this.executeInCorrelationContext(toolName, rawParams, options),
    );
  }

  private async executeInCorrelationContext(
    toolName: string,
    rawParams: Record<string, unknown>,
    options: ExecuteOptions,
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
    let params = boundParams.params;
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
    const writeWithoutWorkspaceAuthority = Boolean(
      this.runContext
      && !this.runContext.workspaceScope
      && toolDef.permissionLevel === 'write',
    );

    if (this.runContext?.workspaceScope && toolDef.permissionLevel === 'write' && !isBashToolName(policyToolName)) {
      const target = resolveToolWriteTargets({
        definition: toolDef, params, workingDirectory: this.executionCwd,
      }).targets[0] ?? this.executionCwd;
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

    // Run 级工具面兜底闸（CLI --tools/--disallowed-tools 及等价宿主收窄）。
    // AgentLoop 已在 schema 面过滤 + messageProcessor 拦截模型直调；这里兜底
    // 嵌套调用（PTC executeTool）与直接 executor 调用，保证被裁剪工具永不静默执行。
    // 与 recordDecision 配对（policy-deny），权限账本不断流。
    if (isToolDeniedByRunPolicy({
      deniedToolNames: options.deniedToolNames,
      allowedToolNames: options.allowedToolNames,
      toolScope: options.toolScope,
    }, executionToolName)) {
      logger.warn('Tool blocked by run tool policy', { toolName: executionToolName });
      recordDecision(executionToolName, params, 'policy-deny', 'run tool policy (--tools/--disallowed-tools)', Date.now(), undefined, effectiveSessionId, this.ledgerOrigin);
      return {
        success: false,
        error: `Tool not allowed: ${executionToolName} (disabled by --tools/--disallowed-tools)`,
      };
    }

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
        recordDecision(executionToolName, params, 'policy-deny', 'subagent policy', Date.now(), undefined, effectiveSessionId, this.ledgerOrigin);
        return {
          success: false,
          error: `Denied by subagent permission policy: ${executionToolName}`,
        };
      }
    }

    // Executor-level schema guardrail: direct ToolExecutor callers may bypass the
    // agent runtime's lighter validator, so keep this fail-closed before permission/dispatch.
    // 分档（2026-08-07）：type/enum/format/required 照旧硬拒；未声明字段改成剥离放行
    // + 上报——真库实测那类"多余字段"里 84% 是我们自己没剥干净的 `_meta`（#985），
    // 硬拒等于把内部 bug 的代价转嫁成用户看见的工具报错。
    const schemaIssues = validateToolInputSchema(toolDef.inputSchema, params);
    const blockingIssues = schemaIssues.filter((issue) => issue.category !== 'additional_property');
    if (blockingIssues.length > 0) {
      logger.warn('Tool call failed schema validation', { toolName: executionToolName, requestedToolName, issues: blockingIssues });
      return {
        success: false,
        error: formatToolSchemaValidationError(executionToolName, blockingIssues),
      };
    }
    // 未声明字段不硬拒：剥离后放行 + 上报（生产档），开发档额外 fail-loud。
    if (schemaIssues.length > 0) {
      const stripped = stripUndeclaredToolParams(toolDef.inputSchema, params);
      logger.warn('Tool call carried undeclared params', {
        toolName: executionToolName,
        requestedToolName,
        removedPaths: stripped.removedPaths,
      });
      reportUndeclaredToolParams({
        toolName: executionToolName,
        removedPaths: stripped.removedPaths,
        toolCallId: options.currentToolCallId,
      });
      params = stripped.params as Record<string, unknown>;
    }

    // 记忆目录是 directive authority 边界。按 schema 声明的写 effect 判定，
    // 必须先于 Skill 预授权、安全命令和 classifier，任何自动放行都不能越过。
    const directiveMemoryAssessment = assessDirectiveMemoryWrite({
      definition: toolDef,
      params,
      workingDirectory: this.executionCwd,
      agentRole: options.agentRole,
    });
    let directiveMemoryWriteGrant: import('../../shared/contract').DirectiveMemoryWriteGrant | undefined;
    if (directiveMemoryAssessment.requiresConfirmation) {
      if (!hasInteractiveUi()) {
        // headless/非交互：确认窗不存在，绝不挂 DIRECTIVE_CONFIRM（120s）。
        // 策略与 CLI 权限门同源——问一次 run 级 requestPermission（带上限：
        // skip/devModeAutoApprove/scripted 同步可答；web 停车审批、无 UI 超时
        // 定时器这类在等人类通道的，按 fail-fast 处理，不陪等）。
        const headlessAsk = await probeHeadlessPermission(this.requestPermission, {
          type: 'file_write',
          tool: executionToolName,
          details: { path: getMemoryDir(), preview: directiveMemoryAssessment.preview },
          reason: `全局记忆写入需要用户确认（${executionToolName}）`,
        });
        if (!headlessAsk?.approved) {
          recordDecision(
            executionToolName, params, 'ask-denied',
            headlessAsk?.denialSource ?? 'no-approval-ui',
            Date.now(), undefined, effectiveSessionId, this.ledgerOrigin,
          );
          return {
            success: false,
            // 文案唯一来源在 memory/directiveMemoryMessages.ts（headless 分流）
            error: DIRECTIVE_MEMORY_HEADLESS_NO_UI_ERROR,
            metadata: {
              code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED',
              targets: directiveMemoryAssessment.targets,
            },
          };
        }
        // skip 模式放行：合成确认授权并写 permission ledger（全局记忆写入必须留痕，
        // 设计意图是「用户知情」——skip flag 本身就是用户的显式知情授权）。
        recordDecision(
          executionToolName, params, 'auto-approve',
          'directive-memory-headless-skip-permissions',
          Date.now(), undefined, effectiveSessionId, this.ledgerOrigin,
        );
        directiveMemoryWriteGrant = createDirectiveMemoryWriteGrant(
          directiveMemoryAssessment,
          {
            requestId: `headless-skip-${randomUUID()}`,
            confirmed: true,
            respondedAt: Date.now(),
            timedOut: false,
          },
        );
      } else {
        const confirmation = await requestDirectiveMemoryConfirmation({
          category: `Persistent memory write: ${executionToolName}`,
          content: directiveMemoryAssessment.preview,
        });
        if (!confirmation.confirmed) {
          return {
            success: false,
            // 文案唯一来源在 memory/directiveMemoryMessages.ts（headless/超时/拒绝分流）
            error: directiveMemoryConfirmationFailureError(confirmation),
            metadata: {
              code: 'DIRECTIVE_MEMORY_CONFIRMATION_REQUIRED',
              targets: directiveMemoryAssessment.targets,
            },
          };
        }
        directiveMemoryWriteGrant = createDirectiveMemoryWriteGrant(
          directiveMemoryAssessment,
          confirmation,
        );
      }
    }

    const writeTargets = toolDef.permissionLevel !== 'read'
      ? resolveToolWriteTargets({
        definition: toolDef,
        params,
        workingDirectory: this.executionCwd,
        agentRole: options.agentRole,
      })
      : { targets: [], uncertain: [], mutations: {} };
    const mutationActorId = effectiveSessionId
      ? getFileMutationActorId({ sessionId: effectiveSessionId, agentId: options.agentId })
      : undefined;
    const acquiredMutationTargets: string[] = [];
    const mutationLockManager = getResourceLockManager();
    const usesDedicatedMemorySerialization = toolDef.pathAuthority?.some(
      (descriptor) => descriptor.kind === 'global-memory',
    ) ?? false;

    try {
      if (toolDef.permissionLevel !== 'read') {
      const ownershipActor = effectiveSessionId
        ? createFileOwnershipActor({
          sessionId: effectiveSessionId,
          agentId: options.agentId,
          swarmRunScope: options.swarmRunScope,
          workingDirectory: this.executionCwd,
        })
        : undefined;
      if (!ownershipActor) {
        logger.debug('Skipping file ownership claim without parallel agent identity', {
          toolName: executionToolName,
          sessionId: effectiveSessionId,
        });
      } else {
        const ownershipRegistry = getFileOwnershipRegistry();
        ownershipRegistry.recordUncertain(ownershipActor, writeTargets.uncertain);
        if (writeTargets.uncertain.length > 0) {
          logger.debug('File ownership write targets remain uncertain', {
            toolName: executionToolName,
            agentId: ownershipActor.agentId,
            uncertain: writeTargets.uncertain,
          });
        }
        for (const target of writeTargets.targets) {
          const claim = ownershipRegistry.checkAndClaim(ownershipActor, target);
          if (!claim.ok) {
            const { conflict } = claim;
            return {
              success: false,
              error: `Sibling agent ${conflict.ownerAgentId} currently owns this file. Wait for it to finish, delegate the edit to it, or report the merge need to the parent agent; do not rename the file to bypass ownership.`,
              metadata: {
                code: 'WRITE_OWNERSHIP_CONFLICT',
                path: conflict.path,
                ownerAgentId: conflict.ownerAgentId,
                requesterAgentId: conflict.requesterAgentId,
              },
            };
          }
        }
      }

      if (usesDedicatedMemorySerialization) {
        logger.debug('Skipping generic mutation locks for memory-service target', {
          toolName: executionToolName,
          targets: writeTargets.targets,
        });
      } else if (!mutationActorId) {
        logger.debug('Skipping file mutation locks without agent identity', {
          toolName: executionToolName,
          sessionId: effectiveSessionId,
          targets: writeTargets.targets,
        });
      } else {
        for (const target of writeTargets.targets) {
          const lockResult = await mutationLockManager.acquire(
            mutationActorId,
            target,
            'exclusive',
            {
              type: 'file',
              timeout: FILE_MUTATION_LOCK_HOLD_TIMEOUT_MS,
              wait: true,
              waitTimeout: FILE_MUTATION_LOCK_WAIT_TIMEOUT_MS,
            },
          );
          if (!lockResult.acquired) {
            for (const acquiredTarget of acquiredMutationTargets.reverse()) {
              mutationLockManager.release(mutationActorId, acquiredTarget);
            }
            acquiredMutationTargets.length = 0;
            return {
              success: false,
              error: 'This file is currently in use by another operation. Retry shortly or choose a different output path.',
              metadata: { code: 'FILE_LOCK_BUSY', path: target },
            };
          }
          acquiredMutationTargets.push(target);
        }
      }

      for (const target of writeTargets.targets) {
        const mutation = writeTargets.mutations[target];
        if (!mutation) continue;
        const existed = await fileExists(target);
        if (existed && (mutation === 'create' || (mutation === 'overwrite' && params.overwrite !== true))) {
          return {
            success: false,
            error: 'Output file already exists. Pass overwrite=true to confirm overwriting it, or choose a different output name.',
            metadata: { code: 'TARGET_EXISTS', path: target },
          };
        }
        if (existed && mutation === 'overwrite' && params.overwrite === true) {
          logger.warn('Tool target overwrite safety explicitly confirmed', {
            action: 'tool_target_overwrite',
            toolName: executionToolName,
            path: target,
            actorId: mutationActorId,
          });
        }
        if (existed && mutation === 'edit' && mutationActorId) {
          const readRecord = fileReadTracker.getReadRecord(target, mutationActorId);
          if (readRecord) {
            const modification = await checkExternalModification(target, mutationActorId);
            if (modification.modified) {
              return {
                success: false,
                error: `${modification.message}. Re-read the file before editing it.`,
                metadata: {
                  code: 'STALE_FILE',
                  path: target,
                  modification: modification.details,
                  evidenceRef: readRecord.evidenceRef,
                },
              };
            }
          }
        }
      }
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
        effectiveSessionId,
        this.ledgerOrigin,
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

    // 嵌套工具再入口（PTC）：绑定 this + 本次 options，让 tools.X() 走回**同一个**
    // executor 的完整 execute()。收缩档靠「同实例 + 原样透传 options」继承，不复制。
    // 嵌套调用自身带 nestedToolCall 标记 → 它的 context 不再签发 executeTool（一层封顶）。
    let nestedCallSeq = 0;
    const executeNestedTool = options.nestedToolCall
      ? undefined
      : (nestedToolName: string, nestedParams: Record<string, unknown>) => this.execute(
        nestedToolName,
        nestedParams,
        {
          ...options,
          nestedToolCall: true,
          currentToolCallId: `${options.currentToolCallId ?? executionToolName}:nested:${++nestedCallSeq}`,
        },
      );

    // Root executions have a stable agent identity across turns. Spawned executions must
    // supply their concrete agent id; leaving it undefined makes file mutations fail loud.
    const contextAgentId = options.agentId?.trim()
      || ((options.spawnDepth ?? 0) === 0 ? 'primary' : undefined);

    // Create tool context
    const context: ToolContext & { sessionId?: string } = {
      runId: effectiveRunId, turnId: options.turnId,
      sourceMessageId: options.sourceMessageId,
      sessionId: effectiveSessionId,
      workspace: this.runtimeWorkspace,
      workspaceScope: this.runContext?.workspaceScope,
      workingDirectory: this.executionCwd,
      requestPermission: this.requestPermissionForTools,
      abortSignal: options.abortSignal,
      deniedToolNames: options.deniedToolNames,
      allowedToolNames: options.allowedToolNames,
      skillDiscoveryService: options.skillDiscoveryService,
      telemetryCollector: this.telemetryCollector,
      planningService: options.planningService,
      modelConfig: options.modelConfig,
      // Plan Mode support (borrowed from Claude Code v2.0)
      setPlanMode: options.setPlanMode,
      isPlanMode: options.isPlanMode,
      emitEvent: options.emitEvent,
      // Also set emit as alias for emitEvent (tools use context.emit)
      emit: options.emitEvent,
      // Per-agent BrowserPool / ComputerSurface isolation
      agentId: contextAgentId,
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
      executeTool: executeNestedTool,
      toolScope: options.toolScope,
      executionIntent: options.executionIntent,
      neoTag: options.neoTag,
      directiveMemoryWriteGrant,
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
        recordDecision(executionToolName, params, 'policy-deny', neoTagGuard.reason, permStartTime, undefined, effectiveSessionId, this.ledgerOrigin);
        return {
          success: false,
          error: neoTagGuard.reason,
        };
      }
    }

    // Security: Pre-execution validation for bash commands
    let commandValidation: ValidationResult | undefined;
    let commandAnalysisFailedReason: string | undefined;
    if (isBashToolName(policyToolName) && params.command) {
      commandValidation = validateCommand(params.command as string);

      const workspaceContainedSystemDelete = !commandValidation.allowed
        && commandValidation.securityFlags.some((flag) => (
          flag === 'system_dir_delete' || flag === 'container_dir_delete'
        ))
        && commandValidation.securityFlags.every((flag) => (
          flag === 'recursive_delete_targeted'
          || flag === 'system_dir_delete'
          || flag === 'container_dir_delete'
        ))
        && recursiveRmIsContainedInWorkspace(params.command as string, {
          workingDirectory: resolveCanonicalRunPath(this.executionCwd),
          workspaceRoot: this.writeWorkspaceRoot,
        });
      if (workspaceContainedSystemDelete) {
        commandValidation = {
          ...commandValidation,
          allowed: true,
          reason: 'Recursive/forced deletion of a specific workspace path',
          riskLevel: 'high',
          securityFlags: commandValidation.securityFlags.filter((flag) => (
            flag !== 'system_dir_delete' && flag !== 'container_dir_delete'
          )),
        };
      }

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
        recordDecision(executionToolName, params, 'monitor-blocked', commandValidation.reason || 'security', permStartTime, undefined, effectiveSessionId, this.ledgerOrigin);

        return {
          success: false,
          error: `Security: Command blocked - ${commandValidation.reason}`,
        };
      }

      if (commandValidation.parsingFailed) {
        commandAnalysisFailedReason = commandValidation.parsingFailureReason ?? 'command tokenization failed';
        const fingerprint = createHash('sha256')
          .update(commandValidation.canonicalCommand)
          .digest('hex');
        const repeated = effectiveSessionId
          ? getPermissionModeManager().rememberCommandAnalysisFailure(effectiveSessionId, fingerprint)
          : false;
        if (repeated) {
          const hostReason = commandAnalysisDenialError(executionToolName);
          const error = hostReason.modelText;
          logger.warn('Repeated unanalyzable command denied before permission request', {
            tool: executionToolName,
            sessionId: effectiveSessionId,
            fingerprint,
          });
          options.hookManager?.triggerPermissionDenied(
            executionToolName, error, 'runtime', effectiveSessionId || 'unknown',
          ).catch(() => {});
          recordDecision(
            executionToolName,
            params,
            'policy-deny',
            'command_analysis_sticky',
            permStartTime,
            undefined,
            effectiveSessionId,
            this.ledgerOrigin,
          );
          return {
            success: false,
            error,
            metadata: {
              code: 'COMMAND_ANALYSIS_STICKY_DENY',
              failureCode: AgentFailureCode.PermissionDenied,
              hostReason,
            },
          };
        }
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
    const policyEnforcer = getPolicyEnforcer(resolveCanonicalRunPath(this.runtimeWorkspace));
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
        recordDecision(executionToolName, params, 'policy-deny', policyCheck.reason || 'policy', permStartTime, trace, effectiveSessionId, this.ledgerOrigin);

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
    const shellDesktopAutomation = isBashToolName(policyToolName)
      ? classifyShellDesktopAutomation(params.command)
      : null;
    const consequenceForcesClassification = browserComputerConsequenceForcesClassification(
      executionToolName,
      params,
    );
    const bashArgumentForcesClassification = isBashToolName(policyToolName)
      && typeof params.command === 'string'
      && bashCommandRequiresPermission(params.command, {
        workingDirectory: resolveCanonicalRunPath(this.executionCwd),
        workspaceRoot: this.writeWorkspaceRoot,
      });
    const readArgumentForcesClassification = readArgumentsRequirePermission(
      executionToolName,
      params,
      {
        workingDirectory: resolveCanonicalRunPath(this.executionCwd),
        workspaceRoot: this.writeWorkspaceRoot,
      },
    );
    const argumentForcesClassification = bashArgumentForcesClassification
      || readArgumentForcesClassification;

    // Check permission if required
    // Skill 系统：预授权工具跳过普通权限检查（但不能跳过边界违规或 consequence hard deny）
    const isPreApproved = !boundaryViolation
      && !guardFabricForcesApproval
      && !commandAnalysisFailedReason
      && !shellDesktopAutomation
      && !consequenceForcesClassification
      && !argumentForcesClassification
      && !this.forcePermissionHandler
      && options.preApprovedTools !== undefined
      && options.preApprovedTools.size > 0
      && toolMatchesPatternSet(executionToolName, params, options.preApprovedTools);
    if (isPreApproved) {
      logger.debug('Tool pre-approved by Skill system, skipping permission check', { toolName: executionToolName });
      recordDecision(executionToolName, params, 'auto-approve', 'pre-approved', permStartTime, undefined, effectiveSessionId, this.ledgerOrigin);
    }

    // P0: 安全命令白名单 + exec policy — 已知安全命令跳过审批
    let isSafeCommand = false;
    if (isBashToolName(policyToolName) && params.command && !commandAnalysisFailedReason && !shellDesktopAutomation && !isPreApproved && !guardFabricForcesApproval && !this.forcePermissionHandler) {
      const cmd = params.command as string;

      // 1. 检查 exec policy 持久化规则
      try {
        const policyDecision = getExecPolicyStore().match(cmd);
        if (policyDecision === 'allow') {
          isSafeCommand = true;
          logger.debug('Command allowed by exec policy', { command: cmd.substring(0, 80) });
          recordDecision(executionToolName, params, 'policy-allow', 'exec-policy', permStartTime, undefined, effectiveSessionId, this.ledgerOrigin);
        } else if (policyDecision === 'forbidden') {
          recordDecision(executionToolName, params, 'policy-deny', 'exec-policy', permStartTime, undefined, effectiveSessionId, this.ledgerOrigin);
          return {
            success: false,
            error: `Blocked by exec policy: ${cmd.substring(0, 80)}`,
          };
        }
      } catch {
        // exec policy not initialized, skip
      }

      // 2. 检查安全命令白名单
      if (!isSafeCommand && !bashArgumentForcesClassification && isKnownSafeCommand(cmd)) {
        isSafeCommand = true;
        logger.debug('Command is known safe, skipping approval', { command: cmd.substring(0, 80) });
        recordDecision(executionToolName, params, 'auto-approve', 'safe-command', permStartTime, undefined, effectiveSessionId, this.ledgerOrigin);
      }

      // 3. lenient 模式（已决策 2026-06-10，朋友测试包默认）：硬毙清单照拦
      //    （validateCommand critical 在前置闸已挡），其余未识别命令放行不进审批。
      //    confirmationGate 的 HIGH_RISK_PATTERNS 仍独立生效，最高危命令保留确认。
      if (!isSafeCommand && getShellSafetyMode() === 'lenient') {
        const lenientCheck = commandValidation ?? validateCommand(cmd);
        if (lenientCheck.allowed) {
          isSafeCommand = true;
          logger.debug('Command auto-approved by lenient safety mode', { command: cmd.substring(0, 80) });
          recordDecision(executionToolName, params, 'auto-approve', 'lenient-mode', permStartTime, undefined, effectiveSessionId, this.ledgerOrigin);
        }
      }
    }

    if ((toolDef.requiresPermission || readArgumentForcesClassification) && (commandAnalysisFailedReason || this.forcePermissionHandler || writeWithoutWorkspaceAuthority || guardFabricForcesApproval || policyForcesConfirmation || boundaryViolation || readOnlyForcesConfirmation || shellDesktopAutomation || consequenceForcesClassification || argumentForcesClassification || (!isPreApproved && !isSafeCommand))) {
      // P1: Auto-approve classifier — 规则+LLM 自动判断安全性
      let needsUserApproval = true;
      // 信任边界 ask（W3 写边界）→ forceConfirm：终审层便利放行必须让路（同 directory_access）。
      let boundaryAskForcesConfirmation = false;
      // B4：external 工具的授权 target 精确串（取不到=null，不具铸权资格）。一次算好，
      // 供下面的长期授权消费判定，以及需人工审批时透传给停车审批卡（铸权入口）。
      const standingGrantTarget = isExternalSideEffectTool(executionToolName)
        ? extractStandingGrantTarget(executionToolName, params)
        : null;
      // Lazy trace: only created when needed (deny/ask path)
      const traceBuilder = createTraceBuilder(executionToolName);
      /** 分类器抛错（≠ 判 ask）时的错误串；非空表示这次「问用户」其实是故障回退。 */
      let classifierFailedReason: string | undefined;
      // validateCommand 只描述已命中的危险形态；分类器因无法识别而 ask 时，
      // `safe` 会误导审批卡。保留分析器本身不变，只在这次审批请求上标 unknown。
      let commandRiskUnknown = Boolean(commandAnalysisFailedReason);
      if (guardFabricTraceStep) {
        traceBuilder.addStep(
          guardFabricTraceStep.layer,
          guardFabricTraceStep.rule,
          guardFabricTraceStep.result,
          guardFabricTraceStep.reason,
        );
      }
      if (commandAnalysisFailedReason) {
        traceBuilder.addStep(
          'permission_classifier',
          'command_analysis_failed',
          'ask',
          `命令无法可靠拆词，审批结果不能放行：${commandAnalysisFailedReason}`,
        );
      } else if (!guardFabricForcesApproval) {
        try {
          // 三分支解析 + readOnly/档位改写规则见 toolPermissionClassification.ts
          const workspaceRoot = this.writeWorkspaceRoot;
          const classification: ClassificationResult = await resolveToolPermissionClassification({
            executionToolName,
            policyToolName,
            params,
            policyForcesConfirmation,
            boundaryViolation,
            workingDirectory: resolveCanonicalRunPath(this.executionCwd),
            workspaceRoot,
            permissionLevel: toolDef.permissionLevel,
            permStartTime,
            readOnlyForcesConfirmation,
            sessionPermissionMode,
          });
          // B1: EXTERNAL 风险类打标进 decisionTrace（result='allow'，不改变审批结果，仅供
          // B2 无人值守停车 / B4 target 授权与审计消费）。此处入 traceBuilder 覆盖 deny/ask 路径；
          // approve 路径另建 builder（见下），故其单独补一条。
          if (classification.external) {
            traceBuilder.addStep('permission_classifier', EXTERNAL_SIDE_EFFECT_TRACE_RULE, 'allow', EXTERNAL_SIDE_EFFECT_TRACE_REASON);
          }
          if (classification.decision === 'approve' && !this.forcePermissionHandler) {
            logger.info('Auto-approved by classifier', {
              tool: executionToolName,
              reason: classification.reason,
              confidence: classification.confidence,
              cached: classification.cached,
            });
            needsUserApproval = false;
            let trace: import('../../shared/contract/decisionTrace').DecisionTrace | undefined;
            if (classification.external || classification.traceStep) {
              const approveTrace = createTraceBuilder(executionToolName);
              if (classification.external) {
                approveTrace.addStep('permission_classifier', EXTERNAL_SIDE_EFFECT_TRACE_RULE, 'allow', EXTERNAL_SIDE_EFFECT_TRACE_REASON);
              }
              if (classification.traceStep) {
                approveTrace.addStep(
                  classification.traceStep.layer,
                  classification.traceStep.rule,
                  classification.traceStep.result,
                  classification.traceStep.reason,
                );
              }
              trace = approveTrace.build('allow');
            }
            recordDecision(executionToolName, params, 'auto-approve', classification.reason || 'classifier', permStartTime, trace, effectiveSessionId, this.ledgerOrigin);
          } else if (classification.decision === 'deny') {
            const hostReason = classification.hostReason ?? createHostReason(
              HostReasonCode.PermissionClassifierDenied,
              classification.reason,
              { toolName: executionToolName },
            );
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
            recordDecision(executionToolName, params, 'classifier-deny', classification.reason || 'classifier', permStartTime, traceBuilder.build('deny'), effectiveSessionId, this.ledgerOrigin);
            return {
              success: false,
              error: `Denied: ${classification.reason}`,
              metadata: {
                ...(classification.errorCode ? { code: classification.errorCode } : {}),
                failureCode: AgentFailureCode.PermissionDenied,
                hostReason: {
                  ...hostReason,
                  modelText: `Denied: ${hostReason.modelText}`,
                },
              },
            };
          } else {
            if (classification.decision === 'approve') {
              traceBuilder.addStep(
                'plan_approval',
                INJECTED_PERMISSION_HANDLER_TRACE_RULE,
                'ask',
                'Run-scoped permission handler must decide this tool call',
              );
            }
            // 'ask' — collect trace step for permission request
            if (
              classification.decision === 'ask'
              && isBashToolName(policyToolName)
              && commandValidation?.riskLevel === 'safe'
            ) {
              commandRiskUnknown = true;
            }
            if (classification.trustBoundary) boundaryAskForcesConfirmation = true;
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
          // 分类器抛错和分类器判 ask 都会走到「问用户」，但两者性质完全不同：前者是故障。
          // 原先只有 logger.debug（默认不进日志文件）⇒ 现场零线索。必须 warn，且落进
          // decisionTrace（rule=classifier_error，与判 ask 的 rule 天然可区分）。
          classifierFailedReason = classifierError instanceof Error
            ? classifierError.message
            : String(classifierError);
          traceBuilder.addStep(
            'permission_classifier',
            CLASSIFIER_ERROR_TRACE_RULE,
            'ask',
            createHostReason(
              HostReasonCode.PermissionClassifierFailed,
              `分类器抛错，回退人工审批：${classifierFailedReason}`,
              { toolName: executionToolName },
            ),
          );
          logger.warn('Permission classifier error, falling back to user approval', {
            tool: executionToolName,
            error: classifierFailedReason,
          });
        }
      }

      // B4 target 粒度长期授权消费：external 工具 + 可确定性提取 target + 命中该会话所属
      // automation 上人工铸造的 (tool, target) 规则 → 免这一层询问（等价 session 记忆的持久版，
      // 但按 target 精确、挂 automation、随其归档失效）。绝不越 deny：分类器 deny 已在上面 return；
      // 任一强制确认门（guardFabric/policy/boundary/readOnly）在此让路——与 session 记忆同规矩，
      // 只把「普通询问」降为放行，不碰任何硬门。
      if (
        needsUserApproval
        && standingGrantTarget
        && !guardFabricForcesApproval
        && !policyForcesConfirmation
        && !boundaryViolation
        && !readOnlyForcesConfirmation
        && !commandAnalysisFailedReason
        && getSessionAutomationService().matchStandingGrant(effectiveSessionId, executionToolName, standingGrantTarget)
      ) {
        needsUserApproval = false;
        const grantTrace = createTraceBuilder(executionToolName);
        grantTrace.addStep('permission_classifier', 'standing_grant', 'allow', `长期授权命中：${executionToolName} → ${standingGrantTarget}`);
        recordDecision(executionToolName, params, 'auto-approve', `standing_grant:${standingGrantTarget}`, permStartTime, grantTrace.build('allow'), effectiveSessionId, this.ledgerOrigin);
      }

      if (needsUserApproval) {
      const permissionRequest = this.buildPermissionRequest(
        toolDef,
        params,
        commandValidation,
        commandRiskUnknown ? 'unknown' : undefined,
      );
      const deleteTarget = commandValidation && typeof params.command === 'string'
        ? extractDeleteTarget(params.command, commandValidation.securityFlags)
        : undefined;
      if (deleteTarget) {
        const commandCwd = typeof params.working_directory === 'string'
          ? nodePath.resolve(this.executionCwd, params.working_directory)
          : this.executionCwd;
        const affectedPath = nodePath.isAbsolute(deleteTarget)
          ? nodePath.resolve(deleteTarget)
          : nodePath.resolve(commandCwd, deleteTarget);
        permissionRequest.details.affectedPath = affectedPath;
        permissionRequest.details.affectedFileCount = await countAffectedFiles(affectedPath);
      }
      permissionRequest.sessionId = effectiveSessionId;
      // resolved 审批结果回到 renderer 后，靠现成 tool call id 锚到对应步骤旁展示。
      // 只补关联字段，不复制参数或另建历史存储。
      permissionRequest.parentToolUseId = options.currentToolCallId;
      // B4：把授权 target 透传给审批层，供无人值守停车审批卡出「每次都允许发 <target>」铸权入口。
      if (standingGrantTarget) {
        permissionRequest.details.standingGrantTarget = standingGrantTarget;
      }

      // B1 readOnly（审出 HIGH）：最终审批层的自动放行捷径（agentOrchestrator 的
      // devModeAutoApprove / autoApprove[level]、renderer PermissionCard 的
      // always/session 权限记忆）全部对 forceConfirm 让路——只读探索档下
      // 写入/执行必须逐次真人确认，且不写入/不消费权限记忆。
      // 信任边界 ask（W3 写边界）同样让路：2026-08-13 真机事故里 devModeAutoApprove
      // 把 $HOME 写边界 ask 自动批掉、文件真落盘。
      if (readOnlyForcesConfirmation || guardFabricForcesApproval || boundaryAskForcesConfirmation) {
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
            traceBuilder.addStep('plugin_hook', 'permission_request_hook', 'deny', hookResult.message || 'blocked');
            recordDecision(executionToolName, params, 'hook-blocked', hookResult.message || 'hook', permStartTime, traceBuilder.build('deny'), effectiveSessionId, this.ledgerOrigin);
            return {
              success: false,
              error: `Permission denied by hook: ${hookResult.message || 'blocked'}`,
            };
          }
        } catch (hookError) {
          logger.debug('PermissionRequest hook error, continuing to user approval', hookError);
        }
      }

      const ask = await requestPermissionWithTelemetry({
        request: permissionRequest,
        toolCallId: options.currentToolCallId,
        requestPermission: this.requestPermission,
      });
      if (commandAnalysisFailedReason) {
        ask.approved = false;
        ask.denialSource = 'fail-closed';
        ask.message = commandAnalysisDenialError(executionToolName).modelText;
      }
      // N-WRITEBACK-EDIT：用户在审批卡上改过的参数在这里、且只在这里替换。下游的
      // approvedToolCall（工具体内 canUseTool 的短路匹配）、账本、派发全部拿到改后的那份，
      // 8 个写回工具文件一行不动。表外工具/字段/必填为空 → fail-closed 当拒绝处理。
      if (ask.approved && ask.updatedArgs) {
        const edited = applyEditedArgs(executionToolName, params, ask.updatedArgs);
        if (edited.ok) {
          params = edited.params;
          traceBuilder.addStep('plan_approval', 'user_edited_args', 'allow', `用户在审批卡上改了：${edited.changedKeys.join(', ') || '（无实际改动）'}`);
        } else {
          ask.approved = false;
          ask.denialSource = 'fail-closed';
          ask.message = `Edited arguments rejected: ${edited.reason}`;
        }
      }
      const approved = ask.approved;

      if (approved) {
        const approvalSource = ask.approvalSource ?? 'user';
        traceBuilder.addStep('plan_approval', 'ask_approved', 'allow', `审批放行（来源：${approvalSource}）`);
        recordDecision(executionToolName, params, 'ask-approved', approvalSource, permStartTime, traceBuilder.build('allow'), effectiveSessionId, this.ledgerOrigin, getApprovalWaitMs(options.currentToolCallId, Date.now()));
      }

      // P0: prefix_rule 学习 — 用户批准后生成持久化规则
      if (
        approved
        && (ask.approvalSource === undefined || ask.approvalSource === 'user')
        && isBashToolName(policyToolName)
        && params.command
      ) {
        try {
          getExecPolicyStore().learnFromApproval(params.command as string);
        } catch {
          // exec policy not initialized, skip
        }
      }

      if (!approved) {
        // N-PERMTRACE：拒绝的**真实来源**由处理器自报（裸 boolean 仍解释为 'user'），
        // 不按调用方名字枚举。ledger 的 reason 同时带上「为什么会走到问用户这一步」——
        // 分类器抛错回退是故障，不能和用户主动拒绝混成同一条记录。
        const denialSource = ask.denialSource ?? 'user';
        const denialReason = commandAnalysisFailedReason
          ? `command_analysis_failed/${denialSource}`
          : classifierFailedReason
          ? `${CLASSIFIER_ERROR_TRACE_RULE}/${denialSource}`
          : denialSource;
        // 只读探索档（审出 MED）：无审批 UI 的运行环境（CLI run/batch 非交互模式）对
        // forceConfirm 请求自动拒绝（fail-closed）。泛用的 "Permission denied by user"
        // 在该路径是误导——给模型可转述的真实原因与出路。
        // 通话态曾有一条专用文案分支，2026-07-29 通话不再钳档后它已死（见 readOnlyDenialError）。
        const defaultDenialReason = readOnlyForcesConfirmation
          ? readOnlyDenialError(executionToolName)
          : permissionDenialError(executionToolName, denialSource);
        const hostReason = ask.message
          ? { ...defaultDenialReason, modelText: ask.message }
          : defaultDenialReason;
        const denialError = hostReasonModelText(hostReason);

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
            error: denialError,
          });
        }
        // Fire-and-forget: emit PermissionDenied hook
        // deniedBy：真人拒才是 'user'，其余一律 'runtime'（环境/运行时自动拒），细节在 reason 里。
        options.hookManager?.triggerPermissionDenied(
          executionToolName, denialError, denialSource === 'user' ? 'user' : 'runtime',
          effectiveSessionId || 'unknown',
        ).catch(() => {});
        traceBuilder.addStep('plan_approval', 'ask_denied', 'deny', hostReason);
        recordDecision(executionToolName, params, 'ask-denied', denialReason, permStartTime, traceBuilder.build('deny'), effectiveSessionId, this.ledgerOrigin, getApprovalWaitMs(options.currentToolCallId, Date.now()));

        return {
          success: false,
          error: denialError,
          metadata: {
            failureCode: AgentFailureCode.PermissionDenied,
            hostReason,
          },
        };
      }
      } // end needsUserApproval
    }

    const toolCache = getToolCache();
    const toolCacheScope = {
      sessionId: effectiveSessionId,
      workingDirectory: this.runtimeWorkspace,
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
      this.runtimeWorkspace,
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
      origin: this.ledgerOrigin,
      emission: toolDef.emission,
      workingDirectory: this.executionCwd,
      workspace: this.runtimeWorkspace,
      turnTrace: options.turnTrace,
      toolCallId: options.currentToolCallId,
      replaySafety: classifyToolReplaySafety(toolDef),
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
      const fileCheckpoint = await createFileCheckpointIfNeeded(executionToolName, params, () => {
        if (!effectiveSessionId) return null;
        // messageId 从 context 中获取，如果没有则使用工具调用 ID
        const messageId = options.currentToolCallId || `msg_${Date.now()}`;
        return {
          sessionId: effectiveSessionId,
          messageId,
          workspaceScope: this.runContext?.workspaceScope,
        };
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
        sourceMessageId: options.sourceMessageId,
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
      if (rawResult.success && fileCheckpoint) {
        await getFileCheckpointService().finalizeCheckpointDigest(
          fileCheckpoint.checkpointId,
          fileCheckpoint.filePath,
        );
      }
      const resultWithSurfaceProjection = ensureFailedToolResultError(
        executionToolName,
        await finalizeSurfaceAwareToolResult({
          toolName: executionToolName,
          arguments: params,
          result: rawResult,
          workingDirectory: this.runtimeWorkspace,
          conversationId: effectiveSessionId, runId: effectiveRunId, turnId: options.turnId, agentId: options.agentId,
          toolCallId: options.currentToolCallId || executionId, startedAt: startTime,
        }),
      );
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
      logger.info('Tool execution completed', {
        toolName: executionToolName,
        success: result.success,
        durationMs: duration,
      });

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
    } finally {
      if (mutationActorId) {
        for (const target of acquiredMutationTargets.reverse()) {
          mutationLockManager.release(mutationActorId, target);
        }
      }
    }
  }

  private buildPermissionRequest(
    tool: ToolDefinition,
    params: Record<string, unknown>,
    commandValidation?: ValidationResult,
    commandRiskOverride?: 'unknown',
  ): PermissionRequestData {
    const sourceAttribution = (rawPath?: unknown): Record<string, unknown> => {
      const workspaceScope = this.runContext?.workspaceScope;
      if (!workspaceScope) return {};
      const candidate = typeof rawPath === 'string' && rawPath.trim()
        ? (nodePath.isAbsolute(rawPath)
          ? nodePath.resolve(rawPath)
          : nodePath.resolve(this.executionCwd, rawPath))
        : this.executionCwd;
      const match = resolveWorkspacePath(workspaceScope, candidate, 'read');
      if (!match) return { workspaceScopeVersion: workspaceScope.version };
      return {
        projectId: workspaceScope.projectId,
        sourceId: match.root.sourceId,
        sourceRole: match.root.role,
        sourceAccess: match.root.access,
        relativePathWithinSource: match.relativePath,
        workspaceScopeVersion: workspaceScope.version,
      };
    };
    switch (tool.name) {
      case 'bash':
      case 'Bash':
        return {
          type: isDangerousCommand(params.command as string)
            ? 'dangerous_command'
            : 'command',
          tool: tool.name,
          details: {
            command: params.command,
            commandRiskLevel: commandRiskOverride ?? commandValidation?.riskLevel,
            commandSecurityFlags: commandValidation?.securityFlags,
            ...sourceAttribution(params.working_directory),
          },
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
          details: { path: params.file_path, ...sourceAttribution(params.file_path) },
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
            ...sourceAttribution(params.file_path),
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
            ...sourceAttribution(params.file_path),
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
            ...sourceAttribution(params.file_path),
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
        const connector = findConnectorToolMetadata(tool.name);
        const connectorWriteReason = tool.permissionLevel === 'write'
          ? connectorExternalWriteReason(tool.name)
          : undefined;
        if (connector && connectorWriteReason) {
          return {
            type: 'file_write',
            tool: tool.name,
            details: { ...params },
            reason: connectorWriteReason,
            boundary: {
              id: 'connector.external_write',
              reason: connectorWriteReason,
              reasonEn: connectorExternalWriteReason(tool.name, 'en'),
              connectorName: connector.connectorName,
              connectorNameEn: connector.connectorNameEn,
            },
          };
        }
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

    const workspace = this.runtimeWorkspace;
    const resolvedPath = nodePath.isAbsolute(filePath)
      ? nodePath.resolve(filePath)
      : nodePath.resolve(this.executionCwd, filePath);
    const match = this.runContext?.workspaceScope
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

  private get runtimeWorkspace(): string {
    return this.runContext?.workspace ?? this.workingDirectory;
  }

  private get writeWorkspaceRoot(): string | undefined {
    if (this.runContext) {
      return this.runContext.workspaceScope?.primaryRoot;
    }
    // 无 runContext 的基座 executor：workingDirectory 仍可当写边界（前台 IPC run
    // 继承会话项目目录，竞品一致），但必须过与 delegate_task 前置预检 / createRunContext
    // 同一份宽度校验——否则 $HOME / 数据目录 / 祖先路径（/Users、/）也会被当项目边界
    // 无审批自动放行（安全单 2026-08-09：语音后台 run 把 $HOME 写入判 W1）。判据只此一份，
    // 不在消费端另造（workspaceAuthority.ts 的注释即禁第二份）。
    return resolveBackgroundWorkspaceAuthority({ workspace: this.workingDirectory })?.primaryRoot;
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
    if (
      this.runContext.workspaceScope
      && !resolveWorkspacePath(this.runContext.workspaceScope, candidate, 'read')
    ) {
      return {
        error: `Run ${this.runContext.runId} cannot execute outside workspace Project Sources: ${candidate}`,
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
