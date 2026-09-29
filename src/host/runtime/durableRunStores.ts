import type {
  ChildRunRef,
  PendingOperation,
  RunAttempt,
  RunCheckpoint,
  RunCursor,
  RunEnvelope,
  RunInterruptCause,
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

export interface RunAbandonedLeaseClaim extends RunLeaseClaim {
  abandonedProcessInstanceId: string;
}

export interface RunTransition {
  runId: string;
  expectedStatus: RunStatus;
  /** Terminal transitions are committed with their terminal event through CheckpointStore. */
  nextStatus: Exclude<RunStatus, 'completed' | 'failed' | 'cancelled'>;
  expectedOwnerEpoch: number;
  updatedAt: number;
}

/**
 * ③（N-CLI-DURABLE-TERMINAL-LOST）：不持有租约也能收尸的「不可续跑停靠 run」。
 * 判据 fence 由仓储层在同一事务内校验：status=waiting 且末事件恰为该复核结论。
 */
export interface UnresumableParkedRunCancel {
  runId: string;
  sessionId: string;
  now: number;
  /** 终态 reason，同时写进 run_cancelled 事件 payload。 */
  reason: string;
  /** 只有 run 的末事件恰为这个复核结论时才允许收尸。 */
  requireLastEvent: { type: 'native_recovery_requires_review'; reviewReason: string };
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
  getLatestBySession(sessionId: string): Promise<RunEnvelope | null>;
  getLatestActiveRootBySession(sessionId: string): Promise<RunEnvelope | null>;
  listRecoverable(now: number, limit: number): Promise<RunEnvelope[]>;
  /**
   * Lists expired runs that restart must reclaim as parked (never auto-resumed):
   * crash candidates whose automatic resume budget is exhausted, plus runs
   * explicitly parked by user_stop / guard_halt (ADR-075 修订 2026-09-29).
   */
  listParkedForReclaim?(now: number, limit: number): Promise<RunEnvelope[]>;
  /** Claims the owner, increments attempt, and appends the attempt row in one transaction. */
  claimLease(claim: RunLeaseClaim): Promise<RunLeaseClaimResult | null>;
  /**
   * Take over a lease whose owning CLI process is gone, even if the wall-clock
   * expiry has not passed. The abandoned process_instance_id must still match.
   */
  claimAbandonedLease(claim: RunAbandonedLeaseClaim): Promise<RunLeaseClaimResult | null>;
  renewLease(runId: string, owner: RunOwnerLease, leaseExpiresAt: number): Promise<boolean>;
  transition(input: RunTransition): Promise<RunEnvelope | null>;
  releaseLease(runId: string, owner: RunOwnerLease, now: number): Promise<boolean>;
  /**
   * ③（N-CLI-DURABLE-TERMINAL-LOST）：强制终态化「被活进程停靠、但停靠结论是
   * native_workspace_unavailable（没人能真正续跑）」的 run。不经过租约认领；
   * 判据不成立或并发变更时返回 false。可选：内存桩/旧仓储实现不提供即视作不支持。
   */
  cancelUnresumableParkedRun?(input: UnresumableParkedRunCancel): Promise<boolean>;
  getAttempt(runId: string, attempt: number): Promise<RunAttempt | null>;
  listPendingOperations(runId: string): Promise<PendingOperation[]>;
  listChildRuns(runId: string): Promise<ChildRunRef[]>;
  replaceRecoveryProjection(input: RecoveryProjectionReplace): Promise<RunEnvelope>;
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
  interruptCause?: RunInterruptCause;
  autoResumeCount?: number;
  clearInterruptCause?: boolean;
}

export interface CheckpointStore {
  getLatest(runId: string): Promise<RunCheckpoint | null>;
  /**
   * Atomically appends events, advances the cursor, writes the checkpoint, and replaces
   * pending-operation/child projections. External side effects are deliberately outside this transaction.
   */
  commit(input: CheckpointCommit): Promise<RunCheckpoint>;
  commitTerminal(input: TerminalCommit): Promise<RunEnvelope>;
}

export interface RecoveryProjectionReplace {
  runId: string;
  attempt: number;
  expectedOwnerEpoch: number;
  status: 'recovering' | 'waiting';
  pendingOperations: PendingOperation[];
  interruptCause?: RunInterruptCause;
  autoResumeCount?: number;
  updatedAt: number;
}

export interface TerminalCommit {
  runId: string;
  attempt: number;
  expectedOwnerEpoch: number;
  expectedNextEventSeq: number;
  status: 'completed' | 'failed' | 'cancelled';
  reason?: string;
  event: RunEventAppend;
  terminalAt: number;
}

export type DurableRunStores = RunStore & EventStore & CheckpointStore;

export interface RunRehydrationPlan {
  envelope: RunEnvelope;
  previousAttempt: RunAttempt;
  checkpoint: RunCheckpoint | null;
  pendingOperations: PendingOperation[];
  childRuns: ChildRunRef[];
  requiresHumanConfirmation: PendingOperation[];
  /** The run is parked for an explicit Continue action and must not enter recovery handlers. */
  resumeBlocked?: boolean;
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
