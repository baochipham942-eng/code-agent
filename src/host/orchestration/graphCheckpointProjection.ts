import type { GraphSchedulerSnapshot } from './graphSchedulerPort';
import type {
  GraphCheckpoint,
  GraphNodeResult,
  GraphRunSpec,
  GraphRunStatus,
} from './graphTypes';
import { graphSchedulerSnapshotToJson } from './graphSchedulerPort';

export interface GraphCheckpointProjectionInput {
  spec: GraphRunSpec;
  scheduler: GraphSchedulerSnapshot;
  status: GraphRunStatus;
  eventSequence: number;
  results: ReadonlyMap<string, GraphNodeResult>;
  createdAt: number;
  updatedAt: number;
  terminalEventType?: GraphCheckpoint['terminalEventType'];
}

export function projectGraphCheckpoint(input: GraphCheckpointProjectionInput): GraphCheckpoint {
  return {
    version: 1,
    graphId: input.spec.graphId,
    runId: input.spec.runId,
    sessionId: input.spec.sessionId,
    attempt: input.spec.attempt,
    status: input.status,
    eventSequence: input.eventSequence,
    scheduler: graphSchedulerSnapshotToJson(input.scheduler),
    nodes: input.scheduler.nodes.map((node) => ({
      ...node,
      ...(input.results.has(node.nodeId) ? { result: input.results.get(node.nodeId) } : {}),
    })),
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    ...(input.terminalEventType ? { terminalEventType: input.terminalEventType } : {}),
  };
}
