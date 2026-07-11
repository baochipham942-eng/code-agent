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

export interface ChildRunCreateInput {
  parentRunId: string;
  childRunId: string;
  relation: ChildRunRelation;
  now: number;
  initialStatus?: Exclude<RunStatus, RunTerminal['status']>;
}

export interface ChildRunTerminalProjectionInput {
  childRunId: string;
  status: RunTerminal['status'];
  terminalAt: number;
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

export function createChildRunRef(input: ChildRunCreateInput): ChildRunRef {
  const child: ChildRunRef = {
    parentRunId: input.parentRunId,
    childRunId: input.childRunId,
    relation: input.relation,
    status: input.initialStatus ?? 'created',
    createdAt: input.now,
  };
  assertChildRunRef(child);
  return child;
}

export function addChildRunRef(childRuns: ChildRunRef[], child: ChildRunRef): ChildRunRef[] {
  assertChildRunRef(child);
  for (const existing of childRuns) {
    assertChildRunRef(existing);
    if (existing.parentRunId !== child.parentRunId) {
      throw new Error('Child projections cannot mix parentRunId identities');
    }
    if (existing.childRunId !== child.childRunId) continue;
    if (
      existing.relation === child.relation
      && existing.status === child.status
      && existing.createdAt === child.createdAt
      && existing.terminalAt === child.terminalAt
    ) {
      return childRuns;
    }
    throw new Error(`Duplicate child identity has conflicting projection: ${child.parentRunId}/${child.childRunId}`);
  }
  return [...childRuns, child];
}

export function assertChildRunProjection(parentRunId: string, childRuns: readonly ChildRunRef[]): void {
  const childIds = new Set<string>();
  for (const child of childRuns) {
    assertChildRunRef(child);
    if (child.parentRunId !== parentRunId) throw new Error('Child parentRunId must match envelope runId');
    if (childIds.has(child.childRunId)) throw new Error(`Duplicate child identity: ${child.childRunId}`);
    childIds.add(child.childRunId);
  }
}

/** Pure projection helper. Persist the returned childRuns only through a fenced checkpoint commit. */
export function projectChildRunTerminal(
  envelope: RunEnvelope,
  input: ChildRunTerminalProjectionInput,
): RunEnvelope {
  assertRunEnvelope(envelope);
  let matched = false;
  const childRuns = (envelope.childRuns ?? []).map((child) => {
    if (child.childRunId !== input.childRunId) return child;
    matched = true;
    if (child.parentRunId !== envelope.runId) {
      throw new Error(`Child parentRunId does not match envelope runId: ${child.childRunId}`);
    }
    if (isTerminalRunStatus(child.status)) {
      if (child.status === input.status && child.terminalAt === input.terminalAt) return child;
      throw new Error(`Child run already has a conflicting terminal projection: ${child.childRunId}`);
    }
    return { ...child, status: input.status, terminalAt: input.terminalAt };
  });
  if (!matched) throw new Error(`Unknown child run: ${input.childRunId}`);
  const projected = { ...envelope, childRuns, updatedAt: input.terminalAt };
  assertRunEnvelope(projected);
  return projected;
}

function assertChildRunRef(child: ChildRunRef): void {
  if (!child.parentRunId || !child.childRunId) {
    throw new Error('Child run parentRunId and childRunId must be non-empty');
  }
  if (child.parentRunId === child.childRunId) {
    throw new Error('Child run cannot reference itself');
  }
  if (!['agent', 'workflow', 'delegated_engine'].includes(child.relation)) {
    throw new Error(`Unsupported child run relation: ${String(child.relation)}`);
  }
  if (!(child.status in RUN_STATUS_TRANSITIONS)) {
    throw new Error(`Unsupported child run status: ${String(child.status)}`);
  }
  if (!Number.isFinite(child.createdAt)) throw new Error('Child run createdAt must be finite');
  if (isTerminalRunStatus(child.status)) {
    if (!Number.isFinite(child.terminalAt)) throw new Error('Terminal child run requires terminalAt');
  } else if (child.terminalAt !== undefined) {
    throw new Error('Non-terminal child run cannot carry terminalAt');
  }
}

export function assertRunEnvelope(envelope: RunEnvelope): void {
  if (envelope.schemaVersion !== DURABLE_RUN_SCHEMA_VERSION) {
    throw new Error(`Unsupported RunEnvelope schemaVersion: ${envelope.schemaVersion}`);
  }
  if (!envelope.runId || envelope.runId === envelope.sessionId) {
    throw new Error('runId must be non-empty and distinct from sessionId');
  }
  if (!envelope.sessionId) throw new Error('sessionId must be non-empty');
  if (!(envelope.engine.kind in {
    native: true,
    agent_team: true,
    dynamic_workflow: true,
    external_cli: true,
  })) {
    throw new Error(`Unsupported run engine kind: ${String(envelope.engine.kind)}`);
  }
  if (envelope.engine.kind === 'external_cli' && String(envelope.engine.engine) === 'native') {
    throw new Error('external_cli must reference a non-native engine');
  }
  if (envelope.parentRunId !== undefined) {
    if (!envelope.parentRunId) throw new Error('parentRunId must be non-empty when provided');
    if (envelope.parentRunId === envelope.runId) throw new Error('run cannot reference itself as parent');
  }
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
  const operationIds = new Set<string>();
  const idempotencyKeys = new Set<string>();
  for (const operation of envelope.pendingOperations ?? []) {
    if (operation.runId !== envelope.runId) throw new Error('Pending operation runId must match envelope runId');
    if (!operation.operationId || !operation.idempotencyKey) {
      throw new Error('Pending operation identity must be non-empty');
    }
    if (operation.attempt < 1 || !Number.isInteger(operation.attempt)) {
      throw new Error('Pending operation attempt must be a positive integer');
    }
    if (operation.attempt > envelope.attempt) {
      throw new Error('Pending operation attempt cannot be newer than the envelope attempt');
    }
    if (operationIds.has(operation.operationId)) throw new Error(`Duplicate operation identity: ${operation.operationId}`);
    if (idempotencyKeys.has(operation.idempotencyKey)) throw new Error(`Duplicate operation idempotency key: ${operation.idempotencyKey}`);
    operationIds.add(operation.operationId);
    idempotencyKeys.add(operation.idempotencyKey);
  }
  assertChildRunProjection(envelope.runId, envelope.childRuns ?? []);
}
