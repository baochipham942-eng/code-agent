import type { AgentFailureCode } from '../../shared/contract/agentFailure';
import {
  getSwarmRunScopeKey,
  type SwarmAgentContextSnapshot,
  type SwarmRunScope,
} from '../../shared/contract/swarm';
import { AGENT_TIMEOUTS } from '../../shared/constants';
import type { SubagentResult } from './subagentExecutorTypes';

export interface AgentTask {
  id: string;
  role: string;
  /** 实例显示名（模型给 name 或同角色去重后的 role-N）；缺省时展示层回退 role */
  name?: string;
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

export function isSameRunScope(left: SwarmRunScope, right: SwarmRunScope): boolean {
  return getSwarmRunScopeKey(left) === getSwarmRunScopeKey(right);
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
