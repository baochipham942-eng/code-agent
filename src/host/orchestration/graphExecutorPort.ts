import type {
  GraphCheckpoint,
  GraphJsonValue,
  GraphNode,
  GraphNodeResult,
  GraphRunSpec,
  GraphTraceContext,
} from './graphTypes';

export interface GraphExecutorContext {
  graphId: string;
  runId: string;
  sessionId: string;
  attempt: number;
  nodeAttempt: number;
  signal: AbortSignal;
  dependencyResults: Record<string, GraphNodeResult>;
  checkpoint?: GraphCheckpoint;
  trace?: GraphTraceContext;
  progress(data: Record<string, GraphJsonValue>): Promise<void>;
  /** Embed an executor cursor in the existing Graph checkpoint while the node is running. */
  saveCheckpoint?(checkpoint: GraphJsonValue): Promise<void>;
}

export interface GraphExecutorPort {
  readonly id: string;
  canExecute(node: GraphNode): boolean;
  execute(node: GraphNode, context: GraphExecutorContext): Promise<GraphNodeResult>;
  cancel(node: GraphNode, context: GraphExecutorContext): Promise<void> | void;
  recover?(
    node: GraphNode,
    checkpoint: GraphCheckpoint,
    context: GraphExecutorContext,
  ): Promise<GraphNodeResult>;
}

export interface GraphExecutorRegistryPort {
  resolve(node: GraphNode): GraphExecutorPort | undefined;
}

export class GraphExecutorRegistry implements GraphExecutorRegistryPort {
  private readonly executors = new Map<string, GraphExecutorPort>();

  constructor(executors: GraphExecutorPort[] = []) {
    for (const executor of executors) this.register(executor);
  }

  register(executor: GraphExecutorPort): void {
    if (this.executors.has(executor.id)) {
      throw new Error(`Graph executor already registered: ${executor.id}`);
    }
    this.executors.set(executor.id, executor);
  }

  resolve(node: GraphNode): GraphExecutorPort | undefined {
    const direct = this.executors.get(node.executorRef);
    if (direct?.canExecute(node)) return direct;
    return [...this.executors.values()].find((executor) => executor.canExecute(node));
  }
}

export interface GraphTracePort {
  startGraph(spec: GraphRunSpec): GraphTraceContext | undefined;
  startNode(spec: GraphRunSpec, node: GraphNode, parent?: GraphTraceContext): GraphTraceContext | undefined;
  endNode(trace: GraphTraceContext | undefined, result: GraphNodeResult): void;
  endGraph(trace: GraphTraceContext | undefined, status: GraphCheckpoint['status']): void;
}
