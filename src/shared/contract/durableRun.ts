import type { AgentEngineKind } from './agentEngine';

export const DURABLE_RUN_SCHEMA_VERSION = 1 as const;

export type RunStatus =
  | 'created'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'recovering'
  | 'completed'
  | 'failed'
  | 'cancelled';

export const TERMINAL_RUN_STATUSES = ['completed', 'failed', 'cancelled'] as const satisfies readonly RunStatus[];

export const RUN_STATUS_TRANSITIONS: Readonly<Record<RunStatus, readonly RunStatus[]>> = Object.freeze({
  created: ['running', 'recovering', 'cancelled', 'failed'],
  running: ['waiting', 'paused', 'recovering', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'paused', 'recovering', 'failed', 'cancelled'],
  paused: ['running', 'recovering', 'failed', 'cancelled'],
  recovering: ['running', 'waiting', 'paused', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
});

export type RunEngineRef =
  | { kind: 'native' }
  | { kind: 'agent_team'; treeId?: string }
  | { kind: 'dynamic_workflow'; workflowId?: string }
  | { kind: 'external_cli'; engine: Exclude<AgentEngineKind, 'native'>; externalSessionId?: string };

export interface RunCursor {
  /** The next append-only event sequence. Sequence starts at 1 and never resets across attempts. */
  nextEventSeq: number;
  /** Latest durable checkpoint sequence, or 0 before the first checkpoint. */
  checkpointSeq: number;
  /** Engine-owned opaque cursor. It must be versioned by the owning engine. */
  engineCursor?: unknown;
}

export interface RunOwnerLease {
  ownerId: string;
  processInstanceId: string;
  /** Monotonic fencing token. Every takeover increments it. */
  epoch: number;
  leaseExpiresAt: number;
}

export type RunAttemptStatus = 'starting' | 'active' | 'ended' | 'lost';

export interface RunAttempt {
  runId: string;
  attempt: number;
  processInstanceId: string;
  ownerId: string;
  ownerEpoch: number;
  status: RunAttemptStatus;
  resumedFromCheckpointSeq?: number;
  recoveryReason?: 'process_exit' | 'lease_expired' | 'manual_retry';
  startedAt: number;
  endedAt?: number;
}

export type PendingOperationKind = 'model_call' | 'tool_call' | 'approval' | 'child_run' | 'external_engine';
export type PendingOperationStatus =
  | 'prepared'
  | 'dispatched'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'abandoned'
  | 'unknown';

export interface PendingOperation {
  runId: string;
  operationId: string;
  attempt: number;
  kind: PendingOperationKind;
  status: PendingOperationStatus;
  /** Stable across attempts. A retry of the same logical operation must reuse this key. */
  idempotencyKey: string;
  sideEffect: boolean;
  requiresHumanConfirmation?: boolean;
  inputDigest?: string;
  providerOperationId?: string;
  resultRef?: string;
  preparedAt: number;
  updatedAt: number;
}

export type ChildRunRelation = 'agent' | 'workflow' | 'delegated_engine';

export interface ChildRunRef {
  parentRunId: string;
  childRunId: string;
  relation: ChildRunRelation;
  status: RunStatus;
  createdAt: number;
  terminalAt?: number;
}

export interface RunCheckpoint {
  runId: string;
  checkpointSeq: number;
  attempt: number;
  /** Highest event included in the same atomic commit. */
  eventSeq: number;
  status: Exclude<RunStatus, 'created'>;
  cursor: RunCursor;
  state: unknown;
  checksum: string;
  createdAt: number;
}

export interface RunTerminal {
  status: Extract<RunStatus, 'completed' | 'failed' | 'cancelled'>;
  eventSeq: number;
  at: number;
  reason?: string;
}

export interface RunEnvelope {
  schemaVersion: typeof DURABLE_RUN_SCHEMA_VERSION;
  /** Logical execution identity. Stable across crash recovery attempts. */
  runId: string;
  /** Conversation identity. Multiple sequential runs may belong to one session. */
  sessionId: string;
  engine: RunEngineRef;
  status: RunStatus;
  attempt: number;
  cursor: RunCursor;
  owner?: RunOwnerLease;
  parentRunId?: string;
  pendingOperations?: PendingOperation[];
  childRuns?: ChildRunRef[];
  terminal?: RunTerminal;
  createdAt: number;
  updatedAt: number;
}

export function isTerminalRunStatus(status: RunStatus): status is RunTerminal['status'] {
  return (TERMINAL_RUN_STATUSES as readonly RunStatus[]).includes(status);
}

export function canTransitionRunStatus(from: RunStatus, to: RunStatus): boolean {
  return RUN_STATUS_TRANSITIONS[from].includes(to);
}

export function assertRunEnvelope(envelope: RunEnvelope): void {
  if (envelope.schemaVersion !== DURABLE_RUN_SCHEMA_VERSION) {
    throw new Error(`Unsupported RunEnvelope schemaVersion: ${envelope.schemaVersion}`);
  }
  if (!envelope.runId || envelope.runId === envelope.sessionId) {
    throw new Error('runId must be non-empty and distinct from sessionId');
  }
  if (!envelope.sessionId) throw new Error('sessionId must be non-empty');
  if (!Number.isInteger(envelope.attempt) || envelope.attempt < 1) {
    throw new Error('attempt must be a positive integer');
  }
  if (!Number.isInteger(envelope.cursor.nextEventSeq) || envelope.cursor.nextEventSeq < 1) {
    throw new Error('cursor.nextEventSeq must be a positive integer');
  }
  if (!Number.isInteger(envelope.cursor.checkpointSeq) || envelope.cursor.checkpointSeq < 0) {
    throw new Error('cursor.checkpointSeq must be a non-negative integer');
  }
  if (isTerminalRunStatus(envelope.status)) {
    if (!envelope.terminal) throw new Error('terminal metadata is required for a terminal run');
    if (envelope.terminal.status !== envelope.status) throw new Error('terminal status must match run status');
    if (envelope.terminal.eventSeq < 1 || envelope.terminal.eventSeq >= envelope.cursor.nextEventSeq) {
      throw new Error('terminal eventSeq must reference an appended event');
    }
    if (envelope.status === 'completed') {
      const unresolvedOperation = envelope.pendingOperations?.find(
        (operation) => !['succeeded', 'failed', 'abandoned'].includes(operation.status),
      );
      if (unresolvedOperation) throw new Error('completed runs cannot contain unresolved operations');
      const activeChild = envelope.childRuns?.find((child) => !isTerminalRunStatus(child.status));
      if (activeChild) throw new Error('completed runs cannot contain active child runs');
    }
  } else if (envelope.terminal) {
    throw new Error('non-terminal runs cannot carry terminal metadata');
  }
  if (envelope.owner) {
    if (envelope.owner.epoch < 1 || envelope.owner.leaseExpiresAt <= 0) {
      throw new Error('owner lease requires a positive epoch and expiry');
    }
  }
}
