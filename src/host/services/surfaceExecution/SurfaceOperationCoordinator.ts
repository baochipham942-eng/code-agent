import type {
  SurfaceActionResultV1,
  SurfaceExecutionErrorV1,
  SurfaceExpectationV1,
  SurfaceObservationV1,
  SurfaceTargetRefV1,
} from '../../../shared/contract/surfaceExecution';
import type { BrowserComputerCatalogTool } from '../../../shared/utils/browserComputerActionCatalog';
import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import { SurfaceAccessGrantService } from './SurfaceAccessGrantService';
import { SurfaceCapabilityRegistry } from './SurfaceCapabilityRegistry';
import { SurfaceEventHub } from './SurfaceEventHub';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import { SurfaceInterruptService } from './SurfaceInterruptService';
import { SurfaceObservationRegistry } from './SurfaceObservationRegistry';
import { SurfaceSessionManager } from './SurfaceSessionManager';

export interface SurfaceProviderActionOutcomeV1 {
  delivery: SurfaceActionResultV1['delivery'];
  verification?: SurfaceActionResultV1['verification'];
  overall?: SurfaceActionResultV1['overall'];
  successorObservation?: SurfaceObservationV1;
  evidenceRefs?: string[];
  artifactRefs?: string[];
  error?: SurfaceExecutionErrorV1;
}

interface QueueEntry<T> {
  subject: SurfaceGrantSubjectV1;
  operationId: string;
  parentSignal?: AbortSignal;
  releaseInput?: () => void | Promise<void>;
  run: (signal: AbortSignal) => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  onAbort?: () => void;
}

interface SessionQueue {
  running: boolean;
  entries: QueueEntry<unknown>[];
}

export class SurfaceOperationCoordinator {
  private readonly queues = new Map<string, SessionQueue>();

  constructor(
    private readonly sessions: SurfaceSessionManager,
    private readonly capabilities: SurfaceCapabilityRegistry,
    private readonly grants: SurfaceAccessGrantService,
    private readonly observations: SurfaceObservationRegistry,
    private readonly interrupts: SurfaceInterruptService,
    private readonly events: SurfaceEventHub,
  ) {}

  execute(input: {
    subject: SurfaceGrantSubjectV1;
    operationId: string;
    toolName: BrowserComputerCatalogTool;
    action: string;
    arguments?: Record<string, unknown>;
    target: SurfaceTargetRefV1;
    grantId: string;
    predecessorStateId?: string;
    providerGeneration: string;
    expectation?: SurfaceExpectationV1;
    deadlineMs: number;
    parentSignal?: AbortSignal;
    releaseInput?: () => void | Promise<void>;
    dispatch(signal: AbortSignal): Promise<SurfaceProviderActionOutcomeV1>;
  }): Promise<SurfaceActionResultV1> {
    if (!Number.isFinite(input.deadlineMs) || input.deadlineMs <= 0) {
      return Promise.reject(new Error('Surface operation deadline must be a positive finite duration.'));
    }
    return this.enqueue({
      subject: input.subject,
      operationId: input.operationId,
      ...(input.parentSignal ? { parentSignal: input.parentSignal } : {}),
      ...(input.releaseInput ? { releaseInput: input.releaseInput } : {}),
      run: async (signal) => this.executeNow(input, signal),
    });
  }

  queuedCount(subject: SurfaceGrantSubjectV1): number {
    this.sessions.requireOwned(subject.sessionId, subject);
    return this.queueFor(subject.sessionId).entries.length;
  }

  private async executeNow(
    input: Parameters<SurfaceOperationCoordinator['execute']>[0],
    signal: AbortSignal,
  ): Promise<SurfaceActionResultV1> {
    const session = this.sessions.requireOwned(input.subject.sessionId, input.subject);
    const descriptor = this.capabilities.resolve(input.toolName, input.action, input.arguments);
    if (descriptor.surface !== session.surface || input.target.kind !== session.surface) {
      throw this.runtimeError(input, 'SURFACE_CAPABILITY_UNSUPPORTED', 'Action does not belong to this Surface.', 'Use the matching Browser or Computer Surface.');
    }
    this.grants.validate({
      grantId: input.grantId,
      subject: input.subject,
      target: input.target,
      requiredCapabilities: descriptor.capabilities,
      actionClass: descriptor.actionClass,
      consume: descriptor.mutation,
    });
    if (descriptor.mutation) {
      if (!input.predecessorStateId || !input.providerGeneration.trim()) {
        throw this.runtimeError(input, 'SURFACE_STATE_STALE', 'Mutation requires a predecessor state and provider generation.', 'Capture a fresh observation before mutating.');
      }
      this.observations.consume({
        stateId: input.predecessorStateId,
        subject: input.subject,
        target: input.target,
        providerGeneration: input.providerGeneration,
      });
    }
    this.events.publish(input.subject, {
      phase: descriptor.mutation ? 'act' : 'observe',
      status: 'running',
      userSummary: `${input.action} running`,
      target: input.target,
      operation: {
        action: input.action,
        risk: descriptor.catalog.risk,
        approvalScope: descriptor.catalog.approvalKind,
        ...(input.expectation ? { expectedOutcome: this.expectationSummary(input.expectation) } : {}),
      },
      evidenceRefs: [],
      artifactRefs: [],
      availableControls: ['pause', 'takeover', 'stop', 'end_session'],
    });

    if (signal.aborted) throw this.abortError(input, signal.reason);
    const outcome = await this.dispatchWithControls(input, signal);
    if (outcome.successorObservation) {
      this.observations.requireFresh({
        stateId: outcome.successorObservation.stateId,
        subject: input.subject,
        target: outcome.successorObservation.target,
        providerGeneration: outcome.successorObservation.providerGeneration,
      });
    }
      const verification = outcome.verification || (input.expectation ? 'inconclusive' : 'not_requested');
      const overall = outcome.overall || this.deriveOverall(outcome.delivery, verification);
      const result: SurfaceActionResultV1 = {
        version: 1,
        operationId: input.operationId,
        predecessorStateId: input.predecessorStateId || 'none',
        delivery: outcome.delivery,
        verification,
        overall,
        ...(outcome.successorObservation ? { successorState: outcome.successorObservation } : {}),
        evidenceRefs: outcome.evidenceRefs || [],
        artifactRefs: outcome.artifactRefs || [],
        ...(outcome.error ? { error: outcome.error } : {}),
      };
      this.events.publish(input.subject, {
        phase: input.expectation ? 'verify' : descriptor.mutation ? 'act' : 'observe',
        status: overall === 'ambiguous' ? 'ambiguous' : overall === 'failed' ? 'failed' : 'succeeded',
        userSummary: `${input.action} ${overall}`,
        target: outcome.successorObservation?.target || input.target,
        operation: {
          action: input.action,
          risk: descriptor.catalog.risk,
          approvalScope: descriptor.catalog.approvalKind,
        },
        observation: {
          verdict: verification === 'satisfied' || verification === 'preexisting'
            ? 'pass'
            : verification === 'unsatisfied'
              ? 'fail'
              : verification === 'not_requested'
                ? 'not_requested'
                : 'inconclusive',
          findings: [],
        },
        evidenceRefs: result.evidenceRefs,
        artifactRefs: result.artifactRefs,
        availableControls: ['pause', 'takeover', 'stop', 'end_session'],
        completedAt: Date.now(),
      });
    return result;
  }

  private enqueue<T>(input: Omit<QueueEntry<T>, 'resolve' | 'reject'>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const queue = this.queueFor(input.subject.sessionId);
      const entry: QueueEntry<T> = { ...input, resolve, reject };
      if (input.parentSignal) {
        const abortQueued = () => {
          const index = queue.entries.indexOf(entry as QueueEntry<unknown>);
          if (index >= 0) {
            queue.entries.splice(index, 1);
            reject(this.abortError({
              subject: input.subject,
              operationId: input.operationId,
              target: this.sessions.requireOwned(input.subject.sessionId, input.subject).activeTarget,
            }, input.parentSignal?.reason));
          }
        };
        entry.onAbort = abortQueued;
        if (input.parentSignal.aborted) {
          reject(this.abortError({
            subject: input.subject,
            operationId: input.operationId,
            target: this.sessions.requireOwned(input.subject.sessionId, input.subject).activeTarget,
          }, input.parentSignal.reason));
          return;
        }
        input.parentSignal.addEventListener('abort', abortQueued, { once: true });
      }
      queue.entries.push(entry as QueueEntry<unknown>);
      void this.drain(input.subject.sessionId);
    });
  }

  private async drain(sessionId: string): Promise<void> {
    const queue = this.queueFor(sessionId);
    if (queue.running) return;
    const entry = queue.entries.shift();
    if (!entry) return;
    queue.running = true;
    entry.parentSignal?.removeEventListener('abort', entry.onAbort as () => void);
    let handle;
    try {
      handle = this.interrupts.registerOperation({
        subject: entry.subject,
        operationId: entry.operationId,
        ...(entry.parentSignal ? { parentSignal: entry.parentSignal } : {}),
        ...(entry.releaseInput ? { releaseInput: entry.releaseInput } : {}),
      });
      const result = await entry.run(handle.signal);
      entry.resolve(result);
    } catch (error) {
      entry.reject(error);
    } finally {
      await handle?.finish();
      queue.running = false;
      void this.drain(sessionId);
    }
  }

  private queueFor(sessionId: string): SessionQueue {
    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = { running: false, entries: [] };
      this.queues.set(sessionId, queue);
    }
    return queue;
  }

  private async dispatchWithControls(
    input: Parameters<SurfaceOperationCoordinator['execute']>[0],
    signal: AbortSignal,
  ): Promise<SurfaceProviderActionOutcomeV1> {
    const providerController = new AbortController();
    return await new Promise<SurfaceProviderActionOutcomeV1>((resolve, reject) => {
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        providerController.abort('surface-deadline');
        reject(this.runtimeError(input, 'SURFACE_REQUEST_TIMEOUT', 'Surface operation timed out.', 'Inspect successor state before retrying.'));
      }, input.deadlineMs);
      const onAbort = () => {
        providerController.abort(signal.reason || 'surface-cancelled');
        reject(this.abortError(input, signal.reason));
      };
      signal.addEventListener('abort', onAbort, { once: true });
      input.dispatch(providerController.signal).then(resolve, (error) => {
        if (!timedOut) reject(error);
      }).finally(() => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
      });
    });
  }

  private deriveOverall(
    delivery: SurfaceActionResultV1['delivery'],
    verification: SurfaceActionResultV1['verification'],
  ): SurfaceActionResultV1['overall'] {
    if (delivery === 'unknown') return 'ambiguous';
    if (delivery === 'not_attempted' || delivery === 'rejected' || verification === 'unsatisfied') return 'failed';
    if (verification === 'satisfied' || verification === 'preexisting') return 'succeeded';
    return 'delivered_unverified';
  }

  private expectationSummary(expectation: SurfaceExpectationV1): string {
    return expectation.kind === 'custom' ? expectation.description : expectation.kind;
  }

  private abortError(
    input: { subject: SurfaceGrantSubjectV1; operationId: string; target?: SurfaceTargetRefV1 },
    reason: unknown,
  ): SurfaceExecutionRuntimeError {
    return this.runtimeError(input, 'SURFACE_REQUEST_CANCELLED', typeof reason === 'string' ? reason : 'Surface operation was cancelled.', 'Re-observe before deciding whether to retry.');
  }

  private runtimeError(
    input: { subject: SurfaceGrantSubjectV1; operationId: string; target?: SurfaceTargetRefV1 },
    code: 'SURFACE_CAPABILITY_UNSUPPORTED' | 'SURFACE_STATE_STALE' | 'SURFACE_REQUEST_TIMEOUT' | 'SURFACE_REQUEST_CANCELLED',
    message: string,
    recommendedAction: string,
  ): SurfaceExecutionRuntimeError {
    const session = this.sessions.requireOwned(input.subject.sessionId, input.subject);
    return new SurfaceExecutionRuntimeError({
      code,
      message,
      phase: code === 'SURFACE_REQUEST_TIMEOUT' || code === 'SURFACE_REQUEST_CANCELLED' ? 'act' : 'prepare',
      retryable: code !== 'SURFACE_CAPABILITY_UNSUPPORTED',
      recommendedAction,
      surface: session.surface,
      provider: session.provider,
      sessionId: session.sessionId,
      operationId: input.operationId,
      ...(input.target ? { targetRef: input.target } : {}),
    });
  }
}
