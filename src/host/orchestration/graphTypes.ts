export type GraphJsonPrimitive = string | number | boolean | null;
export type GraphJsonValue =
  | GraphJsonPrimitive
  | GraphJsonValue[]
  | { [key: string]: GraphJsonValue };

export interface GraphRetryPolicy {
  maxAttempts: number;
  backoffMs?: number;
  maxBackoffMs?: number;
  multiplier?: number;
}

export interface GraphBudget {
  maxConcurrency?: number;
  timeoutMs?: number;
  tokenLimit?: number;
  costLimit?: number;
}

export interface GraphSchedulerPolicy {
  maxConcurrency: number;
  failureStrategy?: 'required_fail_fast' | 'continue';
  priority?: 'fifo' | 'priority';
}

export type GraphSideEffect = 'none' | 'read_only' | 'idempotent' | 'unknown';

export interface GraphNode {
  nodeId: string;
  kind: string;
  executorRef: string;
  input: GraphJsonValue;
  dependencies: string[];
  permissionProfile?: GraphJsonValue;
  capabilityProfile?: GraphJsonValue;
  sideEffect: GraphSideEffect;
  idempotencyIdentity?: string;
  timeoutMs?: number;
  retryPolicy?: GraphRetryPolicy;
  required?: boolean;
  optional?: boolean;
  priority?: number;
  metadata?: Record<string, GraphJsonValue>;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface GraphTraceContext {
  traceId: string;
  spanId: string;
  traceparent?: string;
}

export interface GraphRunSpec {
  graphId: string;
  runId: string;
  sessionId: string;
  attempt: number;
  nodes: GraphNode[];
  edges?: GraphEdge[];
  schedulerPolicy: GraphSchedulerPolicy;
  retryPolicy?: GraphRetryPolicy;
  budget?: GraphBudget;
  metadata?: Record<string, GraphJsonValue>;
  trace?: GraphTraceContext;
}

export type GraphNodeStatus =
  | 'queued'
  | 'ready'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'skipped'
  | 'requires_review';

export type GraphRunStatus =
  | 'created'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'requires_review';

export interface GraphNodeResult {
  status: Extract<GraphNodeStatus, 'completed' | 'failed' | 'cancelled' | 'waiting' | 'requires_review'>;
  output?: GraphJsonValue;
  error?: string;
  retryable?: boolean;
  sideEffectState?: 'not_dispatched' | 'dispatched' | 'confirmed' | 'unknown';
  checkpoint?: GraphJsonValue;
  metadata?: Record<string, GraphJsonValue>;
}

export interface GraphNodeCheckpoint {
  nodeId: string;
  status: GraphNodeStatus;
  attempts: number;
  result?: GraphNodeResult;
  startedAt?: number;
  completedAt?: number;
}

export interface GraphCheckpoint {
  version: 1;
  graphId: string;
  runId: string;
  sessionId: string;
  attempt: number;
  status: GraphRunStatus;
  eventSequence: number;
  scheduler: GraphJsonValue;
  nodes: GraphNodeCheckpoint[];
  createdAt: number;
  updatedAt: number;
  terminalEventType?: 'graph_completed' | 'graph_failed' | 'graph_cancelled';
}

export interface GraphRunResult {
  status: GraphRunStatus;
  checkpoint: GraphCheckpoint;
  results: Record<string, GraphNodeResult>;
}

export function isGraphNodeRequired(node: GraphNode): boolean {
  return node.optional !== true && node.required !== false;
}

export function graphNodeRetryPolicy(spec: GraphRunSpec, node: GraphNode): GraphRetryPolicy {
  return node.retryPolicy ?? spec.retryPolicy ?? { maxAttempts: 1 };
}
