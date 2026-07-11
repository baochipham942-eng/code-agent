import type {
  ChildRunRef,
  PendingOperation,
  RunAttempt,
  RunCheckpoint,
  RunCursor,
  RunEnvelope,
  RunOwnerLease,
  RunStatus,
} from '../../shared/contract/durableRun';

export interface RunEventAppend {
  type: string;
  payload: unknown;
  recordedAt: number;
}

export interface StoredRunEvent extends RunEventAppend {
  runId: string;
  seq: number;
  attempt: number;
}

export interface RunLeaseClaim {
  runId: string;
  expectedEpoch: number | null;
  ownerId: string;
  processInstanceId: string;
  now: number;
  leaseDurationMs: number;
}

export interface RunTransition {
  runId: string;
  expectedStatus: RunStatus;
  /** Terminal transitions are committed with their terminal event through CheckpointStore. */
  nextStatus: Exclude<RunStatus, 'completed' | 'failed' | 'cancelled'>;
  expectedOwnerEpoch: number;
  updatedAt: number;
}

export interface RunLeaseClaimResult {
  envelope: RunEnvelope;
  owner: RunOwnerLease;
  attempt: RunAttempt;
}

export interface EventAppendRequest {
  runId: string;
  attempt: number;
  expectedOwnerEpoch: number;
  expectedNextSeq: number;
  events: RunEventAppend[];
}

export interface RunStore {
  create(envelope: RunEnvelope, attempt: RunAttempt): Promise<void>;
  get(runId: string): Promise<RunEnvelope | null>;
  listRecoverable(now: number, limit: number): Promise<RunEnvelope[]>;
  /** Claims the owner, increments attempt, and appends the attempt row in one transaction. */
  claimLease(claim: RunLeaseClaim): Promise<RunLeaseClaimResult | null>;
  renewLease(runId: string, owner: RunOwnerLease, leaseExpiresAt: number): Promise<boolean>;
  transition(input: RunTransition): Promise<RunEnvelope | null>;
}

export interface EventStore {
  /** Appends only when owner epoch and expectedNextSeq match; allocation and cursor advance are atomic. */
  append(input: EventAppendRequest): Promise<RunCursor>;
  read(runId: string, afterSeq: number, limit: number): Promise<StoredRunEvent[]>;
}

export interface CheckpointCommit {
  runId: string;
  attempt: number;
  expectedOwnerEpoch: number;
  expectedNextEventSeq: number;
  events: RunEventAppend[];
  checkpoint: RunCheckpoint;
  pendingOperations: PendingOperation[];
  childRuns: ChildRunRef[];
}

export interface CheckpointStore {
  getLatest(runId: string): Promise<RunCheckpoint | null>;
  /**
   * Atomically appends events, advances the cursor, writes the checkpoint, and replaces
   * pending-operation/child projections. External side effects are deliberately outside this transaction.
   */
  commit(input: CheckpointCommit): Promise<RunCheckpoint>;
}

export interface RunRehydrationPlan {
  envelope: RunEnvelope;
  previousAttempt: RunAttempt;
  checkpoint: RunCheckpoint | null;
  pendingOperations: PendingOperation[];
  childRuns: ChildRunRef[];
  requiresHumanConfirmation: PendingOperation[];
}

export interface RunRehydrateRequest {
  runId: string;
  ownerId: string;
  processInstanceId: string;
  now: number;
  leaseDurationMs: number;
}

export interface RunRehydrator {
  inspect(runId: string, now: number): Promise<RunRehydrationPlan | null>;
  /** Claims a fresh owner epoch, increments attempt, and returns a recovering envelope. */
  rehydrate(request: RunRehydrateRequest): Promise<RunRehydrationPlan>;
}
