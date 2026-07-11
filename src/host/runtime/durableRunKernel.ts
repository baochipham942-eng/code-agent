import { createHash } from 'node:crypto';
import {
  DURABLE_RUN_SCHEMA_VERSION,
  type ChildRunRef,
  type PendingOperation,
  type PendingOperationKind,
  type RunCheckpoint,
  type RunEngineRef,
  type RunEnvelope,
  type RunOwnerLease,
  type RunStatus,
  assertChildRunProjection,
  assertRunEnvelope,
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
