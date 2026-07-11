import {
  createRunContext,
  createRunHandle,
  type CreateRunContextInput,
  type RunHandle,
} from './runContext';
import type { RunOwnerLease } from '../../shared/contract/durableRun';
import type {
  DurableCheckpointInput,
  DurableTerminalInput,
  RunKernelAdapter,
} from './durableRunKernel';
import type { RunRehydrationPlan } from './durableRunStores';

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

export class RunRegistry {
  private readonly handlesByRunId = new Map<string, RunHandle>();
  private readonly runIdBySessionId = new Map<string, string>();
  private readonly durableOwners = new Map<string, { owner: RunOwnerLease; attempt: number }>();
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
    const handle = createRunHandle(context);
    const created = await kernel.createNativeRun({
      runId: context.runId,
      sessionId: context.sessionId,
      now,
    });
    this.register(handle);
    this.durableOwners.set(context.runId, { owner: created.owner, attempt: created.attempt.attempt });
    this.startHeartbeat(context.runId, created.owner, now);
    return handle;
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
  ) {
    const live = this.requireDurableOwner(runId);
    const envelope = await this.requireKernel().terminal({
      ...input,
      runId,
      attempt: live.attempt,
      owner: live.owner,
    });
    this.durableOwners.delete(runId);
    this.stopHeartbeat(runId);
    this.unregister(runId);
    return envelope;
  }

  async releaseDurable(runId: string, expected?: RunHandle, now = Date.now()): Promise<boolean> {
    const live = this.durableOwners.get(runId);
    if (!live) return false;
    const released = await this.requireKernel().release(runId, live.owner, now);
    if (released) {
      this.durableOwners.delete(runId);
      this.stopHeartbeat(runId);
      this.unregister(runId, expected);
    }
    return released;
  }

  async recoverDurable(now = Date.now()): Promise<RunRehydrationPlan[]> {
    const plans = await this.requireKernel().recoverOnStartup(now);
    for (const plan of plans) {
      const owner = plan.envelope.owner;
      if (owner) {
        this.durableOwners.set(plan.envelope.runId, { owner, attempt: plan.envelope.attempt });
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
    this.handlesByRunId.clear();
    this.runIdBySessionId.clear();
    this.durableOwners.clear();
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
}
