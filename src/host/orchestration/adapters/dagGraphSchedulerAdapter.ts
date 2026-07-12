import type { DAGTask, TaskStatus } from '../../../shared/contract/taskDAG';
import { TaskDAG } from '../../scheduler/TaskDAG';
import type {
  GraphSchedulerApplyResult,
  GraphSchedulerNodeState,
  GraphSchedulerPort,
  GraphSchedulerSnapshot,
} from '../graphSchedulerPort';
import type { GraphNode, GraphNodeStatus, GraphRunSpec } from '../graphTypes';
import { isGraphNodeRequired } from '../graphTypes';

const TERMINAL = new Set<GraphNodeStatus>([
  'completed', 'failed', 'cancelled', 'skipped', 'requires_review',
]);

/**
 * GraphSchedulerPort backed by TaskDAG's validation, cycle detection, ready queue,
 * priority ordering and dependency transitions. It deliberately never invokes
 * DAGScheduler's agent/shell executors; GraphRunner owns executor selection.
 */
export class DAGGraphSchedulerAdapter implements GraphSchedulerPort {
  private spec?: GraphRunSpec;
  private dag?: TaskDAG;
  private cancelled = false;
  private readonly attempts = new Map<string, number>();
  private readonly startedAt = new Map<string, number>();
  private readonly completedAt = new Map<string, number>();
  private readonly extendedStatuses = new Map<string, Extract<GraphNodeStatus, 'waiting' | 'requires_review'>>();

  initialize(graph: GraphRunSpec): void {
    this.spec = this.withEdgeDependencies(graph);
    this.dag = this.buildDAG(this.spec);
    this.cancelled = false;
    this.attempts.clear();
    this.startedAt.clear();
    this.completedAt.clear();
    this.extendedStatuses.clear();
    this.dag.getReadyTasks();
  }

  nextReadyNodes(limit: number): GraphNode[] {
    const spec = this.requireSpec();
    const readyIds = new Set(this.requireDAG().getReadyTasks().map((task) => task.id));
    return spec.nodes
      .filter((node) => readyIds.has(node.nodeId) && !this.extendedStatuses.has(node.nodeId))
      .sort((left, right) => (right.priority ?? 0) - (left.priority ?? 0))
      .slice(0, Math.max(0, limit));
  }

  markRunning(nodeId: string, startedAt: number): void {
    this.extendedStatuses.delete(nodeId);
    this.requireDAG().startTask(nodeId);
    this.startedAt.set(nodeId, startedAt);
  }

  applyResult(result: GraphSchedulerApplyResult): void {
    const dag = this.requireDAG();
    const node = this.requireNode(result.nodeId);
    this.attempts.set(result.nodeId, result.attempts);
    if (result.startedAt !== undefined) this.startedAt.set(result.nodeId, result.startedAt);
    if (result.completedAt !== undefined) this.completedAt.set(result.nodeId, result.completedAt);

    if (result.status === 'waiting' || result.status === 'requires_review') {
      this.extendedStatuses.set(result.nodeId, result.status);
      dag.cancelTask(result.nodeId);
      return;
    }
    this.extendedStatuses.delete(result.nodeId);

    if (result.status === 'ready') {
      dag.updateTaskStatus(result.nodeId, 'ready');
      return;
    }
    if (result.status === 'completed') {
      dag.completeTask(result.nodeId, { text: '' });
      return;
    }
    if (result.status === 'failed') {
      dag.updateTaskStatus(result.nodeId, 'failed', {
        failure: { message: 'Graph executor failed', retryable: false },
      });
      if (isGraphNodeRequired(node)) this.skipBlockedDescendants(result.nodeId);
      return;
    }
    const mapped = this.toTaskStatus(result.status);
    dag.updateTaskStatus(result.nodeId, mapped);
    if (result.status === 'cancelled') this.skipBlockedDescendants(result.nodeId);
  }

  cancel(nodeId?: string): string[] {
    const dag = this.requireDAG();
    const targets = nodeId ? [nodeId] : dag.getAllTasks().map((task) => task.id);
    const changed: string[] = [];
    for (const id of targets) {
      const task = dag.getTask(id);
      if (!task) continue;
      const extended = this.extendedStatuses.get(id);
      if (extended === 'requires_review') continue;
      if (extended === 'waiting') {
        this.extendedStatuses.delete(id);
        changed.push(id);
        continue;
      }
      if (TERMINAL.has(this.fromTaskStatus(task.status))) continue;
      dag.cancelTask(id);
      this.extendedStatuses.delete(id);
      changed.push(id);
      if (nodeId) this.skipBlockedDescendants(id, changed);
    }
    this.cancelled = true;
    return [...new Set(changed)];
  }

  snapshot(): GraphSchedulerSnapshot {
    const dag = this.requireDAG();
    return {
      version: 1,
      nodes: dag.getAllTasks().map((task) => ({
        nodeId: task.id,
        status: this.extendedStatuses.get(task.id) ?? this.fromTaskStatus(task.status),
        attempts: this.attempts.get(task.id) ?? 0,
        ...(this.startedAt.has(task.id) ? { startedAt: this.startedAt.get(task.id) } : {}),
        ...(this.completedAt.has(task.id) ? { completedAt: this.completedAt.get(task.id) } : {}),
      })),
      cancelled: this.cancelled,
    };
  }

  restore(graph: GraphRunSpec, snapshot: GraphSchedulerSnapshot): void {
    if (snapshot.version !== 1) throw new Error(`Unsupported graph scheduler snapshot: ${snapshot.version}`);
    this.initialize(graph);
    const dag = this.requireDAG();
    const byId = new Map(snapshot.nodes.map((state) => [state.nodeId, state]));
    if (byId.size !== graph.nodes.length || graph.nodes.some((node) => !byId.has(node.nodeId))) {
      throw new Error('Graph scheduler snapshot does not match graph nodes');
    }

    for (const state of snapshot.nodes) {
      this.attempts.set(state.nodeId, state.attempts);
      if (state.startedAt !== undefined) this.startedAt.set(state.nodeId, state.startedAt);
      if (state.completedAt !== undefined) this.completedAt.set(state.nodeId, state.completedAt);
    }
    for (const state of snapshot.nodes.filter((candidate) => candidate.status === 'completed')) {
      dag.updateTaskStatus(state.nodeId, 'completed', { output: { text: '' } });
    }
    for (const state of snapshot.nodes.filter((candidate) => candidate.status !== 'completed')) {
      const node = this.requireNode(state.nodeId);
      let status = state.status;
      if (status === 'running') {
        status = node.sideEffect === 'unknown' ? 'requires_review' : 'ready';
      }
      if (status === 'waiting' || status === 'requires_review') {
        this.extendedStatuses.set(state.nodeId, status);
        dag.updateTaskStatus(state.nodeId, 'cancelled');
      } else {
        dag.updateTaskStatus(state.nodeId, this.toTaskStatus(status));
      }
    }
    this.cancelled = snapshot.cancelled;
  }

  private buildDAG(spec: GraphRunSpec): TaskDAG {
    const dag = new TaskDAG(spec.graphId, `Graph ${spec.graphId}`, {
      maxParallelism: spec.schedulerPolicy.maxConcurrency,
      defaultMaxRetries: 0,
      defaultTimeout: spec.budget?.timeoutMs,
      failureStrategy: 'continue',
      enableOutputPassing: false,
      enableSharedContext: false,
    });
    for (const node of spec.nodes) {
      dag.addAgentTask(node.nodeId, { role: node.kind, prompt: node.nodeId }, {
        name: node.nodeId,
        dependencies: [],
        timeout: node.timeoutMs,
        allowFailure: !isGraphNodeRequired(node),
        priority: this.toTaskPriority(node.priority),
      });
    }
    for (const node of spec.nodes) {
      for (const dependency of node.dependencies) dag.addDependency(node.nodeId, dependency);
    }
    const validation = dag.validate();
    if (!validation.valid) throw new Error(`Invalid graph DAG: ${validation.errors.join(', ')}`);
    return dag;
  }

  private withEdgeDependencies(graph: GraphRunSpec): GraphRunSpec {
    if (!graph.edges?.length) return graph;
    const nodes = graph.nodes.map((node) => {
      const edgeDependencies = graph.edges!
        .filter((edge) => edge.to === node.nodeId)
        .map((edge) => edge.from);
      return { ...node, dependencies: [...new Set([...node.dependencies, ...edgeDependencies])] };
    });
    return { ...graph, nodes };
  }

  private skipBlockedDescendants(nodeId: string, changed: string[] = []): void {
    const dag = this.requireDAG();
    for (const task of dag.getAllTasks().filter((candidate) => candidate.dependencies.includes(nodeId))) {
      if (TERMINAL.has(this.fromTaskStatus(task.status))) continue;
      dag.updateTaskStatus(task.id, 'skipped');
      changed.push(task.id);
      this.skipBlockedDescendants(task.id, changed);
    }
  }

  private fromTaskStatus(status: TaskStatus): GraphNodeStatus {
    if (status === 'pending') return 'queued';
    return status;
  }

  private toTaskStatus(status: GraphNodeStatus): TaskStatus {
    if (status === 'queued') return 'pending';
    if (status === 'waiting' || status === 'requires_review') return 'cancelled';
    return status;
  }

  private toTaskPriority(priority?: number): DAGTask['priority'] {
    if ((priority ?? 0) >= 3) return 'critical';
    if ((priority ?? 0) >= 2) return 'high';
    if ((priority ?? 0) < 0) return 'low';
    return 'normal';
  }

  private requireSpec(): GraphRunSpec {
    if (!this.spec) throw new Error('Graph scheduler is not initialized');
    return this.spec;
  }

  private requireDAG(): TaskDAG {
    if (!this.dag) throw new Error('Graph scheduler is not initialized');
    return this.dag;
  }

  private requireNode(nodeId: string): GraphNode {
    const node = this.requireSpec().nodes.find((candidate) => candidate.nodeId === nodeId);
    if (!node) throw new Error(`Unknown graph node: ${nodeId}`);
    return node;
  }
}
