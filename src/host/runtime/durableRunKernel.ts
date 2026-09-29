import { createHash } from 'node:crypto';
import {
  DURABLE_RUN_SCHEMA_VERSION,
  isTerminalRunStatus,
  type ChildRunRef,
  type PendingOperation,
  type PendingOperationKind,
  type RunCheckpoint,
  type RunEngineRef,
  type RunEnvelope,
  type RunInterruptCause,
  type RunOwnerLease,
  type RunStatus,
  assertChildRunProjection,
  assertRunEnvelope,
  getRunInterruptCause,
  MAX_AUTO_RESUME_COUNT,
} from '../../shared/contract/durableRun';
import type {
  DurableRunStores,
  RunEventAppend,
  RunLeaseClaimResult,
  RunRehydrationPlan,
} from './durableRunStores';
import { canClaimOrphanedCliLease, isAbandonedCliProcess } from './cliOrphanLease';
import { createKeyedSerializer } from './keyedSerializer';

export class DurableRunPersistenceUnavailableError extends Error {
  readonly code = 'DURABLE_RUN_PERSISTENCE_UNAVAILABLE';

  constructor() {
    super('Durable Run persistence is unavailable; refusing to execute without a durable fact source');
    this.name = 'DurableRunPersistenceUnavailableError';
  }
}

export interface DurableRunKernelOptions {
  stores: DurableRunStores | null;
  ownerId: string;
  processInstanceId: string;
  leaseDurationMs: number;
}

export interface NativeRunCreateInput {
  runId: string;
  sessionId: string;
  now: number;
  parentRunId?: string;
}

export interface DurableRunCreateInput {
  runId: string;
  sessionId: string;
  engine: RunEngineRef;
  now: number;
  parentRunId?: string;
  initialStatus?: Exclude<RunStatus, 'completed' | 'failed' | 'cancelled'>;
  initialEngineCursor?: unknown;
  initialPendingOperations?: PendingOperation[];
  initialChildRuns?: ChildRunRef[];
}

export interface PrepareOperationInput {
  runId: string;
  operationId: string;
  /** Stable logical identity. Defaults to operationId and remains unchanged across attempts. */
  logicalOperationId?: string;
  attempt: number;
  kind: PendingOperationKind;
  sideEffect: boolean;
  canDeduplicate: boolean;
  now: number;
  inputDigest?: string;
  providerOperationId?: string;
  requiresHumanConfirmation?: boolean;
}

export interface PrepareToolOperationInput {
  runId: string;
  logicalCallId: string;
  attempt: number;
  sideEffect: boolean;
  canDeduplicate: boolean;
  now: number;
  inputDigest?: string;
}

export interface DurableCheckpointInput {
  runId: string;
  attempt: number;
  owner: RunOwnerLease;
  now: number;
  status: RunCheckpoint['status'];
  state: unknown;
  engineCursor?: unknown;
  pendingOperations: PendingOperation[];
  childRuns?: ChildRunRef[];
  events: RunEventAppend[];
  /** Persisted in the same transaction as the checkpoint/fence. */
  interruptCause?: RunInterruptCause;
  autoResumeCount?: number;
  clearInterruptCause?: boolean;
}

export interface DurableTerminalInput {
  runId: string;
  attempt: number;
  owner: RunOwnerLease;
  now: number;
  status: 'completed' | 'failed' | 'cancelled';
  reason?: string;
  event: RunEventAppend;
}

/** Frozen narrow adapter shared by Native and S4/S5/S6 engine integrations. */
export interface RunKernelAdapter {
  createRun(input: DurableRunCreateInput): Promise<RunLeaseClaimResult>;
  createNativeRun(input: NativeRunCreateInput): Promise<RunLeaseClaimResult>;
  heartbeat(runId: string, owner: RunOwnerLease, now: number): Promise<RunOwnerLease>;
  checkpoint(input: DurableCheckpointInput): Promise<RunCheckpoint>;
  terminal(input: DurableTerminalInput): Promise<RunEnvelope>;
  release(runId: string, owner: RunOwnerLease, now: number): Promise<boolean>;
  recoverOnStartup(now: number, limit?: number): Promise<RunRehydrationPlan[]>;
  prepareOperation(input: PrepareOperationInput): PendingOperation;
  prepareToolOperation(input: PrepareToolOperationInput): PendingOperation;
  getLatestBySession?(sessionId: string): Promise<RunEnvelope | null>;
  getLatestActiveRootBySession?(sessionId: string): Promise<RunEnvelope | null>;
  stealLease?(input: {
    runId: string;
    expectedEpoch: number;
    now: number;
  }): Promise<RunLeaseClaimResult | null>;
  cancelOrphanedSessionRoot?(input: {
    sessionId: string;
    expectedOwnerId: string;
    processInstanceId: string;
    now?: number;
  }): Promise<boolean>;
}

export class DurableRunKernel implements RunKernelAdapter {
  private readonly stores: DurableRunStores | null;
  private readonly ownerId: string;
  private readonly processInstanceId: string;
  private readonly leaseDurationMs: number;
  private readonly serializeRun = createKeyedSerializer();

  constructor(options: DurableRunKernelOptions) {
    this.stores = options.stores;
    this.ownerId = options.ownerId;
    this.processInstanceId = options.processInstanceId;
    this.leaseDurationMs = options.leaseDurationMs;
  }

  async createRun(input: DurableRunCreateInput): Promise<RunLeaseClaimResult> {
    const stores = this.requireStores();
    const owner: RunOwnerLease = {
      ownerId: this.ownerId,
      processInstanceId: this.processInstanceId,
      epoch: 1,
      leaseExpiresAt: input.now + this.leaseDurationMs,
    };
    const envelope: RunEnvelope = {
      schemaVersion: DURABLE_RUN_SCHEMA_VERSION,
      runId: input.runId,
      sessionId: input.sessionId,
      engine: input.engine,
      status: input.initialStatus ?? 'running',
      attempt: 1,
      cursor: {
        nextEventSeq: 1,
        checkpointSeq: 0,
        ...(input.initialEngineCursor === undefined ? {} : { engineCursor: input.initialEngineCursor }),
      },
      owner,
      parentRunId: input.parentRunId,
      pendingOperations: input.initialPendingOperations ?? [],
      childRuns: input.initialChildRuns ?? [],
      autoResumeCount: 0,
      createdAt: input.now,
      updatedAt: input.now,
    };
    assertRunEnvelope(envelope);
    const attempt = {
      runId: input.runId,
      attempt: 1,
      processInstanceId: this.processInstanceId,
      ownerId: this.ownerId,
      ownerEpoch: 1,
      status: 'active' as const,
      startedAt: input.now,
    };
    await stores.create(envelope, attempt);
    return { envelope, owner, attempt };
  }

  async createNativeRun(input: NativeRunCreateInput): Promise<RunLeaseClaimResult> {
    return this.createRun({ ...input, engine: { kind: 'native' } });
  }

  async heartbeat(runId: string, owner: RunOwnerLease, now: number): Promise<RunOwnerLease> {
    const stores = this.requireStores();
    const renewed = { ...owner, leaseExpiresAt: now + this.leaseDurationMs };
    if (!await stores.renewLease(runId, owner, renewed.leaseExpiresAt)) {
      throw new Error(`Heartbeat fenced by stale owner: ${runId}`);
    }
    return renewed;
  }

  async checkpoint(input: DurableCheckpointInput): Promise<RunCheckpoint> {
    return this.serializeRun(input.runId, () => this.checkpointNow(input));
  }

  async terminal(input: DurableTerminalInput): Promise<RunEnvelope> {
    return this.serializeRun(input.runId, () => this.terminalNow(input));
  }

  async getLatestBySession(sessionId: string): Promise<RunEnvelope | null> {
    return this.requireStores().getLatestBySession(sessionId);
  }

  async getLatestActiveRootBySession(sessionId: string): Promise<RunEnvelope | null> {
    return this.requireStores().getLatestActiveRootBySession(sessionId);
  }

  async stealLease(input: {
    runId: string;
    expectedEpoch: number;
    now: number;
  }): Promise<RunLeaseClaimResult | null> {
    return this.requireStores().claimLease({
      runId: input.runId,
      expectedEpoch: input.expectedEpoch,
      ownerId: this.ownerId,
      processInstanceId: this.processInstanceId,
      now: input.now,
      leaseDurationMs: this.leaseDurationMs,
    });
  }

  async cancelOrphanedSessionRoot(input: {
    sessionId: string;
    expectedOwnerId: string;
    processInstanceId: string;
    now?: number;
  }): Promise<boolean> {
    const now = input.now ?? Date.now();
    const latest = await this.getLatestActiveRootBySession(input.sessionId);
    if (!latest || isTerminalRunStatus(latest.status) || latest.parentRunId) return false;
    if (latest.owner?.ownerId !== input.expectedOwnerId) return false;
    if (latest.owner.processInstanceId === input.processInstanceId) return false;
    if (!canClaimOrphanedCliLease(latest.owner.processInstanceId, latest.owner.leaseExpiresAt, now)) {
      return this.cancelUnresumableParkedSessionRoot(latest, input.sessionId, now);
    }
    const expired = (latest.owner.leaseExpiresAt ?? 0) <= now;
    const abandoned = isAbandonedCliProcess(latest.owner.processInstanceId);
    const claimed = abandoned && !expired
      ? await this.requireStores().claimAbandonedLease({
          runId: latest.runId,
          expectedEpoch: latest.owner.epoch,
          ownerId: this.ownerId,
          processInstanceId: this.processInstanceId,
          now,
          leaseDurationMs: this.leaseDurationMs,
          abandonedProcessInstanceId: latest.owner.processInstanceId,
        })
      : await this.stealLease({
          runId: latest.runId,
          expectedEpoch: latest.owner.epoch,
          now,
        });
    if (!claimed) return false;
    await this.terminal({
      runId: latest.runId,
      attempt: claimed.attempt.attempt,
      owner: claimed.owner,
      now,
      status: 'cancelled',
      reason: 'orphaned_cli_session_root',
      event: {
        type: 'run_cancelled',
        payload: { sessionId: input.sessionId, reason: 'orphaned_cli_session_root' },
        recordedAt: now,
      },
    });
    return true;
  }

  /**
   * ③（N-CLI-DURABLE-TERMINAL-LOST）：租约未过期、owner 视为存活（CLI peer 活进程，或
   * pid 形状解析失败的非 CLI owner——后者 isAbandonedCliProcess 不敢断死，同样落到这
   * 条路径），跨进程判据拒收——但 run 是 waiting 且接管方已判 native_workspace_unavailable
   * （工作区不存在，任何续跑/人工继续路径都会再次判同一个结论），这条租约续的是个没人
   * 能用的死胡同。允许收尸放行 `-s` 续跑：不认领租约，判据 fence（status=waiting +
   * 末事件复核结论原样）在仓储层同笔事务里校验，不成立即退回原冲突语义。真冲突保护
   * 不受影响：running/recovering（有活 handle 或恢复驱动在跑）与其他复核原因（可人工
   * 处置）仍拒收。
   */
  private async cancelUnresumableParkedSessionRoot(
    latest: RunEnvelope,
    sessionId: string,
    now: number,
  ): Promise<boolean> {
    const stores = this.stores;
    if (!stores?.cancelUnresumableParkedRun) return false;
    return stores.cancelUnresumableParkedRun({
      runId: latest.runId,
      sessionId,
      now,
      reason: 'cli_resume_reaped_workspace_unavailable',
      requireLastEvent: { type: 'native_recovery_requires_review', reviewReason: 'native_workspace_unavailable' },
    });
  }

  private async checkpointNow(input: DurableCheckpointInput): Promise<RunCheckpoint> {
    const stores = this.requireStores();
    const envelope = await stores.get(input.runId);
    if (!envelope) throw new Error(`Unknown durable run: ${input.runId}`);
    assertChildRunProjection(input.runId, input.childRuns ?? envelope.childRuns ?? []);
    const nextEventSeq = envelope.cursor.nextEventSeq + input.events.length;
    const checkpoint: RunCheckpoint = {
      runId: input.runId,
      checkpointSeq: envelope.cursor.checkpointSeq + 1,
      attempt: input.attempt,
      eventSeq: nextEventSeq - 1,
      status: input.status,
      cursor: {
        nextEventSeq,
        checkpointSeq: envelope.cursor.checkpointSeq + 1,
        engineCursor: input.engineCursor,
      },
      state: input.state,
      checksum: checksum({
        runId: input.runId,
        attempt: input.attempt,
        status: input.status,
        state: input.state,
        engineCursor: input.engineCursor,
        nextEventSeq,
      }),
      createdAt: input.now,
    };
    return stores.commit({
      runId: input.runId,
      attempt: input.attempt,
      expectedOwnerEpoch: input.owner.epoch,
      expectedNextEventSeq: envelope.cursor.nextEventSeq,
      events: input.events,
      checkpoint,
      pendingOperations: input.pendingOperations,
      childRuns: input.childRuns ?? envelope.childRuns ?? [],
      interruptCause: input.interruptCause,
      autoResumeCount: input.autoResumeCount,
      clearInterruptCause: input.clearInterruptCause,
    });
  }

  private async terminalNow(input: DurableTerminalInput): Promise<RunEnvelope> {
    const stores = this.requireStores();
    const envelope = await stores.get(input.runId);
    if (!envelope) throw new Error(`Unknown durable run: ${input.runId}`);
    return stores.commitTerminal({
      runId: input.runId,
      attempt: input.attempt,
      expectedOwnerEpoch: input.owner.epoch,
      expectedNextEventSeq: envelope.cursor.nextEventSeq,
      status: input.status,
      reason: input.reason,
      event: input.event,
      terminalAt: input.now,
    });
  }

  async release(runId: string, owner: RunOwnerLease, now: number): Promise<boolean> {
    return this.requireStores().releaseLease(runId, owner, now);
  }

  async recoverOnStartup(now: number, limit = 100): Promise<RunRehydrationPlan[]> {
    const stores = this.requireStores();
    // 预算耗尽的崩溃 run 与显式停靠（user_stop / guard_halt）的 run：重启后认领为本进程持有、
    // 停靠成 waiting 等用户「继续」，永不进自动续跑（ADR-075 修订 2026-09-29）。
    const parked = stores.listParkedForReclaim
      ? await stores.listParkedForReclaim(now, limit)
      : [];
    const plans: RunRehydrationPlan[] = [];
    for (const envelope of parked) {
      const previousAttempt = await stores.getAttempt(envelope.runId, envelope.attempt);
      if (!previousAttempt) throw new Error(`Missing durable attempt ${envelope.runId}/${envelope.attempt}`);
      const checkpoint = await stores.getLatest(envelope.runId);
      const pendingOperations = await stores.listPendingOperations(envelope.runId);
      const childRuns = await stores.listChildRuns(envelope.runId);
      const claimed = await stores.claimLease({
        runId: envelope.runId,
        expectedEpoch: envelope.owner?.epoch ?? null,
        ownerId: this.ownerId,
        processInstanceId: this.processInstanceId,
        now,
        leaseDurationMs: this.leaseDurationMs,
      });
      if (!claimed) continue;
      const parkedEnvelope = await stores.replaceRecoveryProjection({
        runId: envelope.runId,
        attempt: claimed.attempt.attempt,
        expectedOwnerEpoch: claimed.owner.epoch,
        status: 'waiting',
        pendingOperations,
        // 崩溃预算耗尽的停靠在数据上显式标成 budget_exhausted（ADR-075 修订二）：再次重启按标记认领，
        // 不靠 crash_or_quit + 计数推断（那会与「预算耗尽后又等审批」的 waiting 混淆）。
        interruptCause: parkedInterruptCause(getRunInterruptCause(claimed.envelope)),
        autoResumeCount: claimed.envelope.autoResumeCount ?? MAX_AUTO_RESUME_COUNT,
        updatedAt: now,
      });
      plans.push({
        envelope: parkedEnvelope,
        previousAttempt,
        checkpoint,
        pendingOperations,
        childRuns,
        requiresHumanConfirmation: [],
        resumeBlocked: true,
      });
    }
    const recoverable = await stores.listRecoverable(now, limit);
    for (const envelope of recoverable) {
      const interruptCause = getRunInterruptCause(envelope);
      if (interruptCause !== undefined && interruptCause !== 'crash_or_quit') continue;
      if ((envelope.autoResumeCount ?? 0) >= MAX_AUTO_RESUME_COUNT) continue;
      const previousAttempt = await stores.getAttempt(envelope.runId, envelope.attempt);
      if (!previousAttempt) throw new Error(`Missing durable attempt ${envelope.runId}/${envelope.attempt}`);
      const checkpoint = await stores.getLatest(envelope.runId);
      const pendingBeforeClaim = await stores.listPendingOperations(envelope.runId);
      const childRuns = await stores.listChildRuns(envelope.runId);
      const claimed = await stores.claimLease({
        runId: envelope.runId,
        expectedEpoch: envelope.owner?.epoch ?? null,
        ownerId: this.ownerId,
        processInstanceId: this.processInstanceId,
        now,
        leaseDurationMs: this.leaseDurationMs,
      });
      if (!claimed) continue;

      const pendingOperations = pendingBeforeClaim.map((operation) =>
        classifyOperationForRecovery(operation, claimed.attempt.attempt, now));
      const requiresHumanConfirmation = pendingOperations.filter((operation) =>
        operation.status === 'unknown' && operation.requiresHumanConfirmation === true);
      const waiting = requiresHumanConfirmation.length > 0
        || pendingOperations.some((operation) => operation.kind === 'approval' && operation.status === 'waiting');
      const recoveredEnvelope = await stores.replaceRecoveryProjection({
        runId: envelope.runId,
        attempt: claimed.attempt.attempt,
        expectedOwnerEpoch: claimed.owner.epoch,
        status: waiting ? 'waiting' : 'recovering',
        pendingOperations,
        interruptCause: getRunInterruptCause(claimed.envelope) ?? 'crash_or_quit',
        // 预算只管前台 native 自动续跑；等审批的 run 只是恢复同一审批，
        // loop / workflow / agent_team 等引擎沿用各自恢复语义，均不消耗。
        autoResumeCount: waiting || claimed.envelope.engine.kind !== 'native'
          ? (claimed.envelope.autoResumeCount ?? 0)
          : Math.min(MAX_AUTO_RESUME_COUNT, (claimed.envelope.autoResumeCount ?? 0) + 1),
        updatedAt: now,
      });
      plans.push({
        envelope: recoveredEnvelope,
        previousAttempt,
        checkpoint,
        pendingOperations,
        childRuns,
        requiresHumanConfirmation,
      });
    }
    return plans;
  }

  prepareOperation(input: PrepareOperationInput): PendingOperation {
    requireOperationIdentity(input.runId, 'runId');
    requireOperationIdentity(input.operationId, 'operationId');
    const logicalOperationId = requireOperationIdentity(
      input.logicalOperationId ?? input.operationId,
      'logicalOperationId',
    );
    if (!Number.isInteger(input.attempt) || input.attempt < 1) {
      throw new Error('operation attempt must be a positive integer');
    }
    const idempotencyKey = checksum({
      runId: input.runId,
      kind: input.kind,
      logicalOperationId,
    });
    return {
      runId: input.runId,
      operationId: input.operationId,
      attempt: input.attempt,
      kind: input.kind,
      status: 'prepared',
      idempotencyKey,
      sideEffect: input.sideEffect,
      requiresHumanConfirmation: input.requiresHumanConfirmation === true
        || (input.sideEffect && !input.canDeduplicate),
      inputDigest: input.inputDigest,
      providerOperationId: input.providerOperationId,
      preparedAt: input.now,
      updatedAt: input.now,
    };
  }

  prepareToolOperation(input: PrepareToolOperationInput): PendingOperation {
    return this.prepareOperation({
      ...input,
      operationId: input.logicalCallId,
      logicalOperationId: input.logicalCallId,
      kind: 'tool_call',
    });
  }

  private requireStores(): DurableRunStores {
    if (!this.stores) throw new DurableRunPersistenceUnavailableError();
    return this.stores;
  }
}

/** listParkedForReclaim 只会带出 crash_or_quit 的预算耗尽行（running/recovering），停靠时改记 budget_exhausted；显式停靠原因原样保留。 */
function parkedInterruptCause(cause: RunInterruptCause | undefined): RunInterruptCause {
  return cause === undefined || cause === 'crash_or_quit' ? 'budget_exhausted' : cause;
}

function classifyOperationForRecovery(
  operation: PendingOperation,
  attempt: number,
  now: number,
): PendingOperation {
  if (['succeeded', 'failed', 'abandoned'].includes(operation.status)) return operation;
  if (operation.kind === 'approval' && operation.status === 'waiting') return operation;
  if (operation.status !== 'dispatched') return { ...operation, attempt, updatedAt: now };

  const deduplicationProven = Boolean(operation.providerOperationId)
    && operation.requiresHumanConfirmation !== true;
  if (!operation.sideEffect || deduplicationProven) {
    return { ...operation, attempt, status: 'prepared', updatedAt: now };
  }
  return {
    ...operation,
    attempt,
    status: 'unknown',
    requiresHumanConfirmation: true,
    updatedAt: now,
  };
}

function checksum(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function requireOperationIdentity(value: string, label: string): string {
  if (!value.trim()) throw new Error(`${label} must be non-empty`);
  return value;
}
