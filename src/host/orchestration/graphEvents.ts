import type { GraphJsonValue, GraphNodeStatus, GraphRunStatus, GraphTraceContext } from './graphTypes';

export type GraphEventType =
  | 'graph_started'
  | 'node_queued'
  | 'node_started'
  | 'node_progress'
  | 'node_waiting'
  | 'node_completed'
  | 'node_failed'
  | 'node_cancelled'
  | 'node_skipped'
  | 'graph_waiting'
  | 'graph_completed'
  | 'graph_failed'
  | 'graph_cancelled';

export interface GraphEvent {
  type: GraphEventType;
  graphId: string;
  runId: string;
  sessionId: string;
  attempt: number;
  sequence: number;
  timestamp: number;
  nodeId?: string;
  nodeStatus?: GraphNodeStatus;
  graphStatus?: GraphRunStatus;
  data?: Record<string, GraphJsonValue>;
  trace?: GraphTraceContext;
}

export type GraphEventSink = (event: GraphEvent) => void | Promise<void>;
