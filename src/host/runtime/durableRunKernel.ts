import { createHash } from 'node:crypto';
import {
  DURABLE_RUN_SCHEMA_VERSION,
  type ChildRunRef,
  type PendingOperation,
  type RunCheckpoint,
  type RunEnvelope,
  type RunOwnerLease,
} from '../../shared/contract/durableRun';
import type {
  DurableRunStores,
  RunEventAppend,
  RunLeaseClaimResult,
  RunRehydrationPlan,
} from './durableRunStores';

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

/** Narrow adapter consumed by Native now and by S4/S5 tool/approval wiring later. */
export interface RunKernelAdapter {
  createNativeRun(input: NativeRunCreateInput): Promise<RunLeaseClaimResult>;
  heartbeat(runId: string, owner: RunOwnerLease, now: number): Promise<RunOwnerLease>;
  checkpoint(input: DurableCheckpointInput): Promise<RunCheckpoint>;
  terminal(input: DurableTerminalInput): Promise<RunEnvelope>;
  release(runId: string, owner: RunOwnerLease, now: number): Promise<boolean>;
  recoverOnStartup(now: number, limit?: number): Promise<RunRehydrationPlan[]>;
  prepareToolOperation(input: {
    runId: string;
    logicalCallId: string;
    attempt: number;
    sideEffect: boolean;
    canDeduplicate: boolean;
    now: number;
    inputDigest?: string;
  }): PendingOperation;
}

export class DurableRunKernel implements RunKernelAdapter {
  private readonly stores: DurableRunStores | null;
  private readonly ownerId: string;
  private readonly processInstanceId: string;
  private readonly leaseDurationMs: number;

  constructor(options: DurableRunKernelOptions) {
    this.stores = options.stores;
    this.ownerId = options.ownerId;
    this.processInstanceId = options.processInstanceId;
    this.leaseDurationMs = options.leaseDurationMs;
  }

  async createNativeRun(input: NativeRunCreateInput): Promise<RunLeaseClaimResult> {
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
      engine: { kind: 'native' },
      status: 'running',
      attempt: 1,
      cursor: { nextEventSeq: 1, checkpointSeq: 0 },
      owner,
      parentRunId: input.parentRunId,
      pendingOperations: [],
      childRuns: [],
      createdAt: input.now,
      updatedAt: input.now,
    };
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

  async heartbeat(runId: string, owner: RunOwnerLease, now: number): Promise<RunOwnerLease> {
    const stores = this.requireStores();
    const renewed = { ...owner, leaseExpiresAt: now + this.leaseDurationMs };
    if (!await stores.renewLease(runId, owner, renewed.leaseExpiresAt)) {
      throw new Error(`Heartbeat fenced by stale owner: ${runId}`);
    }
    return renewed;
  }

  async checkpoint(input: DurableCheckpointInput): Promise<RunCheckpoint> {
    const stores = this.requireStores();
    const envelope = await stores.get(input.runId);
    if (!envelope) throw new Error(`Unknown durable run: ${input.runId}`);
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
    });
  }

  async terminal(input: DurableTerminalInput): Promise<RunEnvelope> {
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
    const recoverable = await stores.listRecoverable(now, limit);
    const plans: RunRehydrationPlan[] = [];
    for (const envelope of recoverable) {
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

  prepareToolOperation(input: {
    runId: string;
    logicalCallId: string;
    attempt: number;
    sideEffect: boolean;
    canDeduplicate: boolean;
    now: number;
    inputDigest?: string;
  }): PendingOperation {
    const idempotencyKey = checksum({ runId: input.runId, kind: 'tool_call', logicalCallId: input.logicalCallId });
    return {
      runId: input.runId,
      operationId: input.logicalCallId,
      attempt: input.attempt,
      kind: 'tool_call',
      status: 'prepared',
      idempotencyKey,
      sideEffect: input.sideEffect,
      requiresHumanConfirmation: input.sideEffect && !input.canDeduplicate,
      inputDigest: input.inputDigest,
      preparedAt: input.now,
      updatedAt: input.now,
    };
  }

  private requireStores(): DurableRunStores {
    if (!this.stores) throw new DurableRunPersistenceUnavailableError();
    return this.stores;
  }
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
