import type { PendingOperation, RunEngineRef } from '../../shared/contract/durableRun';
import type { RunRehydrationPlan } from './durableRunStores';

export type DurableRecoveryDispatchStatus =
  | 'recovered'
  | 'observing'
  | 'requires_review'
  | 'unsupported'
  | 'already_terminal'
  | 'failed'
  | 'duplicate';

export interface DurableRecoveryDispatchResult {
  runId: string;
  attempt: number;
  ownerEpoch?: number;
  phase: 'engine' | 'operation';
  handler: string;
  status: DurableRecoveryDispatchStatus;
  reason: string;
  operationId?: string;
  detail?: unknown;
}

export interface DurableEngineRecoveryHandler {
  readonly name: string;
  readonly engineKind: RunEngineRef['kind'];
  getDispatchKey?(plan: RunRehydrationPlan): string;
  recover(plan: RunRehydrationPlan, now: number): Promise<Omit<DurableRecoveryDispatchResult, 'runId' | 'attempt' | 'ownerEpoch' | 'phase' | 'handler'>>;
  shutdown?(): Promise<void> | void;
}

export interface DurableOperationRecoveryHandler {
  readonly name: string;
  matches(plan: RunRehydrationPlan, operation: PendingOperation): boolean;
  getDispatchKey?(plan: RunRehydrationPlan, operation: PendingOperation): string;
  recover(plan: RunRehydrationPlan, operation: PendingOperation, now: number): Promise<Omit<DurableRecoveryDispatchResult, 'runId' | 'attempt' | 'ownerEpoch' | 'phase' | 'handler' | 'operationId'>>;
  shutdown?(): Promise<void> | void;
}

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

export class DurableRecoveryDispatcher {
  private readonly engineHandlers = new Map<RunEngineRef['kind'], DurableEngineRecoveryHandler>();
  private readonly operationHandlers: DurableOperationRecoveryHandler[] = [];
  private readonly inFlight = new Map<string, Promise<DurableRecoveryDispatchResult>>();
  private readonly completed = new Map<string, DurableRecoveryDispatchResult>();
  private stopped = false;

  registerEngineHandler(handler: DurableEngineRecoveryHandler): void {
    if (this.stopped) throw new Error('Durable recovery dispatcher is stopped');
    if (this.engineHandlers.has(handler.engineKind)) {
      throw new Error(`Durable engine recovery handler already registered: ${handler.engineKind}`);
    }
    this.engineHandlers.set(handler.engineKind, handler);
  }

  registerOperationHandler(handler: DurableOperationRecoveryHandler): void {
    if (this.stopped) throw new Error('Durable recovery dispatcher is stopped');
    if (this.operationHandlers.some((candidate) => candidate.name === handler.name)) {
      throw new Error(`Durable operation recovery handler already registered: ${handler.name}`);
    }
    this.operationHandlers.push(handler);
  }

  async dispatch(plans: RunRehydrationPlan[], now = Date.now()): Promise<DurableRecoveryDispatchResult[]> {
    if (this.stopped) throw new Error('Durable recovery dispatcher is stopped');
    const settled = await Promise.all(plans.map((plan) => this.dispatchPlan(plan, now)));
    return settled.flat();
  }

  async shutdown(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    const handlers = [...this.engineHandlers.values(), ...this.operationHandlers];
    await Promise.allSettled(handlers.map((handler) => handler.shutdown?.()));
    await Promise.allSettled([...this.inFlight.values()]);
    this.inFlight.clear();
  }

  private async dispatchPlan(plan: RunRehydrationPlan, now: number): Promise<DurableRecoveryDispatchResult[]> {
    if (TERMINAL_STATUSES.has(plan.envelope.status)) {
      return [this.baseResult(plan, 'engine', 'dispatcher', {
        status: 'already_terminal',
        reason: 'terminal runs never enter recovery handlers',
      })];
    }

    const results: DurableRecoveryDispatchResult[] = [];
    const engineHandler = this.engineHandlers.get(plan.envelope.engine.kind);
    if (!engineHandler) {
      results.push(this.baseResult(plan, 'engine', 'dispatcher', {
        status: 'unsupported',
        reason: `no engine recovery handler registered for ${plan.envelope.engine.kind}`,
      }));
    } else {
      const key = engineHandler.getDispatchKey?.(plan) ?? [
        'engine', plan.envelope.runId, plan.envelope.attempt,
        plan.envelope.owner?.epoch ?? 'no-owner', plan.envelope.engine.kind,
      ].join(':');
      results.push(await this.runOnce(key, () => this.invokeEngine(plan, engineHandler, now)));
    }

    for (const operation of plan.pendingOperations) {
      const handler = this.operationHandlers.find((candidate) => candidate.matches(plan, operation));
      if (!handler) {
        if (!isTerminalOperation(operation)) {
          results.push(this.baseResult(plan, 'operation', 'dispatcher', {
            status: 'unsupported',
            reason: `no operation recovery handler registered for ${operation.kind}`,
            operationId: operation.operationId,
          }));
        }
        continue;
      }
      const key = handler.getDispatchKey?.(plan, operation) ?? [
        'operation', plan.envelope.runId, plan.envelope.attempt,
        plan.envelope.owner?.epoch ?? 'no-owner', operation.operationId,
        operation.providerOperationId ?? 'no-provider-handle',
      ].join(':');
      results.push(await this.runOnce(key, () => this.invokeOperation(plan, operation, handler, now)));
    }
    return results;
  }

  private async invokeEngine(
    plan: RunRehydrationPlan,
    handler: DurableEngineRecoveryHandler,
    now: number,
  ): Promise<DurableRecoveryDispatchResult> {
    try {
      return this.baseResult(plan, 'engine', handler.name, await handler.recover(plan, now));
    } catch (error) {
      return this.baseResult(plan, 'engine', handler.name, {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async invokeOperation(
    plan: RunRehydrationPlan,
    operation: PendingOperation,
    handler: DurableOperationRecoveryHandler,
    now: number,
  ): Promise<DurableRecoveryDispatchResult> {
    try {
      return this.baseResult(plan, 'operation', handler.name, {
        ...await handler.recover(plan, operation, now),
        operationId: operation.operationId,
      });
    } catch (error) {
      return this.baseResult(plan, 'operation', handler.name, {
        status: 'failed',
        reason: error instanceof Error ? error.message : String(error),
        operationId: operation.operationId,
      });
    }
  }

  private async runOnce(
    key: string,
    run: () => Promise<DurableRecoveryDispatchResult>,
  ): Promise<DurableRecoveryDispatchResult> {
    const completed = this.completed.get(key);
    if (completed) return { ...completed, status: 'duplicate', reason: `already dispatched: ${completed.reason}` };
    const existing = this.inFlight.get(key);
    if (existing) {
      const result = await existing;
      return { ...result, status: 'duplicate', reason: `dispatch already in flight: ${result.reason}` };
    }
    const promise = run();
    this.inFlight.set(key, promise);
    try {
      const result = await promise;
      this.completed.set(key, result);
      return result;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private baseResult(
    plan: RunRehydrationPlan,
    phase: DurableRecoveryDispatchResult['phase'],
    handler: string,
    result: Omit<DurableRecoveryDispatchResult, 'runId' | 'attempt' | 'ownerEpoch' | 'phase' | 'handler'>,
  ): DurableRecoveryDispatchResult {
    return {
      runId: plan.envelope.runId,
      attempt: plan.envelope.attempt,
      ...(plan.envelope.owner ? { ownerEpoch: plan.envelope.owner.epoch } : {}),
      phase,
      handler,
      ...result,
    };
  }
}

function isTerminalOperation(operation: PendingOperation): boolean {
  return operation.status === 'succeeded' || operation.status === 'failed' || operation.status === 'abandoned';
}
