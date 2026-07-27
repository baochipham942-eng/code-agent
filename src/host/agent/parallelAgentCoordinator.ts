 
// ============================================================================
// ParallelAgentCoordinator - DAG-based explicit parallel agent execution
// ============================================================================
//
// 职责边界（ADR-009 固化）：
// - 服务 **显式任务** 入口：LLM 调用 spawn_agent tool、swarm.ipc 的 UI swarm
// - 输入形态：AgentTask[]（带 dependsOn/tools/priority 的 DAG 节点）
// - 核心能力：TaskDAG + DAGScheduler 做真正的依赖图调度，SharedContext
//   （L2 共享读写），EventEmitter 事件流
// - 不包含：动态 agent 生成、L0-L3 通信层级
//
// 与 AutoAgentCoordinator 的关系：
// - 两者 **零调用交集**，服务完全不同的入口路径
// - 不会合并：输入形态差别大（DynamicAgentDefinition vs AgentTask），
//   核心能力互不覆盖（Auto 无 DAG，Parallel 无 Auto 的动态生成），强合需引 adapter
// - Agent Team 状态只经 Durable Run 提交
// ============================================================================

import { EventEmitter } from 'events';
import type { SwarmRunScope } from '../../shared/contract/swarm';
import type { SubagentExecutorPort } from './subagentExecutorPort';
import type { SubagentExecutionContext } from './subagentExecutorTypes';
import {
  AgentFailureCode,
  inferAgentFailureCode,
} from '../../shared/contract/agentFailure';
import { createTextMessage, getSpawnGuard, type AgentMessage } from './spawnGuard';
import { createLogger } from '../services/infra/logger';
import { withTimeout } from '../services/infra/timeoutController';
import {
  DEFAULT_COORDINATOR_CONFIG,
  isLegacyCoordinatorScope,
  isSameRunScope,
  type AgentTask,
  type AgentTaskResult,
  type CoordinatorConfig,
  type ParallelAgentTaskSnapshotStatus,
  type ParallelAgentTaskSnapshot,
  type ParallelExecutionResult,
  type SharedContext,
  type TaskProgressEvent,
} from './parallelAgentCoordinatorTypes';
import {
  aggregateAgentTaskResults,
  createEmptySharedContext,
  formatSharedContextForPrompt,
} from './parallelAgentCoordinatorResults';
import type { AgentTeamDurableController, AgentTeamCheckpointState } from './agentTeamDurableTypes';
import type { AgentTeamRecoveryDecision } from './agentTeamRecovery';
import { restoreParallelAgentDurableState } from './parallelAgentDurableRecovery';
import { createEmptyParallelAgentRecoveryRefs, resolveRecoveredTaskExecution } from './parallelAgentRecoveryRefs';
import {
  DAGGraphSchedulerAdapter,
  GraphEventCompatibilityAdapter,
  GraphExecutorRegistry,
  GraphRunner,
  type GraphCheckpoint,
  type GraphExecutorPort,
  type GraphJsonValue,
  type GraphNode,
  type GraphNodeResult,
  type GraphRunSpec,
} from '../orchestration';

export type {
  AgentTask,
  AgentTaskResult,
  CompletedParallelCoordinatorSnapshot,
  CompletedParallelCoordinatorTaskSnapshot,
  CoordinatorConfig,
  CoordinatorEvent,
  CoordinatorEventType,
  ParallelAgentTaskSnapshot,
  ParallelAgentTaskSnapshotStatus,
  ParallelCoordinatorTerminalStatus,
  ParallelExecutionResult,
  SharedContext,
} from './parallelAgentCoordinatorTypes';
export {
  getParallelAgentCoordinator,
  getParallelAgentCoordinatorRegistry,
  initParallelAgentCoordinator,
  ParallelAgentCoordinatorRegistry,
  resetParallelAgentCoordinators,
} from './parallelAgentCoordinatorRegistry';

const logger = createLogger('ParallelAgentCoordinator');

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
  private executionContext?: SubagentExecutionContext;
  private subagentExecutor?: SubagentExecutorPort;
  private scope?: SwarmRunScope;
  private initialized = false;
  private executionActive = false;
  private durableController?: AgentTeamDurableController;
  private durableOwnerEpoch?: number;
  private readonly legacyLifecycle: boolean;
  private activeGraphRunner?: GraphRunner;
  private graphCheckpoint?: GraphCheckpoint;
  private skipNextGraphCheckpoint = false;
  private recoveryRefs = createEmptyParallelAgentRecoveryRefs();

  constructor(config: Partial<CoordinatorConfig> = {}, scope?: SwarmRunScope) {
    super();
    this.config = { ...DEFAULT_COORDINATOR_CONFIG, ...config };
    this.scope = scope ? { ...scope } : undefined;
    this.legacyLifecycle = !scope || isLegacyCoordinatorScope(scope);
    this.sharedContext = createEmptySharedContext();
  }

  /**
   * Initialize coordinator with execution context
   */
  initialize(context: {
    executionContext: SubagentExecutionContext;
    subagentExecutor?: SubagentExecutorPort;
    scope?: SwarmRunScope;
    durableController?: AgentTeamDurableController;
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
      && context.executionContext.sessionId !== resolvedScope.sessionId
    ) {
      throw new Error('Coordinator tool context sessionId does not match its run scope.');
    }
    if (!this.scope && context.scope) {
      this.scope = { ...context.scope };
    }
    this.executionContext = context.executionContext;
    this.subagentExecutor = context.subagentExecutor;
    this.durableController = context.durableController;
    this.durableOwnerEpoch = context.durableController?.ownerEpoch;
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
  async executeParallel(
    tasks: AgentTask[],
    compatibilitySink: GraphEventCompatibilityAdapter = new GraphEventCompatibilityAdapter({}),
  ): Promise<ParallelExecutionResult> {
    if (this.executionActive) {
      throw new Error('ParallelAgentCoordinator is not reentrant; create a distinct run-scoped coordinator for nested parallel execution.');
    }
    this.executionActive = true;
    try {
      return await this.executeParallelInternal(tasks, compatibilitySink);
    } finally {
      this.executionActive = false;
    }
  }

  private async executeParallelInternal(
    tasks: AgentTask[],
    compatibilitySink: GraphEventCompatibilityAdapter,
  ): Promise<ParallelExecutionResult> {
    if (!this.executionContext) {
      throw new Error('Coordinator not initialized. Call initialize() first.');
    }
    const startTime = Date.now();
    if (this.executionContext.abortSignal.aborted) {
      this.cancelled = true;
      this.cancelReason = typeof this.executionContext.abortSignal.reason === 'string'
        ? this.executionContext.abortSignal.reason
        : 'run_cancelled';
    } else if (!this.cancelled) {
      this.cancelReason = 'cancelled';
    }
    this.taskDefinitions.clear();
    this.messageQueues.clear();
    for (const task of tasks) {
      this.taskDefinitions.set(task.id, { ...task });
      this.messageQueues.set(task.id, []);
    }
    let currentConcurrent = 0;
    let maxConcurrent = 0;
    const thrownFailures = new Set<string>();
    const unsubscribeCompatibility = compatibilitySink.subscribe({
      graph: (event) => {
        if (!event.nodeId) return;
        const task = this.taskDefinitions.get(event.nodeId);
        if (!task) return;
        if (event.type === 'node_progress' && event.data?.legacyEvent === 'task:start') {
          this.emit('task:start', { taskId: task.id, role: task.role });
        } else if (event.type === 'node_progress' && event.data?.legacyEvent === 'task:progress') {
          this.emit('task:progress', {
            taskId: task.id,
            role: task.role,
            snapshot: event.data.snapshot as unknown as TaskProgressEvent['snapshot'],
          });
        } else if (event.type === 'node_skipped' && !this.completedTasks.has(task.id)) {
          const blocked = this.createSkippedResult(
            task,
            `Blocked by failed dependencies: ${(task.dependsOn ?? []).join(', ')}`,
            'blocked',
            AgentFailureCode.DependencyFailed,
          );
          this.completedTasks.set(task.id, blocked);
          this.emit('task:complete', { taskId: task.id, result: blocked });
        } else if (event.type === 'node_cancelled' && !this.completedTasks.has(task.id)) {
          const cancelled = this.createSkippedResult(
            task,
            `Cancelled before start (${this.cancelReason})`,
            'cancelled',
            AgentFailureCode.CancelledByUser,
          );
          this.completedTasks.set(task.id, cancelled);
          this.emit('task:complete', { taskId: task.id, result: cancelled });
        } else if (event.type === 'node_completed' || event.type === 'node_failed' || event.type === 'node_cancelled') {
          const result = this.completedTasks.get(task.id);
          if (!result) return;
          if (thrownFailures.delete(task.id)) this.emit('task:error', { taskId: task.id, error: result.error ?? 'Unknown error' });
          else this.emit('task:complete', { taskId: task.id, result });
        }
      },
      diagnostic: (error) => logger.warn('Agent Team Graph compatibility projection failed', error),
    });
    const graphSpec = this.buildGraphSpec(tasks);
    const graphExecutor: GraphExecutorPort = {
      id: 'parallel-subagent',
      canExecute: (node) => node.kind === 'subagent',
      execute: async (node, graphContext): Promise<GraphNodeResult> => {
        const task = this.taskDefinitions.get(node.nodeId);
        if (!task) return { status: 'failed', error: `Task definition not found: ${node.nodeId}` };
        currentConcurrent++;
        maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
        try {
          let progressQueue = Promise.resolve();
          const taskResult = await this.executeTask(
            task,
            (snapshot) => {
              progressQueue = progressQueue.then(() => graphContext.progress({
                legacyEvent: 'task:progress',
                snapshot: snapshot as unknown as GraphJsonValue,
              }));
            },
            () => thrownFailures.add(task.id),
            () => graphContext.progress({ legacyEvent: 'task:start' }),
          );
          await progressQueue;
          return {
            status: taskResult.cancelled ? 'cancelled' : taskResult.success ? 'completed' : 'failed',
            output: this.serializeTaskResult(taskResult),
            error: taskResult.error,
            retryable: false,
            sideEffectState: 'confirmed',
          };
        } finally {
          currentConcurrent--;
        }
      },
      cancel: (node) => { this.abortTask(node.nodeId, this.cancelReason); },
    };
    const runner = new GraphRunner({
      scheduler: new DAGGraphSchedulerAdapter(),
      executors: new GraphExecutorRegistry([graphExecutor]),
      emit: (event) => compatibilitySink.emit(event),
      persistCheckpoint: async (checkpoint) => {
        this.graphCheckpoint = checkpoint;
        await this.durableController?.projectGraphCheckpoint?.(checkpoint);
      },
      attemptGuard: () => this.durableOwnerEpoch === undefined
        || this.durableController === undefined
        || this.acceptsDurableOwnerEpoch(this.durableController.ownerEpoch),
    });
    this.activeGraphRunner = runner;
    const graphPromise = runner.run(graphSpec, this.compatibleGraphCheckpoint(graphSpec));
    let graphResult;
    try {
      if (this.cancelled) await runner.cancel(this.cancelReason);
      graphResult = await graphPromise;
    } finally {
      this.activeGraphRunner = undefined;
      unsubscribeCompatibility();
    }

    const rawResults = tasks.flatMap((task) => {
      const result = this.completedTasks.get(task.id);
      return result ? [result] : [];
    });
    for (const result of rawResults) {
      if (this.config.enableSharedContext) this.updateSharedContext(result);
    }
    const errors = rawResults
      .filter((result) => !result.success)
      .map((result) => ({ taskId: result.taskId, error: result.error || 'Unknown error' }));
    const aggregatedResults = this.config.aggregateResults ? aggregateAgentTaskResults(rawResults) : rawResults;

    this.emit('all:complete', { results: aggregatedResults, errors });

    return {
      success: graphResult.status === 'completed' && errors.length === 0,
      results: aggregatedResults,
      totalDuration: Date.now() - startTime,
      parallelism: maxConcurrent,
      errors,
    };
  }

  /**
   * Execute a single task with timeout
   */
  private async executeTask(
    task: AgentTask,
    onProgress?: (snapshot: TaskProgressEvent['snapshot']) => void | Promise<void>,
    onThrownFailure?: () => void,
    onStarted?: () => void | Promise<void>,
  ): Promise<AgentTaskResult> {
    const executionContext = this.executionContext;

    if (!executionContext) {
      throw new Error('Coordinator not initialized. Call initialize() first.');
    }

    const recovered = await resolveRecoveredTaskExecution({ task, refs: this.recoveryRefs, cwd: executionContext.cwd, onWorktreeCreated: (worktreePath) => this.recordTaskWorktree(task.id, worktreePath) });
    if (recovered.result) {
      await this.durableController?.markNodeTerminal(task, recovered.result);
      this.completedTasks.set(task.id, recovered.result);
    }

    // Checkpoint hit: 成功节点短路，不重新执行（对称 autoAgentCoordinator）
    const cached = this.completedTasks.get(task.id);
    if (cached?.success) {
      logger.info(`Checkpoint hit, skipping parallel task: ${task.id}`);
      await onStarted?.();
      return cached;
    }

    const startTime = Date.now();
    let slotLease: { release: () => void } | undefined;
    const treeId = this.scope?.treeId || executionContext.spawnTreeId || executionContext.sessionId;
    const guard = getSpawnGuard();
    const taskAbortController = new AbortController();
    const parentAbortSignal = executionContext.abortSignal;
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
        timeoutMs: executionContext.spawnQueueTimeoutMs,
        signal: taskAbortController.signal,
      });

      throwIfCancelledBeforeExecutor();
      // Execute task
      const executor = await this.getSubagentExecutor();
      throwIfCancelledBeforeExecutor();
      await this.durableController?.markNodeDispatched(task);
      await onStarted?.();

      // Inject shared context into system prompt if available
      let enhancedPrompt = task.systemPrompt || '';
      if (this.config.enableSharedContext && this.sharedContext.findings.size > 0) {
        enhancedPrompt += formatSharedContextForPrompt(this.sharedContext);
      }

      const executionPromise = executor.execute({
        prompt: task.task,
        config: {
          name: task.role,
          // 持久化角色资产绑定 key（并行路径下 role 即 agent 注册 id）
          roleId: task.role,
          systemPrompt: enhancedPrompt,
          availableTools: task.tools,
          maxIterations: task.maxIterations || 20,
        },
        context: {
          ...executionContext,
          ...(recovered.worktreePath ? { cwd: recovered.worktreePath, worktreePath: recovered.worktreePath } : {}),
          agentId: task.id,
          parentToolUseId: executionContext.currentToolCallId,
          executionAgentId: task.id,
          spawnGuardId: task.id,
          abortSignal: taskAbortController.signal,
          messageDrain: () => this.drainMessages(task.id),
          ackMessageDrain: () => this.ackDrainedMessages(task.id),
          onContextSnapshot: (snapshot) => { void onProgress?.(snapshot); },
        },
      });
      guard.register(task.id, task.role, task.task, executionPromise, taskAbortController, {
        treeId,
        parentId: executionContext.spawnParentAgentId,
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

      await this.durableController?.markNodeTerminal(task, taskResult);

      this.completedTasks.set(task.id, taskResult);
      this.abortControllers.delete(task.id); this.runningTasks.delete(task.id);

      return taskResult;
    } catch (error) {
      onThrownFailure?.();
      const endTime = Date.now();
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      if (!taskAbortController.signal.aborted) {
        taskAbortController.abort(errorMessage.includes('timeout') ? 'timeout' : 'child-error');
      }
      guard.cancelDescendants(task.id, 'parent-cancel');

      this.abortControllers.delete(task.id); this.runningTasks.delete(task.id);

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
      await this.durableController?.markNodeTerminal(task, failedResult);
      this.completedTasks.set(task.id, failedResult);

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
    this.sharedContext = createEmptySharedContext();
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

  restoreDurableState(
    state: AgentTeamCheckpointState,
    decision: AgentTeamRecoveryDecision,
    ownerEpoch?: number,
  ): void {
    const restored = restoreParallelAgentDurableState({ scope: this.scope, state, decision });
    this.taskDefinitions = restored.taskDefinitions;
    this.completedTasks = restored.completedTasks;
    this.messageQueues = restored.messageQueues;
    this.clearSharedContext();
    this.importSharedContext(restored.sharedContext);
    this.cancelled = restored.cancelled;
    this.cancelReason = restored.cancelReason;
    this.graphCheckpoint = restored.graphCheckpoint;
    this.recoveryRefs = restored.recoveryRefs;
    if (ownerEpoch !== undefined) this.durableOwnerEpoch = ownerEpoch;
  }

  recordTaskWorktree(taskId: string, worktreePath: string): Promise<void> { return this.durableController?.markNodeWorktree(taskId, worktreePath) ?? Promise.resolve(); }

  acceptsDurableOwnerEpoch(epoch: number): boolean {
    return this.durableOwnerEpoch === undefined || this.durableOwnerEpoch === epoch;
  }

  canReceiveMessage(taskId: string): boolean {
    return this.taskDefinitions.has(taskId) && !this.completedTasks.has(taskId);
  }

  async sendMessage(taskId: string, message: string): Promise<boolean> {
    if (!this.canReceiveMessage(taskId)) {
      return false;
    }

    const queue = this.messageQueues.get(taskId);
    if (!queue) {
      return false;
    }

    if (this.durableController) {
      try {
        const persisted = await this.durableController.enqueueMessage(taskId, message, 'user');
        queue.push({ id: persisted.id, seq: persisted.seq, type: 'text', from: persisted.from, payload: persisted.body, timestamp: persisted.createdAt });
        logger.info(`[${taskId}] Durable parallel message queued (seq: ${persisted.seq}, queue size: ${queue.length})`);
        return true;
      } catch (error) {
        logger.error(`[${taskId}] Durable parallel message rejected`, { error });
        return false;
      }
    }

    queue.push(createTextMessage('user', message));
    logger.info(`[${taskId}] Parallel message queued (queue size: ${queue.length})`);
    return true;
  }

  private async drainMessages(taskId: string): Promise<AgentMessage[]> {
    const queue = this.messageQueues.get(taskId);
    if (!queue || queue.length === 0) return [];
    const messages = [...queue];
    queue.length = 0;
    return messages;
  }

  private async ackDrainedMessages(taskId: string): Promise<void> {
    await this.durableController?.consumeMessages(taskId);
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

  private buildGraphSpec(tasks: AgentTask[]): GraphRunSpec {
    const executionContext = this.executionContext!;
    const runId = this.scope?.runId ?? executionContext.runId ?? `parallel:${executionContext.sessionId}`;
    const sessionId = this.scope?.sessionId ?? executionContext.sessionId;
    const treeId = this.scope?.treeId ?? executionContext.spawnTreeId ?? sessionId;
    const attempt = this.durableController?.traceContext?.attempt ?? executionContext.traceContext?.attempt ?? 1;
    const durableNodes = new Map(this.durableController?.getState().taskGraph.map((node) => [node.id, node]) ?? []);
    const nodes: GraphNode[] = tasks.map((task) => {
      const durable = durableNodes.get(task.id);
      const sideEffect = durable?.sideEffect ?? task.tools.some((tool) => /(write|edit|bash|shell|browser|computer)/i.test(tool));
      return {
        nodeId: task.id,
        kind: 'subagent',
        executorRef: 'parallel-subagent',
        input: {
          role: task.role,
          task: task.task,
          tools: [...task.tools],
          ...(task.systemPrompt ? { systemPrompt: task.systemPrompt } : {}),
        },
        dependencies: [...(task.dependsOn ?? [])],
        permissionProfile: durable?.permissionProfile ?? 'readonly',
        capabilityProfile: { tools: [...task.tools] },
        sideEffect: sideEffect ? 'unknown' : 'read_only',
        idempotencyIdentity: `${runId}:node:${task.id}`,
        timeoutMs: this.config.taskTimeout,
        retryPolicy: { maxAttempts: 1 },
        required: true,
        priority: task.priority,
        metadata: { role: task.role, treeId },
      };
    });
    const trace = this.durableController?.traceContext ?? executionContext.traceContext;
    return {
      graphId: `agent-team:${treeId}`,
      runId,
      sessionId,
      attempt,
      nodes,
      schedulerPolicy: {
        maxConcurrency: this.config.maxParallelTasks,
        failureStrategy: 'continue',
        priority: 'priority',
      },
      metadata: { engine: 'agent_team', treeId },
      ...(trace ? { trace: { traceId: trace.traceId, spanId: trace.spanId } } : {}),
    };
  }

  private serializeTaskResult(result: AgentTaskResult): GraphJsonValue {
    return structuredClone(result) as unknown as GraphJsonValue;
  }

  private compatibleGraphCheckpoint(spec: GraphRunSpec): GraphCheckpoint | undefined {
    if (this.skipNextGraphCheckpoint) {
      this.skipNextGraphCheckpoint = false;
      return undefined;
    }
    const checkpoint = this.graphCheckpoint ?? this.durableController?.getState().graphCheckpoint;
    if (!checkpoint) return undefined;
    const expected = new Set(spec.nodes.map((node) => node.nodeId));
    const actual = new Set(checkpoint.nodes.map((node) => node.nodeId));
    if (
      checkpoint.graphId !== spec.graphId
      || checkpoint.runId !== spec.runId
      || checkpoint.sessionId !== spec.sessionId
      || checkpoint.attempt !== spec.attempt
      || expected.size !== actual.size
      || [...expected].some((nodeId) => !actual.has(nodeId))
    ) return undefined;
    return checkpoint;
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
    this.skipNextGraphCheckpoint = true;

    const result = await this.executeParallel([{ ...task }]);
    const retried = result.results.find((candidate) => candidate.taskId === taskId);
    if (!retried) throw new Error(`Retry did not produce a task result: ${taskId}`);
    return retried;
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
    void this.activeGraphRunner?.cancel(reason);
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
    this.activeGraphRunner = undefined;
    this.graphCheckpoint = undefined;
    if (this.legacyLifecycle) {
      this.executionContext = undefined;
      this.subagentExecutor = undefined;
      this.initialized = false;
    }
  }

  /** Compatibility facade: all DAG execution now shares the GraphRunner path. */
  async executeWithDAG(tasks: AgentTask[]): Promise<ParallelExecutionResult> {
    return this.executeParallel(tasks);
  }
}
