/* eslint-disable max-lines */
// ============================================================================
// ParallelAgentCoordinator - DAG-based explicit parallel agent execution
// ============================================================================
//
// 职责边界（ADR-009 固化）：
// - 服务 **显式任务** 入口：LLM 调用 spawn_agent tool、swarm.ipc 的 UI swarm
// - 输入形态：AgentTask[]（带 dependsOn/tools/priority 的 DAG 节点）
// - 核心能力：TaskDAG + DAGScheduler 做真正的依赖图调度，SharedContext
//   （L2 共享读写），EventEmitter 事件流，节点级 Checkpoint 断点恢复
// - 不包含：动态 agent 生成、L0-L3 通信层级
//
// 与 AutoAgentCoordinator 的关系：
// - 两者 **零调用交集**，服务完全不同的入口路径
// - 不会合并：输入形态差别大（DynamicAgentDefinition vs AgentTask），
//   核心能力互不覆盖（Auto 无 DAG，Parallel 无 Auto 的动态生成），强合需引 adapter
// - 在 crash-safe 这条基础能力上对称（ADR-010 item #3）：都有节点级 JSON
//   checkpoint（目录见 COORDINATION_CHECKPOINTS.{AUTO,PARALLEL}_DIR），
//   schema 与字段语义不同但概念对齐。对照表见
//   docs/architecture/coordinator-checkpoint-symmetry.md
//
// ============================================================================
//
// ## 节点级 Checkpoint（断点恢复）
//
// 长程 swarm 执行中，主进程崩溃/kill 会导致已完成节点工作白费。每个节点
// 完成后持久化结果，重启后 restoreCheckpoint 重建 completedTasks /
// taskDefinitions / sharedContext，重新提交同一份 tasks 会自动跳过已成功
// 节点（cache-skip guard 在 executeTask 入口）。
//
// - 存储: ~/.code-agent/parallel-coordination-checkpoints/<sessionId>.json
// - 粒度: Task 节点级（成功与失败都入快照；只有 success 才短路，失败会重跑）
// - 运行中任务: 不持久化 Promise，重启后凭借"不在 completedTasks"触发重调度
// - 清理: executeParallel 全部成功后自动删除快照
// - DAG 路径: executeWithDAG 在 convertSchedulerResult 末尾做一次批量 save，
//   但 scheduler 是外部执行体，不支持从 completedTasks restore。DAG 路径的
//   crash-safe 能力是增量的（记录存量、不恢复调度）
// ============================================================================

import { EventEmitter } from 'events';
import { createHash } from 'crypto';
import { promises as fsPromises } from 'fs';
import * as path from 'path';
import type { ModelConfig } from '../../shared/contract';
import {
  getSwarmRunScopeKey,
  type SwarmAgentContextSnapshot,
  type SwarmRunRef,
  type SwarmRunScope,
} from '../../shared/contract/swarm';
import type { ToolContext } from '../tools/types';
import type { ToolResolver } from '../tools/dispatch/toolResolver';
import type { SubagentResult } from './subagentExecutorTypes';
import type { SubagentExecutorPort } from './subagentExecutorPort';
import {
  AgentFailureCode,
  agentFailureCodeFromCancellationReason,
  inferAgentFailureCode,
} from '../../shared/contract/agentFailure';
import { createTextMessage, getSpawnGuard, type AgentMessage } from './spawnGuard';
import { createLogger } from '../services/infra/logger';
import { withTimeout } from '../services/infra/timeoutController';
import { TaskDAG, createRunDAGScheduler, type SchedulerResult } from '../scheduler';
import { AGENT_TIMEOUTS, COORDINATION_CHECKPOINTS } from '../../shared/constants';
import { getUserConfigDir } from '../config/configPaths';

const logger = createLogger('ParallelAgentCoordinator');

// ============================================================================
// Types
// ============================================================================

export interface AgentTask {
  id: string;
  role: string;
  task: string;
  systemPrompt?: string;
  tools: string[];
  maxIterations?: number;
  dependsOn?: string[]; // IDs of tasks this task depends on
  priority?: number; // Higher = more priority
}

export interface AgentTaskResult extends SubagentResult {
  taskId: string;
  role: string;
  startTime: number;
  endTime: number;
  duration: number;
  blocked?: boolean;
  cancelled?: boolean;
  failureCode?: AgentFailureCode;
}

export interface ParallelExecutionResult {
  success: boolean;
  results: AgentTaskResult[];
  totalDuration: number;
  parallelism: number; // How many tasks ran in parallel
  errors: Array<{ taskId: string; error: string }>;
}

export type ParallelAgentTaskSnapshotStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface ParallelAgentTaskSnapshot {
  taskId: string;
  role: string;
  task: string;
  tools: string[];
  dependsOn?: string[];
  status: ParallelAgentTaskSnapshotStatus;
  result?: AgentTaskResult;
  error?: string;
  failureCode?: AgentFailureCode;
  startedAt?: number;
  completedAt?: number;
  duration?: number;
}

export type ParallelCoordinatorTerminalStatus = 'completed' | 'failed' | 'cancelled';

export interface CompletedParallelCoordinatorTaskSnapshot {
  taskId: string;
  role: string;
  status: ParallelAgentTaskSnapshotStatus;
  error?: string;
  failureCode?: AgentFailureCode;
  startedAt?: number;
  completedAt?: number;
  duration?: number;
}

export interface CompletedParallelCoordinatorSnapshot {
  scope: SwarmRunScope;
  status: ParallelCoordinatorTerminalStatus;
  completedAt: number;
  tasks: readonly CompletedParallelCoordinatorTaskSnapshot[];
}

export interface SharedContext {
  findings: Map<string, unknown>;
  files: Map<string, string>;
  decisions: Map<string, string>;
  errors: string[];
  /**
   * 每个 finding/file/decision key 的最后更新时间戳（ms epoch）。
   * 子代理读队友共享数据时据此判断新鲜度（isStale），避免基于陈旧 draft 决策
   * （swarm 护栏 P1-2 #5）。
   */
  lastUpdated: Map<string, number>;
}

export type CoordinatorEventType =
  | 'task:start'
  | 'task:progress'
  | 'task:complete'
  | 'task:error'
  | 'discovery'
  | 'all:complete';

export interface CoordinatorEvent {
  type: CoordinatorEventType;
  taskId?: string;
  data?: unknown;
}

interface TaskProgressEvent {
  taskId: string;
  role: string;
  snapshot: SwarmAgentContextSnapshot;
}

export interface CoordinatorConfig {
  maxParallelTasks: number;
  taskTimeout: number;
  enableSharedContext: boolean;
  aggregateResults: boolean;
}

/**
 * Checkpoint schema for ParallelAgentCoordinator.
 *
 * Map 字段序列化为 [key, value] entries 数组，保持与 JSON round-trip 对齐。
 * 未知字段在 restore 时忽略（向前兼容），不认识的 version 视为 stale 丢弃。
 */
interface ParallelCheckpoint {
  version: number;
  sessionId: string;
  runId?: string;
  treeId?: string;
  createdAt: number;
  updatedAt: number;
  taskDefinitions: Array<[string, AgentTask]>;
  completedTasks: Array<[string, AgentTaskResult]>;
  runningTaskIds: string[];
  sharedContext: {
    findings: Record<string, unknown>;
    files: Record<string, string>;
    decisions: Record<string, string>;
    errors: string[];
    /** key → 最后更新时间戳；老 checkpoint 可能没有，restore 时按缺省空对象处理 */
    lastUpdated?: Record<string, number>;
  };
}

type ParallelCheckpointIdentity = string | SwarmRunScope;

function getCheckpointDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

function isSameRunScope(left: SwarmRunScope, right: SwarmRunScope): boolean {
  return getSwarmRunScopeKey(left) === getSwarmRunScopeKey(right);
}

function getCheckpointIdentity(identity: ParallelCheckpointIdentity): {
  sessionId: string;
  runId?: string;
  treeId?: string;
  fileName: string;
} {
  if (typeof identity === 'string') {
    const safeLegacyName = (
      identity !== '.'
      && identity !== '..'
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/.test(identity)
    )
      ? identity
      : `legacy-${getCheckpointDigest(identity)}`;
    return { sessionId: identity, fileName: safeLegacyName };
  }
  return {
    ...identity,
    // Fixed-length hash avoids path traversal, Windows-invalid characters and
    // unbounded filenames when external session labels are unusually long.
    fileName: `run-${getCheckpointDigest(getSwarmRunScopeKey(identity))}`,
  };
}

function getParallelCheckpointPath(identity: ParallelCheckpointIdentity): string {
  const checkpointIdentity = getCheckpointIdentity(identity);
  return path.join(
    getUserConfigDir(),
    COORDINATION_CHECKPOINTS.PARALLEL_DIR,
    `${checkpointIdentity.fileName}.json`
  );
}

const DEFAULT_CONFIG: CoordinatorConfig = {
  maxParallelTasks: 4,
  taskTimeout: AGENT_TIMEOUTS.PARALLEL_TASK,
  enableSharedContext: true,
  aggregateResults: true,
};

// ============================================================================
// ParallelAgentCoordinator
// ============================================================================

export class ParallelAgentCoordinator extends EventEmitter {
  private config: CoordinatorConfig;
  private runningTasks: Map<string, Promise<AgentTaskResult>> = new Map();
  private completedTasks: Map<string, AgentTaskResult> = new Map();
  private abortControllers: Map<string, AbortController> = new Map();
  private taskDefinitions: Map<string, AgentTask> = new Map();
  private messageQueues: Map<string, AgentMessage[]> = new Map();
  private cancelled = false;
  private cancelReason = 'cancelled';
  private sharedContext: SharedContext;
  private modelConfig?: ModelConfig;
  private toolResolver?: ToolResolver;
  private toolContext?: ToolContext;
  private subagentExecutor?: SubagentExecutorPort;
  private scope?: SwarmRunScope;
  private initialized = false;
  private executionActive = false;
  private readonly legacyLifecycle: boolean;
  /** Fire-and-forget persist 的串行链，保证 delete/drain 能排干所有 in-flight save */
  private pendingPersist: Promise<void> = Promise.resolve();

  constructor(config: Partial<CoordinatorConfig> = {}, scope?: SwarmRunScope) {
    super();
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.scope = scope ? { ...scope } : undefined;
    this.legacyLifecycle = !scope || isLegacyCoordinatorScope(scope);
    this.sharedContext = {
      findings: new Map(),
      files: new Map(),
      decisions: new Map(),
      errors: [],
      lastUpdated: new Map(),
    };
  }

  /**
   * Initialize coordinator with execution context
   */
  initialize(context: {
    modelConfig: ModelConfig;
    toolResolver: ToolResolver;
    toolContext: ToolContext;
    subagentExecutor?: SubagentExecutorPort;
    scope?: SwarmRunScope;
  }): void {
    if (this.initialized) {
      throw new Error('Coordinator is already initialized; create a new run-scoped instance instead of replacing dependencies.');
    }
    const ownsExplicitScope = Boolean(this.scope && !isLegacyCoordinatorScope(this.scope));
    if (ownsExplicitScope && this.scope && context.scope && !isSameRunScope(this.scope, context.scope)) {
      throw new Error('Coordinator scope cannot be changed after creation.');
    }
    if (this.scope && isLegacyCoordinatorScope(this.scope) && context.scope) {
      throw new Error('Legacy coordinator cannot adopt a run scope; request the run-scoped coordinator from the registry.');
    }
    const resolvedScope = ownsExplicitScope ? this.scope : context.scope;
    if (
      resolvedScope
      && context.toolContext.sessionId
      && context.toolContext.sessionId !== resolvedScope.sessionId
    ) {
      throw new Error('Coordinator tool context sessionId does not match its run scope.');
    }
    if (!this.scope && context.scope) {
      this.scope = { ...context.scope };
    }
    this.modelConfig = context.modelConfig;
    this.toolResolver = context.toolResolver;
    this.toolContext = context.toolContext;
    this.subagentExecutor = context.subagentExecutor;
    this.initialized = true;
  }

  setSubagentExecutor(executor: SubagentExecutorPort): void {
    if (this.subagentExecutor && this.subagentExecutor !== executor) {
      throw new Error('Coordinator subagent executor cannot be replaced after initialization.');
    }
    this.subagentExecutor = executor;
  }

  getScope(): SwarmRunScope | undefined {
    return this.scope ? { ...this.scope } : undefined;
  }

  isInitialized(): boolean {
    return this.initialized;
  }

  isExecuting(): boolean {
    return this.executionActive;
  }

  private async getSubagentExecutor(): Promise<SubagentExecutorPort> {
    if (this.subagentExecutor) return this.subagentExecutor;
    const { getSubagentExecutor } = await import('./subagentExecutor');
    return getSubagentExecutor();
  }

  /**
   * Execute multiple agent tasks in parallel with dependency resolution
   */
  async executeParallel(tasks: AgentTask[]): Promise<ParallelExecutionResult> {
    if (this.executionActive) {
      throw new Error('ParallelAgentCoordinator is not reentrant; create a distinct run-scoped coordinator for nested parallel execution.');
    }
    this.executionActive = true;
    try {
      return await this.executeParallelInternal(tasks);
    } finally {
      this.executionActive = false;
    }
  }

  private async executeParallelInternal(tasks: AgentTask[]): Promise<ParallelExecutionResult> {
    if (!this.modelConfig || !this.toolResolver || !this.toolContext) {
      throw new Error('Coordinator not initialized. Call initialize() first.');
    }

    const startTime = Date.now();
    const results: AgentTaskResult[] = [];
    const errors: Array<{ taskId: string; error: string }> = [];
    let maxConcurrent = 0;
    const successful = new Set<string>();
    const failedOrBlocked = new Set<string>();
    const remaining = new Map<string, AgentTask>();

    if (this.toolContext.abortSignal?.aborted) {
      this.cancelled = true;
      this.cancelReason = typeof this.toolContext.abortSignal.reason === 'string'
        ? this.toolContext.abortSignal.reason
        : 'run_cancelled';
    } else if (!this.cancelled) {
      this.cancelReason = 'cancelled';
    }
    this.taskDefinitions.clear();
    this.messageQueues.clear();
    for (const task of tasks) {
      this.taskDefinitions.set(task.id, { ...task });
      this.messageQueues.set(task.id, []);
      remaining.set(task.id, { ...task });
    }

    while (remaining.size > 0) {
      if (this.cancelled) {
        for (const task of Array.from(remaining.values())) {
          const cancelled = this.createSkippedResult(
            task,
            `Cancelled before start (${this.cancelReason})`,
            'cancelled',
            agentFailureCodeFromCancellationReason(this.cancelReason) ?? AgentFailureCode.CancelledByUser,
          );
          remaining.delete(task.id);
          results.push(cancelled);
          errors.push({ taskId: cancelled.taskId, error: cancelled.error || 'Cancelled' });
          failedOrBlocked.add(task.id);
          this.completedTasks.set(task.id, cancelled);
          this.emit('task:complete', { taskId: task.id, result: cancelled });
        }
        break;
      }

      const blocked = Array.from(remaining.values()).filter((task) => {
        const deps = task.dependsOn || [];
        return deps.some((dep) => failedOrBlocked.has(dep))
          || deps.some((dep) => !this.taskDefinitions.has(dep) && !successful.has(dep));
      });

      for (const task of blocked) {
        const deps = task.dependsOn || [];
        const missing = deps.filter((dep) => !this.taskDefinitions.has(dep) && !successful.has(dep));
        const failed = deps.filter((dep) => failedOrBlocked.has(dep));
        const reason = missing.length > 0
          ? `Blocked by missing dependencies: ${missing.join(', ')}`
          : `Blocked by failed dependencies: ${failed.join(', ')}`;
        const blockedResult = this.createSkippedResult(
          task,
          reason,
          'blocked',
          missing.length > 0 ? AgentFailureCode.DependencyMissing : AgentFailureCode.DependencyFailed,
        );
        remaining.delete(task.id);
        results.push(blockedResult);
        errors.push({ taskId: blockedResult.taskId, error: blockedResult.error || reason });
        failedOrBlocked.add(task.id);
        this.completedTasks.set(task.id, blockedResult);
        if (this.config.enableSharedContext) {
          this.updateSharedContext(blockedResult);
        }
        this.emit('task:complete', { taskId: task.id, result: blockedResult });
      }

      if (remaining.size === 0) break;

      const ready = Array.from(remaining.values())
        .filter((task) => (task.dependsOn || []).every((dep) => successful.has(dep)))
        .sort((a, b) => (b.priority || 0) - (a.priority || 0));

      if (ready.length === 0) {
        logger.warn('Circular or unsatisfied dependency detected');
        for (const task of Array.from(remaining.values())) {
          const reason = `Blocked by unsatisfied dependencies: ${(task.dependsOn || []).join(', ') || 'unknown'}`;
          const blockedResult = this.createSkippedResult(
            task,
            reason,
            'blocked',
            AgentFailureCode.DependencyFailed,
          );
          remaining.delete(task.id);
          results.push(blockedResult);
          errors.push({ taskId: blockedResult.taskId, error: blockedResult.error || reason });
          failedOrBlocked.add(task.id);
          this.completedTasks.set(task.id, blockedResult);
          if (this.config.enableSharedContext) {
            this.updateSharedContext(blockedResult);
          }
          this.emit('task:complete', { taskId: task.id, result: blockedResult });
        }
        break;
      }

      const taskGroup = ready.slice(0, this.config.maxParallelTasks);
      for (const task of taskGroup) {
        remaining.delete(task.id);
      }
      maxConcurrent = Math.max(maxConcurrent, taskGroup.length);

      const groupResults = await this.executeTaskGroup(taskGroup);

      for (const result of groupResults) {
        results.push(result);
        this.completedTasks.set(result.taskId, result);

        if (result.success) {
          successful.add(result.taskId);
          if (this.config.enableSharedContext) {
            this.updateSharedContext(result);
          }
        } else {
          errors.push({ taskId: result.taskId, error: result.error || 'Unknown error' });
          failedOrBlocked.add(result.taskId);
          if (this.config.enableSharedContext) {
            this.updateSharedContext(result);
          }
        }
      }
    }

    const totalDuration = Date.now() - startTime;

    // Aggregate results if enabled
    const aggregatedResults = this.config.aggregateResults
      ? this.aggregateResults(results)
      : results;

    // 全部成功则清掉 checkpoint（对称 autoAgentCoordinator 的 deleteCheckpoint），
    // 失败则排干 in-flight save，保证快照确实落到盘上再返回
    if (errors.length === 0) {
      await this.deleteCheckpointIfPresent();
    } else {
      this.schedulePersist();
      await this.drainPersist();
    }

    this.emit('all:complete', { results: aggregatedResults, errors });

    return {
      success: errors.length === 0,
      results: aggregatedResults,
      totalDuration,
      parallelism: maxConcurrent,
      errors,
    };
  }

  /**
   * Execute a group of tasks in parallel
   */
  private async executeTaskGroup(tasks: AgentTask[]): Promise<AgentTaskResult[]> {
    const promises = tasks.map(task => this.executeTask(task));
    return Promise.all(promises);
  }

  /**
   * Execute a single task with timeout
   */
  private async executeTask(task: AgentTask): Promise<AgentTaskResult> {
    const modelConfig = this.modelConfig;
    const toolResolver = this.toolResolver;
    const toolContext = this.toolContext;

    if (!modelConfig || !toolResolver || !toolContext) {
      throw new Error('Coordinator not initialized. Call initialize() first.');
    }

    // Checkpoint hit: 成功节点短路，不重新执行（对称 autoAgentCoordinator）
    const cached = this.completedTasks.get(task.id);
    if (cached?.success) {
      logger.info(`Checkpoint hit, skipping parallel task: ${task.id}`);
      this.emit('task:start', { taskId: task.id, role: task.role });
      this.emit('task:complete', { taskId: task.id, result: cached });
      return cached;
    }

    const startTime = Date.now();
    let slotLease: { release: () => void } | undefined;
    const treeId = this.scope?.treeId || toolContext.spawnTreeId || toolContext.sessionId || 'default';
    const guard = getSpawnGuard();
    const taskAbortController = new AbortController();
    const parentAbortSignal = toolContext.abortSignal;
    const abortFromParent = () => {
      if (!taskAbortController.signal.aborted) {
        taskAbortController.abort(parentAbortSignal?.reason ?? 'parent_cancelled');
      }
    };

    this.abortControllers.set(task.id, taskAbortController);
    if (this.cancelled) {
      taskAbortController.abort(this.cancelReason);
    } else if (parentAbortSignal?.aborted) {
      abortFromParent();
    } else {
      parentAbortSignal?.addEventListener('abort', abortFromParent, { once: true });
    }

    const throwIfCancelledBeforeExecutor = (): void => {
      if (!this.cancelled && !parentAbortSignal?.aborted && !taskAbortController.signal.aborted) {
        return;
      }
      const reason = taskAbortController.signal.reason
        ?? parentAbortSignal?.reason
        ?? this.cancelReason
        ?? 'run_cancelled';
      if (!taskAbortController.signal.aborted) {
        taskAbortController.abort(reason);
      }
      throw new Error(`Task cancelled before executor start (${String(reason)})`);
    };

    try {
      slotLease = await guard.acquireSlot({
        treeId,
        scope: this.scope,
        timeoutMs: toolContext.spawnQueueTimeoutMs,
        signal: taskAbortController.signal,
      });

      throwIfCancelledBeforeExecutor();
      // Execute task
      const executor = await this.getSubagentExecutor();
      throwIfCancelledBeforeExecutor();
      this.emit('task:start', { taskId: task.id, role: task.role });

      // Inject shared context into system prompt if available
      let enhancedPrompt = task.systemPrompt || '';
      if (this.config.enableSharedContext && this.sharedContext.findings.size > 0) {
        enhancedPrompt += this.formatSharedContextForPrompt();
      }

      const executionPromise = executor.execute(
        task.task,
        {
          name: task.role,
          // 持久化角色资产绑定 key（并行路径下 role 即 agent 注册 id）
          roleId: task.role,
          systemPrompt: enhancedPrompt,
          availableTools: task.tools,
          maxIterations: task.maxIterations || 20,
        },
        {
          modelConfig,
          toolResolver,
          // 注入 task.id 到 toolContext，让 BrowserPool / ComputerSurface 按 agentId 隔离。
          // 共享 toolContext 不能直接 mutate（其他 task 也用），clone 后注入。
          toolContext: {
            ...toolContext,
            agentId: task.id,
            spawnParentStartedAt: toolContext.spawnParentStartedAt,
            spawnParentTimeoutMs: toolContext.spawnParentTimeoutMs,
            parentRemainingBudget: toolContext.parentRemainingBudget,
            spawnParentAgentId: toolContext.spawnParentAgentId,
          },
          parentToolUseId: toolContext.currentToolCallId,
          executionAgentId: task.id,
          spawnGuardId: task.id,
          abortSignal: taskAbortController.signal,
          messageDrain: () => this.drainMessages(task.id),
          onContextSnapshot: (snapshot) => {
            this.emit('task:progress', {
              taskId: task.id,
              role: task.role,
              snapshot,
            } satisfies TaskProgressEvent);
          },
          hookManager: toolContext.hookManager,
          parentRemainingBudget: toolContext.parentRemainingBudget,
        }
      );
      guard.register(task.id, task.role, task.task, executionPromise, taskAbortController, {
        treeId,
        parentId: toolContext.spawnParentAgentId,
        slotAcquired: true,
        scope: this.scope,
      });
      slotLease = undefined;

      // Execute with timeout (auto-cleanup of timer)
      this.runningTasks.set(task.id, executionPromise.then((result) => ({
        ...result,
        taskId: task.id,
        role: task.role,
        startTime,
        endTime: Date.now(),
        duration: Date.now() - startTime,
      })));

      const result = await withTimeout(
        executionPromise,
        this.config.taskTimeout,
        'Task timeout'
      );

      const endTime = Date.now();

      const taskResult: AgentTaskResult = {
        ...result,
        taskId: task.id,
        role: task.role,
        startTime,
        endTime,
        duration: endTime - startTime,
        cancelled: this.isCancellationError(result.error),
        failureCode: result.success
          ? undefined
          : inferAgentFailureCode({
              failureCode: result.failureCode,
              cancellationReason: result.cancellationReason,
              error: result.error,
            }),
      };

      this.emit('task:complete', { taskId: task.id, result: taskResult });
      this.completedTasks.set(task.id, taskResult);
      this.abortControllers.delete(task.id);
      this.runningTasks.delete(task.id);

      this.schedulePersist();

      return taskResult;
    } catch (error) {
      const endTime = Date.now();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!taskAbortController.signal.aborted) {
        taskAbortController.abort(errorMessage.includes('timeout') ? 'timeout' : 'child-error');
      }
      guard.cancelDescendants(task.id, 'parent-cancel');

      this.emit('task:error', { taskId: task.id, error: errorMessage });
      this.abortControllers.delete(task.id);
      this.runningTasks.delete(task.id);

      const failedResult: AgentTaskResult = {
        success: false,
        output: '',
        error: errorMessage,
        toolsUsed: [],
        iterations: 0,
        taskId: task.id,
        role: task.role,
        startTime,
        endTime,
        duration: endTime - startTime,
        cancelled: this.isCancellationError(errorMessage),
        failureCode: inferAgentFailureCode({
          cancellationReason: taskAbortController.signal.reason,
          error: errorMessage,
          defaultCode: AgentFailureCode.ModelError,
        }),
      };
      this.completedTasks.set(task.id, failedResult);

      this.schedulePersist();

      return failedResult;
    } finally {
      parentAbortSignal?.removeEventListener('abort', abortFromParent);
      slotLease?.release();
    }
  }

  /**
   * Update shared context from task result
   */
  private updateSharedContext(result: AgentTaskResult, at: number = Date.now()): void {
    // Extract findings from output (simple heuristic)
    const output = result.output.toLowerCase();

    // Look for file mentions
    const fileMatches = result.output.match(/(?:file|path)[:\s]+([^\s\n]+)/gi);
    if (fileMatches) {
      for (const match of fileMatches) {
        const path = match.replace(/(?:file|path)[:\s]+/i, '').trim();
        this.sharedContext.files.set(path, result.role);
        this.sharedContext.lastUpdated.set(path, at);
      }
    }

    // Look for key findings
    if (output.includes('found') || output.includes('discovered') || output.includes('issue')) {
      const findingKey = `${result.role}_${result.taskId}`;
      this.sharedContext.findings.set(
        findingKey,
        result.output.substring(0, 500)
      );
      this.sharedContext.lastUpdated.set(findingKey, at);
      this.emit('discovery', { taskId: result.taskId, role: result.role, finding: result.output.substring(0, 200), at });
    }

    // Track errors
    if (!result.success && result.error) {
      this.sharedContext.errors.push(`[${result.role}] ${result.error}`);
    }
  }

  /**
   * Format shared context for injection into prompts
   */
  private formatSharedContextForPrompt(): string {
    const parts: string[] = [];

    if (this.sharedContext.findings.size > 0) {
      parts.push('\n## Shared Discoveries from Other Agents:');
      for (const [key, value] of this.sharedContext.findings) {
        parts.push(`- [${key}]: ${value}`);
      }
    }

    if (this.sharedContext.files.size > 0) {
      parts.push('\n## Files Identified by Team:');
      for (const [path, agent] of this.sharedContext.files) {
        parts.push(`- ${path} (by ${agent})`);
      }
    }

    if (this.sharedContext.errors.length > 0) {
      parts.push('\n## Issues Encountered:');
      for (const error of this.sharedContext.errors) {
        parts.push(`- ${error}`);
      }
    }

    return parts.join('\n');
  }

  /**
   * Aggregate results from multiple agents
   * Deduplicates and prioritizes findings
   */
  private aggregateResults(results: AgentTaskResult[]): AgentTaskResult[] {
    // Simple aggregation - could be enhanced with smarter deduplication
    return results.sort((a, b) => {
      // Sort by success first, then by role priority
      if (a.success !== b.success) return a.success ? -1 : 1;
      // Architect > Coder > Reviewer > Tester > Others
      const rolePriority: Record<string, number> = {
        architect: 5,
        coder: 4,
        reviewer: 3,
        tester: 2,
        debugger: 2,
        documenter: 1,
      };
      return (rolePriority[b.role] || 0) - (rolePriority[a.role] || 0);
    });
  }

  /**
   * Share a finding with all agents
   * @param at 版本戳（ms epoch），未传时取 Date.now()。云端同步 / 回放场景应显式传入
   *           原始时间戳，保留真实新鲜度（与全局禁硬编码 Date.now() 的约定一致）。
   */
  shareDiscovery(key: string, value: unknown, at: number = Date.now()): void {
    this.sharedContext.findings.set(key, value);
    this.sharedContext.lastUpdated.set(key, at);
    this.emit('discovery', { key, value });
  }

  /**
   * 取某个 key 的最后更新时间戳（无记录返回 undefined）。
   */
  getLastUpdated(key: string): number | undefined {
    return this.sharedContext.lastUpdated.get(key);
  }

  /**
   * 判断某个共享 key 是否已过期（stale）。
   * 无版本戳的 key 保守判为 stale —— 没有新鲜度信息时，宁可让子代理重新核实
   * 而不是基于来历不明的 draft 决策（swarm 护栏 P1-2 #5）。
   */
  isStale(key: string, maxAgeMs: number, now: number = Date.now()): boolean {
    const ts = this.sharedContext.lastUpdated.get(key);
    if (ts === undefined) return true;
    return now - ts > maxAgeMs;
  }

  /**
   * Get shared context
   */
  getSharedContext(): SharedContext {
    return this.sharedContext;
  }

  /**
   * Export shared context for persistence
   */
  exportSharedContext(): {
    findings: Record<string, unknown>;
    files: Record<string, string>;
    decisions: Record<string, string>;
    errors: string[];
    lastUpdated: Record<string, number>;
  } {
    return {
      findings: Object.fromEntries(this.sharedContext.findings),
      files: Object.fromEntries(this.sharedContext.files),
      decisions: Object.fromEntries(this.sharedContext.decisions),
      errors: [...this.sharedContext.errors],
      lastUpdated: Object.fromEntries(this.sharedContext.lastUpdated),
    };
  }

  /**
   * Import shared context from persistence
   */
  importSharedContext(data: {
    findings?: Record<string, unknown>;
    files?: Record<string, string>;
    decisions?: Record<string, string>;
    errors?: string[];
    lastUpdated?: Record<string, number>;
  }): void {
    if (data.findings) {
      for (const [k, v] of Object.entries(data.findings)) {
        this.sharedContext.findings.set(k, v);
      }
    }
    if (data.files) {
      for (const [k, v] of Object.entries(data.files)) {
        this.sharedContext.files.set(k, v);
      }
    }
    if (data.decisions) {
      for (const [k, v] of Object.entries(data.decisions)) {
        this.sharedContext.decisions.set(k, v);
      }
    }
    if (data.errors) {
      this.sharedContext.errors.push(...data.errors);
    }
    // 保留原始版本戳（回放 / 跨会话恢复时维持真实新鲜度，不重新 stamp）
    if (data.lastUpdated) {
      for (const [k, ts] of Object.entries(data.lastUpdated)) {
        this.sharedContext.lastUpdated.set(k, ts);
      }
    }
  }

  /**
   * Clear shared context
   */
  clearSharedContext(): void {
    this.sharedContext = {
      findings: new Map(),
      files: new Map(),
      decisions: new Map(),
      errors: [],
      lastUpdated: new Map(),
    };
  }

  /**
   * Get running task status
   */
  getRunningTasks(): string[] {
    return Array.from(this.runningTasks.keys());
  }

  /**
   * Get completed task results
   */
  getCompletedTasks(): AgentTaskResult[] {
    return Array.from(this.completedTasks.values());
  }

  getTaskDefinition(taskId: string): AgentTask | undefined {
    const task = this.taskDefinitions.get(taskId);
    return task ? { ...task } : undefined;
  }

  getTaskSnapshots(): ParallelAgentTaskSnapshot[] {
    const taskIds = new Set<string>([
      ...this.taskDefinitions.keys(),
      ...this.runningTasks.keys(),
      ...this.completedTasks.keys(),
    ]);

    return Array.from(taskIds).map((taskId) => {
      const definition = this.taskDefinitions.get(taskId);
      const result = this.completedTasks.get(taskId);
      const running = this.runningTasks.has(taskId);
      const status: ParallelAgentTaskSnapshotStatus = running
        ? 'running'
        : result
          ? result.cancelled
            ? 'cancelled'
            : result.blocked
              ? 'blocked'
              : result.success
                ? 'completed'
                : 'failed'
          : 'pending';

      return {
        taskId,
        role: definition?.role ?? result?.role ?? 'agent',
        task: definition?.task ?? '',
        tools: definition ? [...definition.tools] : [],
        ...(definition?.dependsOn ? { dependsOn: [...definition.dependsOn] } : {}),
        status,
        ...(result ? { result: { ...result, toolsUsed: [...result.toolsUsed] } } : {}),
        ...(result?.error ? { error: result.error } : {}),
        ...(result?.failureCode ? { failureCode: result.failureCode } : {}),
        ...(result?.startTime ? { startedAt: result.startTime } : {}),
        ...(result?.endTime ? { completedAt: result.endTime } : {}),
        ...(typeof result?.duration === 'number' ? { duration: result.duration } : {}),
      };
    });
  }

  canReceiveMessage(taskId: string): boolean {
    return this.taskDefinitions.has(taskId) && !this.completedTasks.has(taskId);
  }

  sendMessage(taskId: string, message: string): boolean {
    if (!this.canReceiveMessage(taskId)) {
      return false;
    }

    const queue = this.messageQueues.get(taskId);
    if (!queue) {
      return false;
    }

    queue.push(createTextMessage('user', message));
    logger.info(`[${taskId}] Parallel message queued (queue size: ${queue.length})`);
    return true;
  }

  private drainMessages(taskId: string): AgentMessage[] {
    const queue = this.messageQueues.get(taskId);
    if (!queue || queue.length === 0) return [];
    const messages = [...queue];
    queue.length = 0;
    return messages;
  }

  /**
   * 非破坏性查看某 task 的待办消息（swarm 护栏 P1-2 #4 桥接用）。
   * 返回队列副本——不消费，drainMessages 仍能取到。
   */
  peekMessages(taskId: string): AgentMessage[] {
    const queue = this.messageQueues.get(taskId);
    return queue ? [...queue] : [];
  }

  private isCancellationError(errorMessage?: string): boolean {
    if (!errorMessage) return false;
    const normalized = errorMessage.toLowerCase();
    return normalized.includes('cancel') || normalized.includes('abort') || errorMessage.includes('取消');
  }

  private createSkippedResult(
    task: AgentTask,
    reason: string,
    type: 'blocked' | 'cancelled',
    failureCode: AgentFailureCode,
  ): AgentTaskResult {
    const now = Date.now();
    return {
      success: false,
      output: '',
      error: reason,
      toolsUsed: [],
      iterations: 0,
      taskId: task.id,
      role: task.role,
      startTime: now,
      endTime: now,
      duration: 0,
      blocked: type === 'blocked',
      cancelled: type === 'cancelled',
      failureCode,
    };
  }

  abortTask(taskId: string, reason = 'user_cancelled'): boolean {
    const controller = this.abortControllers.get(taskId);
    if (!controller || controller.signal.aborted) {
      return false;
    }

    logger.info(`Aborting parallel task ${taskId}: ${reason}`);
    controller.abort(reason);
    return true;
  }

  async retryTask(taskId: string): Promise<AgentTaskResult> {
    const task = this.taskDefinitions.get(taskId);
    if (!task) {
      throw new Error(`Task definition not found: ${taskId}`);
    }

    if (this.abortControllers.has(taskId)) {
      throw new Error(`Task is still running: ${taskId}`);
    }

    // 显式重试必须绕过 checkpoint cache-skip，否则上一轮的成功结果会短路
    this.completedTasks.delete(taskId);

    return this.executeTask({ ...task });
  }

  /**
   * Update configuration
   */
  updateConfig(config: Partial<CoordinatorConfig>): void {
    this.config = { ...this.config, ...config };
  }

  /**
   * Get current configuration
   */
  getConfig(): CoordinatorConfig {
    return { ...this.config };
  }

  /**
   * Abort all running tasks (graceful shutdown trigger)
   */
  abortAllRunning(reason = 'coordinator_shutdown'): void {
    this.cancelled = true;
    this.cancelReason = reason;
    for (const [taskId, controller] of this.abortControllers) {
      if (!controller.signal.aborted) {
        logger.info(`Aborting task ${taskId}: ${reason}`);
        controller.abort(reason);
      }
    }
  }

  /**
   * Reset coordinator state
   */
  reset(): void {
    this.abortAllRunning('reset');
    this.runningTasks.clear();
    this.completedTasks.clear();
    this.abortControllers.clear();
    this.taskDefinitions.clear();
    this.messageQueues.clear();
    this.cancelled = false;
    this.cancelReason = 'cancelled';
    this.clearSharedContext();
    this.removeAllListeners();
    this.executionActive = false;
    if (this.legacyLifecycle) {
      this.modelConfig = undefined;
      this.toolResolver = undefined;
      this.toolContext = undefined;
      this.subagentExecutor = undefined;
      this.initialized = false;
    }
  }

  // ============================================================================
  // DAG-based Execution (New in Session 4)
  // ============================================================================

  /**
   * Execute tasks using the new DAG scheduler
   * Provides better dependency handling and parallel scheduling
   */
  async executeWithDAG(tasks: AgentTask[]): Promise<ParallelExecutionResult> {
    if (!this.modelConfig || !this.toolResolver || !this.toolContext) {
      throw new Error('Coordinator not initialized. Call initialize() first.');
    }

    // Create DAG from tasks
    const dag = new TaskDAG(
      `parallel_${Date.now()}`,
      'Parallel Agent Execution',
      {
        maxParallelism: this.config.maxParallelTasks,
        defaultTimeout: this.config.taskTimeout,
        enableOutputPassing: this.config.enableSharedContext,
        enableSharedContext: this.config.enableSharedContext,
        failureStrategy: 'continue',
      }
    );

    // Add tasks to DAG
    for (const task of tasks) {
      dag.addAgentTask(
        task.id,
        {
          role: task.role,
          prompt: task.task,
          systemPrompt: task.systemPrompt,
          tools: task.tools,
          maxIterations: task.maxIterations,
        },
        {
          name: task.role,
          dependencies: task.dependsOn,
          priority: task.priority === undefined ? 'normal' :
            task.priority >= 3 ? 'critical' :
            task.priority >= 2 ? 'high' :
            task.priority >= 1 ? 'normal' : 'low',
        }
      );
    }

    // Validate DAG
    const validation = dag.validate();
    if (!validation.valid) {
      logger.error('DAG validation failed', { errors: validation.errors });
      throw new Error(`Invalid DAG: ${validation.errors.join(', ')}`);
    }

    // Checkpoint restore: 把已完成节点预喂给 DAG，scheduler 主循环走 getReadyTasks
    // 自然跳过 terminal 节点。事件转发在 scheduler.execute 内 forwardDAGEvents 之后
    // 才接管，预喂阶段触发的 task:completed 事件不会外泄
    for (const task of tasks) {
      const cached = this.completedTasks.get(task.id);
      if (!cached?.success) continue;
      dag.completeTask(task.id, {
        text: cached.output,
        toolsUsed: cached.toolsUsed,
        iterations: cached.iterations,
      });
      // completeTask 把 metadata.completedAt 写成 now、duration 留空。
      // 用 cached 的原始时间戳覆盖回去，让 convertSchedulerResult 还原历史值
      const dagTask = dag.getTask(task.id);
      if (dagTask) {
        dagTask.metadata.startedAt = cached.startTime;
        dagTask.metadata.completedAt = cached.endTime;
        dagTask.metadata.duration = cached.duration;
      }
    }

    // Get scheduler and execute
    const scheduler = createRunDAGScheduler({
      maxParallelism: this.config.maxParallelTasks,
      defaultTimeout: this.config.taskTimeout,
      enableOutputPassing: this.config.enableSharedContext,
    });
    if (this.subagentExecutor && 'setSubagentExecutor' in scheduler) {
      scheduler.setSubagentExecutor(this.subagentExecutor);
    }
    const result = await scheduler.execute(dag, {
      modelConfig: this.modelConfig,
      toolResolver: this.toolResolver,
      toolContext: this.toolContext,
      workingDirectory: process.cwd(),
    });

    // Convert scheduler result to coordinator result format
    const converted = await this.convertSchedulerResult(result);
    await this.drainPersist();
    return converted;
  }

  /**
   * Convert DAG scheduler result to coordinator result format
   */
  private async convertSchedulerResult(result: SchedulerResult): Promise<ParallelExecutionResult> {
    const dagTasks = result.dag.getAllTasks();
    const results: AgentTaskResult[] = [];
    const errors: Array<{ taskId: string; error: string }> = [];

    for (const task of dagTasks) {
      const taskResult: AgentTaskResult = {
        success: task.status === 'completed',
        output: task.output?.text || '',
        error: task.failure?.message,
        toolsUsed: task.output?.toolsUsed || [],
        iterations: task.output?.iterations || 0,
        taskId: task.id,
        role: task.config.type === 'agent' ? (task.config as { role: string }).role : task.name,
        startTime: task.metadata.startedAt || 0,
        endTime: task.metadata.completedAt || 0,
        duration: task.metadata.duration || 0,
        failureCode: task.status === 'completed'
          ? undefined
          : inferAgentFailureCode({
              failureCode: (task.failure as { failureCode?: unknown } | undefined)?.failureCode,
              error: task.failure?.message,
              defaultCode: AgentFailureCode.ModelError,
            }),
      };

      if (taskResult.success) {
        results.push(taskResult);
        this.completedTasks.set(task.id, taskResult);

        // Update shared context
        if (this.config.enableSharedContext) {
          this.updateSharedContext(taskResult);
        }
      } else if (task.failure) {
        results.push(taskResult);
        this.completedTasks.set(task.id, taskResult);
        errors.push({ taskId: task.id, error: task.failure.message });
      }
    }

    // DAG 路径在 scheduler 内部完成后批量 save 一次（scheduler 不直接调 save）
    if (errors.length === 0) {
      await this.deleteCheckpointIfPresent();
    } else {
      this.schedulePersist();
    }

    // Aggregate results
    const aggregatedResults = this.config.aggregateResults
      ? this.aggregateResults(results)
      : results;

    return {
      success: result.success,
      results: aggregatedResults,
      totalDuration: result.totalDuration,
      parallelism: result.maxParallelism,
      errors,
    };
  }

  // ============================================================================
  // Checkpoint 持久化（ADR-010 item #3）
  // ============================================================================

  /**
   * 落盘当前 coordinator 状态到 JSON 快照。
   *
   * 存储路径: ~/.code-agent/parallel-coordination-checkpoints/<sessionId>.json
   *
   * - Map 字段序列化成 entries 数组
   * - Promise / AbortController / ToolContext 不入快照
   * - 失败安静 warn（checkpoint 是 best-effort，不能拖累主流程）
   */
  async persistCheckpoint(identity?: ParallelCheckpointIdentity): Promise<void> {
    const resolvedIdentity = this.resolveCheckpointIdentity(identity);
    if (!resolvedIdentity) return;
    if (!this.ownsCheckpointIdentity(resolvedIdentity)) {
      throw new Error('Checkpoint identity does not match coordinator run scope.');
    }
    const checkpointIdentity = getCheckpointIdentity(resolvedIdentity);
    if (!checkpointIdentity.sessionId) {
      return;
    }

    const filePath = getParallelCheckpointPath(resolvedIdentity);
    const now = Date.now();

    const snapshot: ParallelCheckpoint = {
      version: COORDINATION_CHECKPOINTS.SCHEMA_VERSION,
      sessionId: checkpointIdentity.sessionId,
      runId: checkpointIdentity.runId,
      treeId: checkpointIdentity.treeId,
      createdAt: now,
      updatedAt: now,
      taskDefinitions: Array.from(this.taskDefinitions.entries()),
      completedTasks: Array.from(this.completedTasks.entries()),
      runningTaskIds: Array.from(this.runningTasks.keys()),
      sharedContext: this.exportSharedContext(),
    };

    try {
      await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
      await fsPromises.writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf-8');
    } catch (error) {
      logger.warn('Failed to persist parallel coordinator checkpoint', { error, filePath });
    }
  }

  /**
   * 从 JSON 快照重建 coordinator 状态。
   *
   * 重建语义（对齐 spawnGuard.restoreState / ADR-010 #3）：
   * - completedTasks / taskDefinitions / sharedContext 原样恢复
   * - runningTaskIds 不进 completedTasks —— 凭借"不存在于 completedTasks"
   *   触发下一次 executeParallel 的重新调度
   * - abortControllers 与 runningTasks 在新 coordinator 实例上为空
   * - version 不匹配 → 视为 stale，返回 false 并忽略快照
   * - 文件不存在 / JSON 损坏 → 返回 false，不抛
   */
  async restoreCheckpoint(identity?: ParallelCheckpointIdentity): Promise<boolean> {
    const resolvedIdentity = this.resolveCheckpointIdentity(identity);
    if (!resolvedIdentity || !this.ownsCheckpointIdentity(resolvedIdentity)) {
      logger.warn('Parallel checkpoint identity does not match coordinator run scope, ignoring');
      return false;
    }
    const checkpointIdentity = getCheckpointIdentity(resolvedIdentity);
    if (!checkpointIdentity.sessionId) {
      return false;
    }

    const filePath = getParallelCheckpointPath(resolvedIdentity);
    let raw: string;
    try {
      raw = await fsPromises.readFile(filePath, 'utf-8');
    } catch {
      return false;
    }

    let snapshot: ParallelCheckpoint;
    try {
      snapshot = JSON.parse(raw) as ParallelCheckpoint;
    } catch (error) {
      logger.warn('Parallel checkpoint JSON corrupted, ignoring', { error, filePath });
      return false;
    }

    if (snapshot.version !== COORDINATION_CHECKPOINTS.SCHEMA_VERSION) {
      logger.info('Parallel checkpoint schema version mismatch, ignoring', {
        expected: COORDINATION_CHECKPOINTS.SCHEMA_VERSION,
        actual: snapshot.version,
      });
      return false;
    }

    if (
      typeof resolvedIdentity !== 'string'
      && (
        snapshot.sessionId !== resolvedIdentity.sessionId
        || snapshot.runId !== resolvedIdentity.runId
        || snapshot.treeId !== resolvedIdentity.treeId
      )
    ) {
      logger.warn('Parallel checkpoint scope mismatch, ignoring', {
        expected: resolvedIdentity,
        actual: {
          sessionId: snapshot.sessionId,
          runId: snapshot.runId,
          treeId: snapshot.treeId,
        },
      });
      return false;
    }

    // 恢复 taskDefinitions
    this.taskDefinitions.clear();
    for (const [id, task] of snapshot.taskDefinitions ?? []) {
      this.taskDefinitions.set(id, task);
    }

    // 恢复 completedTasks（包括失败记录——guard 只短路 success 项）
    this.completedTasks.clear();
    for (const [id, result] of snapshot.completedTasks ?? []) {
      this.completedTasks.set(id, result);
    }

    // 恢复 sharedContext
    this.clearSharedContext();
    if (snapshot.sharedContext) {
      this.importSharedContext(snapshot.sharedContext);
    }

    logger.info('Parallel coordinator checkpoint restored', {
      sessionId: checkpointIdentity.sessionId,
      runId: checkpointIdentity.runId,
      taskDefinitions: this.taskDefinitions.size,
      completedTasks: this.completedTasks.size,
      runningAtCrash: snapshot.runningTaskIds?.length ?? 0,
    });

    return true;
  }

  /**
   * 成功收尾后清掉 checkpoint 文件。缺失视为已清理，不告警。
   */
  async deleteCheckpoint(identity?: ParallelCheckpointIdentity): Promise<void> {
    const resolvedIdentity = this.resolveCheckpointIdentity(identity);
    if (!resolvedIdentity) return;
    if (!this.ownsCheckpointIdentity(resolvedIdentity)) {
      throw new Error('Checkpoint identity does not match coordinator run scope.');
    }
    const checkpointIdentity = getCheckpointIdentity(resolvedIdentity);
    if (!checkpointIdentity.sessionId) {
      return;
    }
    const filePath = getParallelCheckpointPath(resolvedIdentity);
    try {
      await fsPromises.unlink(filePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        logger.warn('Failed to delete parallel checkpoint', { error, filePath });
      }
    }
  }

  /**
   * Fire-and-forget 的 persist 封装。在节点完成点调用，不 await。
   *
   * 串行到 pendingPersist 链上（而不是裸 void），这样 drainPersist 能在
   * executeParallel 收尾时排干所有 in-flight save，避免 save 与 delete
   * 竞争导致"全部成功后 checkpoint 仍然存在"。
   */
  private schedulePersist(): void {
    if (!this.resolveCheckpointIdentity()) {
      return;
    }
    this.pendingPersist = this.pendingPersist
      .catch(() => undefined)
      .then(() => this.persistCheckpoint());
  }

  /**
   * 等排队的 schedulePersist 全部落盘后再继续。
   */
  private async drainPersist(): Promise<void> {
    await this.pendingPersist.catch(() => undefined);
  }

  private async deleteCheckpointIfPresent(): Promise<void> {
    if (!this.resolveCheckpointIdentity()) {
      return;
    }
    await this.drainPersist();
    await this.deleteCheckpoint();
  }

  private resolveCheckpointIdentity(
    identity?: ParallelCheckpointIdentity,
  ): ParallelCheckpointIdentity | undefined {
    if (identity !== undefined) return identity;
    if (this.scope && !isLegacyCoordinatorScope(this.scope)) return this.scope;
    return this.toolContext?.sessionId;
  }

  private ownsCheckpointIdentity(identity: ParallelCheckpointIdentity): boolean {
    if (!this.scope || isLegacyCoordinatorScope(this.scope)) return true;
    return typeof identity !== 'string' && isSameRunScope(this.scope, identity);
  }
}

const LEGACY_COORDINATOR_SCOPE: SwarmRunScope = {
  sessionId: '__legacy__',
  runId: '__legacy__',
  treeId: '__legacy__',
};

function isLegacyCoordinatorScope(scope: SwarmRunScope): boolean {
  return isSameRunScope(scope, LEGACY_COORDINATOR_SCOPE);
}

/** Explicit scope container. The container is process-wide; mutable run state is not. */
export class ParallelAgentCoordinatorRegistry {
  private static readonly MAX_COMPLETED_SNAPSHOTS = 100;
  private coordinators = new Map<string, ParallelAgentCoordinator>();
  private completedSnapshots = new Map<string, CompletedParallelCoordinatorSnapshot>();

  private assertRunTreeInvariant(scope: SwarmRunScope): void {
    for (const coordinator of this.coordinators.values()) {
      const existing = coordinator.getScope();
      if (
        existing?.sessionId === scope.sessionId
        && existing.runId === scope.runId
        && existing.treeId !== scope.treeId
      ) {
        throw new Error(
          `Coordinator run ${scope.sessionId}/${scope.runId} is already bound to tree ${existing.treeId}.`,
        );
      }
    }
    for (const snapshot of this.completedSnapshots.values()) {
      if (
        snapshot.scope.sessionId === scope.sessionId
        && snapshot.scope.runId === scope.runId
        && snapshot.scope.treeId !== scope.treeId
      ) {
        throw new Error(
          `Coordinator run ${scope.sessionId}/${scope.runId} is already terminal on tree ${snapshot.scope.treeId}.`,
        );
      }
    }
  }

  get(scope: SwarmRunScope): ParallelAgentCoordinator | undefined {
    return this.coordinators.get(getSwarmRunScopeKey(scope));
  }

  getByRun(ref: SwarmRunRef): ParallelAgentCoordinator | undefined {
    for (const coordinator of this.coordinators.values()) {
      const scope = coordinator.getScope();
      if (scope?.sessionId === ref.sessionId && scope.runId === ref.runId) {
        return coordinator;
      }
    }
    return undefined;
  }

  getOrCreate(
    scope: SwarmRunScope,
    config: Partial<CoordinatorConfig> = {},
  ): ParallelAgentCoordinator {
    this.assertRunTreeInvariant(scope);
    const key = getSwarmRunScopeKey(scope);
    if (this.completedSnapshots.has(key)) {
      throw new Error(`Coordinator run ${scope.sessionId}/${scope.runId} is already terminal.`);
    }
    let coordinator = this.coordinators.get(key);
    if (!coordinator) {
      coordinator = new ParallelAgentCoordinator(config, scope);
      this.coordinators.set(key, coordinator);
    }
    return coordinator;
  }

  replace(
    scope: SwarmRunScope,
    config: Partial<CoordinatorConfig> = {},
  ): ParallelAgentCoordinator {
    this.assertRunTreeInvariant(scope);
    const key = getSwarmRunScopeKey(scope);
    if (this.completedSnapshots.has(key)) {
      throw new Error(`Coordinator run ${scope.sessionId}/${scope.runId} is already terminal.`);
    }
    const previous = this.coordinators.get(key);
    previous?.reset();
    const coordinator = new ParallelAgentCoordinator(config, scope);
    this.coordinators.set(key, coordinator);
    return coordinator;
  }

  abortRun(ref: SwarmRunRef, reason = 'run_cancelled'): boolean {
    let aborted = false;
    for (const coordinator of this.coordinators.values()) {
      const scope = coordinator.getScope();
      if (scope?.sessionId !== ref.sessionId || scope.runId !== ref.runId) continue;
      coordinator.abortAllRunning(reason);
      aborted = true;
    }
    return aborted;
  }

  abortSession(sessionId: string, reason = 'session_cancelled'): number {
    let aborted = 0;
    for (const coordinator of this.coordinators.values()) {
      if (coordinator.getScope()?.sessionId !== sessionId) continue;
      coordinator.abortAllRunning(reason);
      aborted += 1;
    }
    return aborted;
  }

  finalize(
    scope: SwarmRunScope,
    status: ParallelCoordinatorTerminalStatus,
    completedAt = Date.now(),
  ): CompletedParallelCoordinatorSnapshot | undefined {
    const key = getSwarmRunScopeKey(scope);
    const existing = this.completedSnapshots.get(key);
    if (existing) return existing;

    const coordinator = this.coordinators.get(key);
    if (!coordinator) return undefined;

    const tasks = coordinator.getTaskSnapshots().map((task) => Object.freeze({
      taskId: task.taskId,
      role: task.role,
      status: task.status,
      ...(task.error ? { error: task.error } : {}),
      ...(task.failureCode ? { failureCode: task.failureCode } : {}),
      ...(task.startedAt ? { startedAt: task.startedAt } : {}),
      ...(task.completedAt ? { completedAt: task.completedAt } : {}),
      ...(typeof task.duration === 'number' ? { duration: task.duration } : {}),
    }));
    const snapshot = Object.freeze({
      scope: Object.freeze({ ...scope }),
      status,
      completedAt,
      tasks: Object.freeze(tasks),
    });

    // Remove the mutable execution object before exposing terminal history.
    // In-flight code may still hold its local reference until its promise
    // settles, but no new control-plane lookup can reach it.
    this.coordinators.delete(key);
    this.completedSnapshots.set(key, snapshot);
    while (this.completedSnapshots.size > ParallelAgentCoordinatorRegistry.MAX_COMPLETED_SNAPSHOTS) {
      const oldestKey = this.completedSnapshots.keys().next().value as string | undefined;
      if (!oldestKey) break;
      this.completedSnapshots.delete(oldestKey);
    }
    return snapshot;
  }

  getCompleted(ref: SwarmRunRef): CompletedParallelCoordinatorSnapshot | undefined {
    for (const snapshot of this.completedSnapshots.values()) {
      if (snapshot.scope.sessionId === ref.sessionId && snapshot.scope.runId === ref.runId) {
        return snapshot;
      }
    }
    return undefined;
  }

  /** Global shutdown only. Run/user cancellation must use abortRun/abortSession. */
  abortAll(reason = 'app_shutdown'): number {
    let aborted = 0;
    for (const coordinator of this.coordinators.values()) {
      coordinator.abortAllRunning(reason);
      aborted += 1;
    }
    return aborted;
  }

  delete(scope: SwarmRunScope, reset = false): boolean {
    const key = getSwarmRunScopeKey(scope);
    const coordinator = this.coordinators.get(key);
    if (!coordinator) return false;
    if (reset) coordinator.reset();
    return this.coordinators.delete(key);
  }

  clear(): void {
    for (const coordinator of this.coordinators.values()) {
      coordinator.reset();
    }
    this.coordinators.clear();
    this.completedSnapshots.clear();
  }

  size(): number {
    return this.coordinators.size;
  }
}

const coordinatorRegistry = new ParallelAgentCoordinatorRegistry();

export function getParallelAgentCoordinatorRegistry(): ParallelAgentCoordinatorRegistry {
  return coordinatorRegistry;
}

/** Legacy callers get an isolated legacy bucket; Agent Team callers must pass a scope. */
export function getParallelAgentCoordinator(scope: SwarmRunScope = LEGACY_COORDINATOR_SCOPE): ParallelAgentCoordinator {
  return coordinatorRegistry.getOrCreate(scope);
}

/**
 * Initialize with custom config
 */
export function initParallelAgentCoordinator(
  config: Partial<CoordinatorConfig> = {},
  scope: SwarmRunScope = LEGACY_COORDINATOR_SCOPE,
): ParallelAgentCoordinator {
  return coordinatorRegistry.replace(scope, config);
}

export function resetParallelAgentCoordinators(): void {
  coordinatorRegistry.clear();
}
