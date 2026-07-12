import type { GraphEvent, GraphEventSink, GraphEventType } from './graphEvents';
import type {
  GraphExecutorContext,
  GraphExecutorPort,
  GraphExecutorRegistryPort,
  GraphTracePort,
} from './graphExecutorPort';
import type { GraphSchedulerPort, GraphSchedulerSnapshot } from './graphSchedulerPort';
import { projectGraphCheckpoint } from './graphCheckpointProjection';
import {
  graphNodeRetryPolicy,
  isGraphNodeRequired,
  type GraphCheckpoint,
  type GraphNode,
  type GraphNodeResult,
  type GraphNodeStatus,
  type GraphRunResult,
  type GraphRunSpec,
  type GraphRunStatus,
  type GraphTraceContext,
} from './graphTypes';

export class StaleGraphAttemptError extends Error {
  constructor(readonly runId: string, readonly attempt: number) {
    super(`Graph attempt is stale: ${runId}@${attempt}`);
  }
}

export interface GraphRunnerDependencies {
  scheduler: GraphSchedulerPort;
  executors: GraphExecutorRegistryPort;
  emit?: GraphEventSink;
  persistCheckpoint?: (checkpoint: GraphCheckpoint) => void | Promise<void>;
  attemptGuard?: (identity: Pick<GraphRunSpec, 'runId' | 'attempt'>) => boolean | Promise<boolean>;
  trace?: GraphTracePort;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

interface ActiveNode {
  node: GraphNode;
  executor: GraphExecutorPort;
  controller: AbortController;
  context: GraphExecutorContext;
  promise: Promise<void>;
}

const TERMINAL_NODE_STATUSES = new Set<GraphNodeStatus>([
  'completed', 'failed', 'cancelled', 'skipped', 'requires_review',
]);

export class GraphRunner {
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private spec?: GraphRunSpec;
  private status: GraphRunStatus = 'created';
  private createdAt = 0;
  private eventSequence = 0;
  private terminalEvent?: GraphCheckpoint['terminalEventType'];
  private readonly results = new Map<string, GraphNodeResult>();
  private readonly active = new Map<string, ActiveNode>();
  private graphTrace?: GraphTraceContext;
  private checkpoint?: GraphCheckpoint;
  private cancelRequested = false;

  constructor(private readonly deps: GraphRunnerDependencies) {
    this.now = deps.now ?? Date.now;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async run(spec: GraphRunSpec, checkpoint?: GraphCheckpoint): Promise<GraphRunResult> {
    this.validateSpec(spec);
    this.spec = spec;
    this.createdAt = checkpoint?.createdAt ?? this.now();
    this.eventSequence = checkpoint?.eventSequence ?? 0;
    this.terminalEvent = checkpoint?.terminalEventType;
    this.status = checkpoint && checkpoint.status !== 'created' ? checkpoint.status : 'running';
    this.cancelRequested = false;
    this.results.clear();
    for (const node of checkpoint?.nodes ?? []) {
      if (node.result) this.results.set(node.nodeId, node.result);
    }

    if (checkpoint) {
      this.deps.scheduler.restore(spec, checkpoint.scheduler as unknown as GraphSchedulerSnapshot);
      this.checkpoint = checkpoint;
    } else {
      this.deps.scheduler.initialize(spec);
    }
    this.graphTrace = this.deps.trace?.startGraph(spec) ?? spec.trace;

    if (this.isTerminalStatus(this.status)) {
      return this.result();
    }

    await this.emit('graph_started', { graphStatus: 'running' });
    for (const node of spec.nodes) {
      const status = this.nodeState(node.nodeId)?.status;
      if (status === 'queued' || status === 'ready') {
        await this.emit('node_queued', { nodeId: node.nodeId, nodeStatus: status });
      }
    }
    await this.persist();

    while (!this.isTerminalStatus(this.status) && this.status !== 'waiting' && this.status !== 'requires_review') {
      await this.assertCurrentAttempt();
      this.launchReadyNodes();

      if (this.active.size > 0) {
        await Promise.race([...this.active.values()].map((entry) => entry.promise));
        continue;
      }

      const snapshot = this.deps.scheduler.snapshot();
      const nextStatus = this.aggregateStatus(snapshot);
      if (nextStatus === 'running') {
        throw new Error(`Graph ${spec.graphId} is deadlocked with no ready or running nodes`);
      }
      await this.finish(nextStatus);
    }

    return this.result();
  }

  async cancel(reason = 'graph_cancelled'): Promise<void> {
    if (!this.spec || this.isTerminalStatus(this.status)) return;
    await this.assertCurrentAttempt();
    this.cancelRequested = true;
    const cancelled = this.deps.scheduler.cancel();
    await Promise.allSettled([...this.active.values()].map(async (entry) => {
      entry.controller.abort(reason);
      await entry.executor.cancel(entry.node, entry.context);
    }));
    for (const nodeId of cancelled.filter((id) => !this.active.has(id))) {
      this.results.set(nodeId, { status: 'cancelled', error: reason });
      await this.emit('node_cancelled', { nodeId, nodeStatus: 'cancelled', data: { reason } });
    }
    await this.persist();
    if (this.active.size === 0) await this.finish('cancelled');
  }

  getCheckpoint(): GraphCheckpoint | undefined {
    return this.checkpoint;
  }

  private launchReadyNodes(): void {
    const spec = this.requireSpec();
    const slots = Math.max(0, spec.schedulerPolicy.maxConcurrency - this.active.size);
    if (slots === 0) return;
    for (const node of this.deps.scheduler.nextReadyNodes(slots)) {
      const executor = this.deps.executors.resolve(node);
      if (!executor) throw new Error(`No Graph executor for ${node.nodeId} (${node.executorRef})`);
      this.startNode(node, executor);
    }
  }

  private startNode(node: GraphNode, executor: GraphExecutorPort): void {
    const spec = this.requireSpec();
    const previous = this.nodeState(node.nodeId);
    const nodeAttempt = (previous?.attempts ?? 0) + 1;
    const startedAt = this.now();
    this.deps.scheduler.markRunning(node.nodeId, startedAt);
    const controller = new AbortController();
    const nodeTrace = this.deps.trace?.startNode(spec, node, this.graphTrace);
    const context: GraphExecutorContext = {
      graphId: spec.graphId,
      runId: spec.runId,
      sessionId: spec.sessionId,
      attempt: spec.attempt,
      nodeAttempt,
      signal: controller.signal,
      dependencyResults: Object.fromEntries(node.dependencies.flatMap((id) => {
        const result = this.results.get(id);
        return result ? [[id, result]] : [];
      })),
      checkpoint: this.checkpoint,
      trace: nodeTrace,
      progress: async (data) => this.emit('node_progress', {
        nodeId: node.nodeId,
        nodeStatus: 'running',
        data,
        trace: nodeTrace,
      }),
    };
    const entry: ActiveNode = { node, executor, controller, context, promise: Promise.resolve() };
    this.active.set(node.nodeId, entry);
    entry.promise = this.executeNode(entry, nodeAttempt, startedAt, nodeTrace);
  }

  private async executeNode(
    entry: ActiveNode,
    nodeAttempt: number,
    startedAt: number,
    nodeTrace?: GraphTraceContext,
  ): Promise<void> {
    const { node, executor, controller, context } = entry;
    await this.assertCurrentAttempt();
    await this.emit('node_started', { nodeId: node.nodeId, nodeStatus: 'running', trace: nodeTrace });
    await this.persist();

    let result: GraphNodeResult;
    try {
      result = await executor.execute(node, context);
    } catch (error) {
      result = {
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
        retryable: true,
        sideEffectState: node.sideEffect === 'unknown' ? 'unknown' : 'not_dispatched',
      };
    }

    try {
      await this.assertCurrentAttempt();
      if (this.cancelRequested || controller.signal.aborted) {
        result = { status: 'cancelled', error: String(controller.signal.reason ?? 'graph_cancelled') };
      }
      result = this.normalizeUncertainResult(node, result);
      await this.applyNodeResult(node, nodeAttempt, startedAt, result, nodeTrace);
    } finally {
      this.active.delete(node.nodeId);
      this.deps.trace?.endNode(nodeTrace, result);
    }
  }

  private async applyNodeResult(
    node: GraphNode,
    nodeAttempt: number,
    startedAt: number,
    result: GraphNodeResult,
    trace?: GraphTraceContext,
  ): Promise<void> {
    const completedAt = this.now();
    const retry = graphNodeRetryPolicy(this.requireSpec(), node);
    const shouldRetry = result.status === 'failed'
      && result.retryable === true
      && nodeAttempt < Math.max(1, retry.maxAttempts)
      && result.sideEffectState !== 'unknown';

    if (shouldRetry) {
      this.results.set(node.nodeId, result);
      this.deps.scheduler.applyResult({
        nodeId: node.nodeId,
        status: 'ready',
        attempts: nodeAttempt,
        startedAt,
        completedAt,
      });
      await this.emit('node_failed', {
        nodeId: node.nodeId,
        nodeStatus: 'failed',
        data: { error: result.error ?? 'node failed', willRetry: true, nodeAttempt },
        trace,
      });
      await this.persist();
      const multiplier = retry.multiplier ?? 1;
      const base = retry.backoffMs ?? 0;
      const delay = Math.min(base * Math.pow(multiplier, Math.max(0, nodeAttempt - 1)), retry.maxBackoffMs ?? Number.MAX_SAFE_INTEGER);
      if (delay > 0) await this.sleep(delay);
      await this.emit('node_queued', { nodeId: node.nodeId, nodeStatus: 'ready' });
      return;
    }

    const before = this.deps.scheduler.snapshot();
    this.results.set(node.nodeId, result);
    this.deps.scheduler.applyResult({
      nodeId: node.nodeId,
      status: result.status,
      attempts: nodeAttempt,
      startedAt,
      completedAt,
    });
    const eventType: Record<GraphNodeResult['status'], GraphEventType> = {
      completed: 'node_completed',
      failed: 'node_failed',
      cancelled: 'node_cancelled',
      waiting: 'node_waiting',
      requires_review: 'node_waiting',
    };
    await this.emit(eventType[result.status], {
      nodeId: node.nodeId,
      nodeStatus: result.status,
      data: result.error ? { error: result.error, nodeAttempt } : { nodeAttempt },
      trace,
    });
    const beforeStatuses = new Map(before.nodes.map((state) => [state.nodeId, state.status]));
    for (const state of this.deps.scheduler.snapshot().nodes) {
      if (state.status === 'skipped' && beforeStatuses.get(state.nodeId) !== 'skipped') {
        this.results.set(state.nodeId, { status: 'failed', error: `Skipped because a required dependency failed` });
        await this.emit('node_skipped', { nodeId: state.nodeId, nodeStatus: 'skipped' });
      }
    }
    await this.persist();
  }

  private normalizeUncertainResult(node: GraphNode, result: GraphNodeResult): GraphNodeResult {
    if (result.status === 'requires_review') return result;
    if (result.sideEffectState === 'unknown') {
      return { ...result, status: 'requires_review', retryable: false };
    }
    if (
      result.status === 'failed'
      && node.sideEffect === 'unknown'
      && result.sideEffectState !== 'confirmed'
      && result.sideEffectState !== 'not_dispatched'
    ) {
      return { ...result, status: 'requires_review', retryable: false, sideEffectState: 'unknown' };
    }
    return result;
  }

  private aggregateStatus(snapshot: GraphSchedulerSnapshot): GraphRunStatus {
    if (this.cancelRequested) return 'cancelled';
    const states = snapshot.nodes;
    if (states.some((node) => node.status === 'requires_review')) return 'requires_review';
    if (states.some((node) => node.status === 'waiting')) return 'waiting';
    const requiredFailed = states.some((state) => {
      const node = this.requireSpec().nodes.find((candidate) => candidate.nodeId === state.nodeId);
      return node && isGraphNodeRequired(node) && state.status === 'failed';
    });
    if (requiredFailed) return 'failed';
    if (states.every((node) => TERMINAL_NODE_STATUSES.has(node.status))) return 'completed';
    return 'running';
  }

  private async finish(status: GraphRunStatus): Promise<void> {
    if (status === 'waiting' || status === 'requires_review') {
      this.status = status;
      await this.emit('graph_waiting', { graphStatus: status });
      await this.persist();
      return;
    }
    this.status = status;
    const terminal: GraphCheckpoint['terminalEventType'] = status === 'completed'
      ? 'graph_completed'
      : status === 'cancelled' ? 'graph_cancelled' : 'graph_failed';
    if (!this.terminalEvent) {
      this.terminalEvent = terminal;
      await this.emit(terminal, { graphStatus: status });
    }
    await this.persist();
    this.deps.trace?.endGraph(this.graphTrace, status);
  }

  private async emit(
    type: GraphEventType,
    partial: Partial<Omit<GraphEvent, 'type' | 'graphId' | 'runId' | 'sessionId' | 'attempt' | 'sequence' | 'timestamp'>> = {},
  ): Promise<void> {
    const spec = this.requireSpec();
    await this.assertCurrentAttempt();
    const event: GraphEvent = {
      type,
      graphId: spec.graphId,
      runId: spec.runId,
      sessionId: spec.sessionId,
      attempt: spec.attempt,
      sequence: ++this.eventSequence,
      timestamp: this.now(),
      ...partial,
    };
    await this.deps.emit?.(event);
  }

  private async persist(): Promise<void> {
    await this.assertCurrentAttempt();
    const spec = this.requireSpec();
    this.checkpoint = projectGraphCheckpoint({
      spec,
      scheduler: this.deps.scheduler.snapshot(),
      status: this.status,
      eventSequence: this.eventSequence,
      results: this.results,
      createdAt: this.createdAt,
      updatedAt: this.now(),
      terminalEventType: this.terminalEvent,
    });
    await this.deps.persistCheckpoint?.(this.checkpoint);
  }

  private result(): GraphRunResult {
    if (!this.checkpoint) throw new Error('Graph checkpoint is unavailable');
    return {
      status: this.status,
      checkpoint: this.checkpoint,
      results: Object.fromEntries(this.results),
    };
  }

  private nodeState(nodeId: string) {
    return this.deps.scheduler.snapshot().nodes.find((node) => node.nodeId === nodeId);
  }

  private async assertCurrentAttempt(): Promise<void> {
    if (!this.spec || !this.deps.attemptGuard) return;
    if (!await this.deps.attemptGuard({ runId: this.spec.runId, attempt: this.spec.attempt })) {
      throw new StaleGraphAttemptError(this.spec.runId, this.spec.attempt);
    }
  }

  private requireSpec(): GraphRunSpec {
    if (!this.spec) throw new Error('GraphRunner has not been started');
    return this.spec;
  }

  private isTerminalStatus(status: GraphRunStatus): boolean {
    return status === 'completed' || status === 'failed' || status === 'cancelled';
  }

  private validateSpec(spec: GraphRunSpec): void {
    if (!spec.graphId || !spec.runId || !spec.sessionId) throw new Error('Graph identity is incomplete');
    if (!Number.isInteger(spec.attempt) || spec.attempt < 1) throw new Error('Graph attempt must be a positive integer');
    if (!Number.isInteger(spec.schedulerPolicy.maxConcurrency) || spec.schedulerPolicy.maxConcurrency < 1) {
      throw new Error('Graph maxConcurrency must be a positive integer');
    }
    const ids = new Set<string>();
    for (const node of spec.nodes) {
      if (!node.nodeId || ids.has(node.nodeId)) throw new Error(`Duplicate or empty graph node id: ${node.nodeId}`);
      if (node.required === true && node.optional === true) throw new Error(`Graph node cannot be required and optional: ${node.nodeId}`);
      ids.add(node.nodeId);
    }
    for (const node of spec.nodes) {
      for (const dependency of node.dependencies) {
        if (!ids.has(dependency)) throw new Error(`Graph node ${node.nodeId} has missing dependency ${dependency}`);
      }
    }
  }
}
