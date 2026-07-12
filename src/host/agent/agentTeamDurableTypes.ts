import type { RunStatus } from '../../shared/contract/durableRun';
import type { SwarmRunScope } from '../../shared/contract/swarm';
import type { AgentTask, AgentTaskResult } from './parallelAgentCoordinatorTypes';
import type { RunTraceContext } from '../telemetry/runTraceContext';
import type { GraphCheckpoint } from '../orchestration';

export const AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION = 1 as const;

export type AgentTeamNodeStatus =
  | 'pending'
  | 'prepared'
  | 'dispatched'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'blocked';

export interface AgentTeamCheckpointNode {
  id: string;
  role: string;
  task: string;
  dependsOn: string[];
  model?: { provider: string; model: string };
  tools: string[];
  permissionProfile: 'readonly' | 'write' | 'execute' | 'network';
  sideEffect: boolean;
  status: AgentTeamNodeStatus;
  operationId: string;
  providerOperationId?: string;
  resultRef?: string;
  result?: AgentTaskResult;
  error?: string;
  worktreeRef?: string;
  artifactRefs: string[];
}

export interface AgentTeamMailboxMessage {
  id: string;
  seq: number;
  treeId: string;
  agentId: string;
  from: string;
  type: string;
  body: string;
  createdAt: number;
}

export interface AgentTeamApprovalRef {
  approvalId: string;
  operationId: string;
  status: 'waiting' | 'approved' | 'rejected' | 'cancelled';
}

export interface AgentTeamCheckpointState {
  schemaVersion: typeof AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION;
  kind: 'agent_team';
  teamId: string;
  treeId: string;
  scope: SwarmRunScope;
  parentRunId: string;
  taskGraph: AgentTeamCheckpointNode[];
  mailbox: {
    nextSeq: number;
    committedCursor: number;
    pending: AgentTeamMailboxMessage[];
    consumedMessageIds: string[];
  };
  findings: Record<string, unknown>;
  decisions: Record<string, string>;
  errors: string[];
  completedNodeResultRefs: Record<string, string>;
  runningChildRefs: string[];
  pendingApprovalRefs: AgentTeamApprovalRef[];
  worktreeRefs: Record<string, string>;
  artifactRefs: Record<string, string[]>;
  cancelled: boolean;
  /** Graph Runner node-state projection; Durable Run remains the storage/lease authority. */
  graphCheckpoint?: GraphCheckpoint;
  updatedAt: number;
}

export interface AgentTeamDurableController {
  readonly scope: SwarmRunScope;
  readonly ownerEpoch: number;
  readonly traceContext?: RunTraceContext;
  getState(): AgentTeamCheckpointState;
  checkpoint(status?: Exclude<RunStatus, 'created' | 'completed' | 'failed' | 'cancelled'>): Promise<void>;
  projectGraphCheckpoint?(checkpoint: GraphCheckpoint): Promise<void>;
  markApprovalWaiting(approvalId: string, now?: number): Promise<void>;
  resolveApproval(approvalId: string, status: 'approved' | 'rejected' | 'cancelled', now?: number): Promise<void>;
  markNodeDispatched(task: AgentTask, now?: number): Promise<void>;
  markNodeTerminal(task: AgentTask, result: AgentTaskResult, now?: number): Promise<void>;
  enqueueMessage(agentId: string, body: string, from?: string, type?: string, now?: number): Promise<AgentTeamMailboxMessage>;
  consumeMessages(agentId: string, now?: number): Promise<AgentTeamMailboxMessage[]>;
  cancel(reason: string, now?: number): Promise<void>;
  terminal(status: 'completed' | 'failed' | 'cancelled', reason?: string, now?: number): Promise<void>;
}

export interface AgentTeamParentProjectionInput {
  parentRunId: string;
  teamRunId: string;
  treeId: string;
  logicalOperationId: string;
  sideEffect: boolean;
  now: number;
}

export interface AgentTeamParentTerminalInput {
  parentRunId: string;
  teamRunId: string;
  status: 'completed' | 'failed' | 'cancelled';
  resultRef?: string;
  now: number;
}

export interface AgentTeamDurableParentHost {
  prepareAgentTeamChild(input: AgentTeamParentProjectionInput): Promise<void>;
  projectAgentTeamChildTerminal(input: AgentTeamParentTerminalInput): Promise<void>;
}

export interface AgentTeamDurableStartInput {
  scope: SwarmRunScope;
  parentRunId: string;
  logicalOperationId: string;
  sideEffect: boolean;
  tasks: AgentTask[];
  model?: { provider: string; model: string };
  now?: number;
}

export interface AgentTeamDurableRuntimePort {
  start(input: AgentTeamDurableStartInput): Promise<AgentTeamDurableController>;
}

export function isAgentTeamCheckpointState(value: unknown): value is AgentTeamCheckpointState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const state = value as Partial<AgentTeamCheckpointState>;
  return state.schemaVersion === AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION
    && state.kind === 'agent_team'
    && typeof state.teamId === 'string'
    && typeof state.treeId === 'string'
    && Array.isArray(state.taskGraph)
    && Boolean(state.mailbox && typeof state.mailbox.nextSeq === 'number');
}
