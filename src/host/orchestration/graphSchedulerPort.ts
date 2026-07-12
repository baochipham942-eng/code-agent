import type { GraphJsonValue, GraphNode, GraphNodeStatus, GraphRunSpec } from './graphTypes';

export interface GraphSchedulerNodeState {
  nodeId: string;
  status: GraphNodeStatus;
  attempts: number;
  startedAt?: number;
  completedAt?: number;
}

export interface GraphSchedulerSnapshot {
  version: number;
  nodes: GraphSchedulerNodeState[];
  cancelled: boolean;
}

export interface GraphSchedulerApplyResult {
  nodeId: string;
  status: GraphNodeStatus;
  attempts: number;
  startedAt?: number;
  completedAt?: number;
}

export interface GraphSchedulerPort {
  initialize(graph: GraphRunSpec): void;
  nextReadyNodes(limit: number): GraphNode[];
  markRunning(nodeId: string, startedAt: number): void;
  applyResult(result: GraphSchedulerApplyResult): void;
  cancel(nodeId?: string): string[];
  snapshot(): GraphSchedulerSnapshot;
  restore(graph: GraphRunSpec, snapshot: GraphSchedulerSnapshot): void;
}

export function graphSchedulerSnapshotToJson(snapshot: GraphSchedulerSnapshot): GraphJsonValue {
  return snapshot as unknown as GraphJsonValue;
}
