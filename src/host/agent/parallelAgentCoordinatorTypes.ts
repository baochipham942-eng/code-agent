import { createHash } from 'crypto';
import * as path from 'path';
import type { AgentFailureCode } from '../../shared/contract/agentFailure';
import {
  getSwarmRunScopeKey,
  type SwarmAgentContextSnapshot,
  type SwarmRunScope,
} from '../../shared/contract/swarm';
import { AGENT_TIMEOUTS, COORDINATION_CHECKPOINTS } from '../../shared/constants';
import { getUserConfigDir } from '../config/configPaths';
import type { SubagentResult } from './subagentExecutorTypes';

export interface AgentTask {
  id: string;
  role: string;
  task: string;
  systemPrompt?: string;
  tools: string[];
  maxIterations?: number;
  dependsOn?: string[];
  priority?: number;
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
  parallelism: number;
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

export interface TaskProgressEvent {
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

export interface ParallelCheckpoint {
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
    lastUpdated?: Record<string, number>;
  };
}

export type ParallelCheckpointIdentity = string | SwarmRunScope;

function getCheckpointDigest(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32);
}

export function isSameRunScope(left: SwarmRunScope, right: SwarmRunScope): boolean {
  return getSwarmRunScopeKey(left) === getSwarmRunScopeKey(right);
}

export function getCheckpointIdentity(identity: ParallelCheckpointIdentity): {
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
    fileName: `run-${getCheckpointDigest(getSwarmRunScopeKey(identity))}`,
  };
}

export function getParallelCheckpointPath(identity: ParallelCheckpointIdentity): string {
  const checkpointIdentity = getCheckpointIdentity(identity);
  return path.join(
    getUserConfigDir(),
    COORDINATION_CHECKPOINTS.PARALLEL_DIR,
    `${checkpointIdentity.fileName}.json`,
  );
}

export const DEFAULT_COORDINATOR_CONFIG: CoordinatorConfig = {
  maxParallelTasks: 4,
  taskTimeout: AGENT_TIMEOUTS.PARALLEL_TASK,
  enableSharedContext: true,
  aggregateResults: true,
};

export const LEGACY_COORDINATOR_SCOPE: SwarmRunScope = {
  sessionId: '__legacy__',
  runId: '__legacy__',
  treeId: '__legacy__',
};

export function isLegacyCoordinatorScope(scope: SwarmRunScope): boolean {
  return isSameRunScope(scope, LEGACY_COORDINATOR_SCOPE);
}
