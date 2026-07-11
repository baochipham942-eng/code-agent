import {
  createRunContext,
  createRunHandle,
  type CreateRunContextInput,
  type RunHandle,
} from './runContext';
import type { RunOwnerLease } from '../../shared/contract/durableRun';
import type { ExternalAgentEngineKind } from '../../shared/contract/agentEngine';
import type { PendingOperation } from '../../shared/contract/durableRun';
import type {
  DurableCheckpointInput,
  DurableTerminalInput,
  RunKernelAdapter,
} from './durableRunKernel';
import type { RunRehydrationPlan } from './durableRunStores';
import {
  createRunTraceContext,
  type RunTraceContext,
} from '../telemetry/runTraceContext';
import { getTelemetryService } from '../telemetry/telemetryService';

export class RunSessionConflictError extends Error {
  readonly code = 'RUN_SESSION_CONFLICT';

  constructor(
    readonly sessionId: string,
    readonly existingRunId: string,
  ) {
    super(`Session ${sessionId} already has active run ${existingRunId}`);
    this.name = 'RunSessionConflictError';
  }
}

export interface RunSelector {
  runId?: string;
  sessionId?: string;
}

export interface ExternalDurableRunStart {
  handle: RunHandle;
  launchOperation: PendingOperation;
}

export class RunRegistry {
  private readonly handlesByRunId = new Map<string, RunHandle>();
  private readonly runIdBySessionId = new Map<string, string>();
  private readonly durableOwners = new Map<string, { owner: RunOwnerLease; attempt: number }>();
  private readonly durableTraceContexts = new Map<string, RunTraceContext>();
  private readonly heartbeatTimers = new Map<string, ReturnType<typeof setInterval>>();
  private kernel: RunKernelAdapter | null = null;

  configureDurableKernel(kernel: RunKernelAdapter): void {
    this.kernel = kernel;
  }

  start(input: CreateRunContextInput): RunHandle {
    const context = createRunContext(input);
    const handle = createRunHandle(context);
    this.register(handle);
    return handle;
  }

  /** Durable Native entry point. Existing synchronous start() remains for compatibility callers. */
  async startDurable(input: CreateRunContextInput, now = Date.now()): Promise<RunHandle> {
    const kernel = this.requireKernel();
    const context = createRunContext(input);
    const existingRunId = this.runIdBySessionId.get(context.sessionId);
    if (existingRunId && existingRunId !== context.runId) {
      throw new RunSessionConflictError(context.sessionId, existingRunId);
    }
    const created = await kernel.createNativeRun({
      runId: context.runId,
      sessionId: context.sessionId,
      now,
    });
    const traceContext = createRunTraceContext({
      runId: context.runId,
      sessionId: context.sessionId,
      attempt: created.attempt.attempt,
      ownerEpoch: created.owner.epoch,
      engine: created.envelope.engine.kind,
      workspace: context.workspace,
      parentRunId: created.envelope.parentRunId,
      processInstanceId: created.owner.processInstanceId,
    });
    const handle = createRunHandle(context, traceContext);
    this.register(handle);
    this.durableOwners.set(context.runId, { owner: created.owner, attempt: created.attempt.attempt });
    this.durableTraceContexts.set(context.runId, traceContext);
    this.startAttemptSpan(traceContext);
    this.startHeartbeat(context.runId, created.owner, now);
    return handle;
  }

  async startExternalDurable(
    input: CreateRunContextInput & {
      engine: ExternalAgentEngineKind;
      externalSessionId?: string;
      resumeCapable?: boolean;
    },
    now = Date.now(),
  ): Promise<ExternalDurableRunStart> {
    const kernel = this.requireKernel();
    const context = createRunContext(input);
    const existingRunId = this.runIdBySessionId.get(context.sessionId);
    if (existingRunId && existingRunId !== context.runId) {
      throw new RunSessionConflictError(context.sessionId, existingRunId);
    }
    const launchOperation = kernel.prepareOperation({
      runId: context.runId,
      operationId: 'external-engine-launch',
      logicalOperationId: 'external-engine-launch',
      attempt: 1,
      kind: 'external_engine',
      sideEffect: true,
      canDeduplicate: input.resumeCapable === true && Boolean(input.externalSessionId),
      now,
      providerOperationId: input.resumeCapable && input.externalSessionId
        ? `external-session:${input.externalSessionId}`
        : undefined,
    });
    const created = await kernel.createRun({
      runId: context.runId,
      sessionId: context.sessionId,
      engine: {
        kind: 'external_cli',
        engine: input.engine,
        ...(input.externalSessionId ? { externalSessionId: input.externalSessionId } : {}),
      },
      now,
      initialEngineCursor: {
        schemaVersion: 1,
        engine: input.engine,
        externalSessionId: input.externalSessionId,
      },
      initialPendingOperations: [launchOperation],
    });
    const traceContext = createRunTraceContext({
      runId: context.runId,
      sessionId: context.sessionId,
      attempt: created.attempt.attempt,
      ownerEpoch: created.owner.epoch,
      engine: input.engine,
      workspace: context.workspace,
      processInstanceId: created.owner.processInstanceId,
    });
    const handle = createRunHandle(context, traceContext);
    this.register(handle);
    this.durableOwners.set(context.runId, { owner: created.owner, attempt: created.attempt.attempt });
    this.durableTraceContexts.set(context.runId, traceContext);
    this.startAttemptSpan(traceContext, { 'run.external_engine': input.engine });
    this.startHeartbeat(context.runId, created.owner, now);
    return { handle, launchOperation };
  }

  async heartbeatDurable(runId: string, now = Date.now()): Promise<RunOwnerLease> {
    const live = this.requireDurableOwner(runId);
    const owner = await this.requireKernel().heartbeat(runId, live.owner, now);
    this.durableOwners.set(runId, { ...live, owner });
    return owner;
  }

  async checkpointDurable(
    runId: string,
    input: Omit<DurableCheckpointInput, 'runId' | 'attempt' | 'owner'>,
  ) {
    const live = this.requireDurableOwner(runId);
    return this.requireKernel().checkpoint({
      ...input,
      runId,
      attempt: live.attempt,
      owner: live.owner,
    });
  }

  async terminalDurable(
    runId: string,
    input: Omit<DurableTerminalInput, 'runId' | 'attempt' | 'owner'>,
    expected?: RunHandle,
  ) {
    if (expected && this.handlesByRunId.get(runId) !== expected) {
      throw new Error(`Durable Run terminal fenced by stale handle: ${runId}`);
    }
    const live = this.requireDurableOwner(runId);
    const envelope = await this.requireKernel().terminal({
      ...input,
      runId,
      attempt: live.attempt,
      owner: live.owner,
    });
    this.durableOwners.delete(runId);
    this.stopHeartbeat(runId);
    this.endAttemptSpan(runId, input.status === 'completed' ? 'ok' : input.status === 'cancelled' ? 'cancelled' : 'error', {
      'terminal.status': input.status,
    });
    this.unregister(runId, expected);
    return envelope;
  }

  async releaseDurable(runId: string, expected?: RunHandle, now = Date.now()): Promise<boolean> {
    if (expected && this.handlesByRunId.get(runId) !== expected) return false;
    const live = this.durableOwners.get(runId);
    if (!live) return false;
    const released = await this.requireKernel().release(runId, live.owner, now);
    if (released) {
      this.durableOwners.delete(runId);
      this.stopHeartbeat(runId);
      this.unregister(runId, expected);
      this.endAttemptSpan(runId, 'cancelled', { 'terminal.status': 'released' });
    }
    return released;
  }

  async recoverDurable(now = Date.now()): Promise<RunRehydrationPlan[]> {
    const plans = await this.requireKernel().recoverOnStartup(now);
    for (const plan of plans) {
      const owner = plan.envelope.owner;
      if (owner) {
        const previousTraceContext = this.durableTraceContexts.get(plan.envelope.runId);
        if (previousTraceContext) {
          this.endAttemptSpan(plan.envelope.runId, 'error', { 'terminal.status': 'recovering' });
        }
        const staleHandle = this.handlesByRunId.get(plan.envelope.runId);
        if (staleHandle) this.unregister(plan.envelope.runId, staleHandle);
        const traceContext = createRunTraceContext({
          runId: plan.envelope.runId,
          sessionId: plan.envelope.sessionId,
          attempt: plan.envelope.attempt,
          ownerEpoch: owner.epoch,
          engine: plan.envelope.engine.kind,
          workspaceFingerprint: previousTraceContext?.workspaceFingerprint,
          parentRunId: plan.envelope.parentRunId,
          processInstanceId: owner.processInstanceId,
        });
        this.durableOwners.set(plan.envelope.runId, { owner, attempt: plan.envelope.attempt });
        this.durableTraceContexts.set(plan.envelope.runId, traceContext);
        this.startAttemptSpan(traceContext, {
          'run.recovery': true,
          'run.previous_attempt': plan.previousAttempt.attempt,
          'run.checkpoint_seq': plan.checkpoint?.checkpointSeq ?? 0,
          ...(plan.previousAttempt.recoveryReason
            ? { 'run.recovery_reason': plan.previousAttempt.recoveryReason }
            : {}),
        });
        this.startHeartbeat(plan.envelope.runId, owner, now);
      }
    }
    return plans;
  }

  register(handle: RunHandle): void {
    const { runId, sessionId } = handle.context;
    const existingRun = this.handlesByRunId.get(runId);
    if (existingRun && existingRun !== handle) {
      throw new Error(`Run id already registered: ${runId}`);
    }

    const existingRunId = this.runIdBySessionId.get(sessionId);
    if (existingRunId && existingRunId !== runId) {
      throw new RunSessionConflictError(sessionId, existingRunId);
    }

    this.handlesByRunId.set(runId, handle);
    this.runIdBySessionId.set(sessionId, runId);
  }

  get(runId: string): RunHandle | undefined {
    return this.handlesByRunId.get(runId);
  }

  getTraceContext(runId: string): RunTraceContext | undefined {
    return this.durableTraceContexts.get(runId);
  }

  getBySessionId(sessionId: string): RunHandle | undefined {
    const runId = this.runIdBySessionId.get(sessionId);
    return runId ? this.handlesByRunId.get(runId) : undefined;
  }

  resolve(selector: RunSelector): RunHandle | undefined {
    const runId = selector.runId?.trim();
    const sessionId = selector.sessionId?.trim();
    if (runId) {
      const handle = this.get(runId);
      return handle && (!sessionId || handle.context.sessionId === sessionId) ? handle : undefined;
    }
    if (sessionId) return this.getBySessionId(sessionId);
    return this.size === 1 ? this.last() : undefined;
  }

  hasSession(sessionId: string): boolean {
    return this.runIdBySessionId.has(sessionId);
  }

  last(): RunHandle | undefined {
    return [...this.handlesByRunId.values()].at(-1);
  }

  unregister(runId: string, expected?: RunHandle): boolean {
    const handle = this.handlesByRunId.get(runId);
    if (!handle || (expected && handle !== expected)) {
      return false;
    }
    this.handlesByRunId.delete(runId);
    if (this.runIdBySessionId.get(handle.context.sessionId) === runId) {
      this.runIdBySessionId.delete(handle.context.sessionId);
    }
    return true;
  }

  clear(): void {
    for (const timer of this.heartbeatTimers.values()) clearInterval(timer);
    this.heartbeatTimers.clear();
    for (const runId of [...this.durableTraceContexts.keys()]) {
      this.endAttemptSpan(runId, 'cancelled', { 'terminal.status': 'registry_cleared' });
    }
    this.handlesByRunId.clear();
    this.runIdBySessionId.clear();
    this.durableOwners.clear();
    this.durableTraceContexts.clear();
  }

  get size(): number {
    return this.handlesByRunId.size;
  }

  list(): RunHandle[] {
    return [...this.handlesByRunId.values()];
  }

  private requireKernel(): RunKernelAdapter {
    if (!this.kernel) throw new Error('Durable Run kernel is not configured');
    return this.kernel;
  }

  private requireDurableOwner(runId: string): { owner: RunOwnerLease; attempt: number } {
    const live = this.durableOwners.get(runId);
    if (!live) throw new Error(`Durable Run ${runId} has no live owner lease`);
    return live;
  }

  private startHeartbeat(runId: string, owner: RunOwnerLease, now: number): void {
    this.stopHeartbeat(runId);
    const intervalMs = Math.max(250, Math.floor((owner.leaseExpiresAt - now) / 3));
    const timer = setInterval(() => {
      void this.heartbeatDurable(runId).catch(async () => {
        this.stopHeartbeat(runId);
        this.durableOwners.delete(runId);
        this.endAttemptSpan(runId, 'error', { 'terminal.status': 'stale_owner' });
        const handle = this.handlesByRunId.get(runId);
        if (handle) await handle.cancel('session-switch').catch(() => undefined);
        this.unregister(runId, handle);
      });
    }, intervalMs);
    timer.unref?.();
    this.heartbeatTimers.set(runId, timer);
  }

  private stopHeartbeat(runId: string): void {
    const timer = this.heartbeatTimers.get(runId);
    if (timer) clearInterval(timer);
    this.heartbeatTimers.delete(runId);
  }

  private startAttemptSpan(
    traceContext: RunTraceContext,
    attributes: Record<string, string | number | boolean> = {},
  ): void {
    try {
      getTelemetryService().startRunAttemptSpan(traceContext, attributes);
    } catch {
      // Tracing is diagnostic only and must never affect run ownership.
    }
  }

  private endAttemptSpan(
    runId: string,
    status: 'ok' | 'error' | 'cancelled',
    attributes: Record<string, string | number | boolean>,
  ): void {
    const traceContext = this.durableTraceContexts.get(runId);
    if (!traceContext) return;
    this.durableTraceContexts.delete(runId);
    try {
      const telemetry = getTelemetryService();
      telemetry.endOpenSpansForTrace(traceContext.traceId, status, traceContext.spanId);
      telemetry.endSpan(traceContext.spanId, status, attributes);
    } catch {
      // Tracing is diagnostic only and must never affect run ownership.
    }
  }
}
