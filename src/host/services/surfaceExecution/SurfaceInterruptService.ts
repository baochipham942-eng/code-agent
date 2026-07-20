import type { SurfaceGrantSubjectV1 } from './SurfaceAccessGrantService';
import { SurfaceExecutionRuntimeError } from './SurfaceExecutionRuntimeError';
import { SurfaceSessionManager } from './SurfaceSessionManager';

interface ActiveOperation {
  subject: SurfaceGrantSubjectV1;
  operationId: string;
  controller: AbortController;
  detachParent?: () => void;
  releaseInput?: () => void | Promise<void>;
  released?: boolean;
}

interface SessionInterruptState {
  operations: Map<string, ActiveOperation>;
  cleanup: Set<() => void | Promise<void>>;
}

export interface SurfaceOperationInterruptHandle {
  signal: AbortSignal;
  abort(reason?: unknown): void;
  finish(): Promise<void>;
}

export class SurfaceInterruptService {
  private readonly states = new Map<string, SessionInterruptState>();

  constructor(private readonly sessions: SurfaceSessionManager) {}

  registerOperation(input: {
    subject: SurfaceGrantSubjectV1;
    operationId: string;
    parentSignal?: AbortSignal;
    releaseInput?: () => void | Promise<void>;
  }): SurfaceOperationInterruptHandle {
    const session = this.sessions.requireOwned(input.subject.sessionId, input.subject);
    if (session.state !== 'running') {
      throw new SurfaceExecutionRuntimeError({
        code: session.state === 'stopping' ? 'SURFACE_USER_ABORTED' : 'SURFACE_SESSION_BUSY',
        message: `Surface session cannot start an operation while ${session.state}.`,
        phase: 'prepare',
        retryable: session.state === 'paused' || session.state === 'waiting_human',
        userActionRequired: session.state === 'waiting_human',
        recommendedAction: session.state === 'paused' ? 'Resume the Surface session.' : 'Wait for or finish human takeover.',
        surface: session.surface,
        provider: session.provider,
        sessionId: session.sessionId,
        operationId: input.operationId,
      });
    }
    const state = this.stateFor(session.sessionId);
    if (state.operations.has(input.operationId)) {
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_SESSION_BUSY',
        message: `Surface operation is already active: ${input.operationId}`,
        phase: 'prepare',
        recommendedAction: 'Use a unique operationId.',
        surface: session.surface,
        provider: session.provider,
        sessionId: session.sessionId,
        operationId: input.operationId,
      });
    }
    const controller = new AbortController();
    let detachParent: (() => void) | undefined;
    if (input.parentSignal) {
      const abortFromParent = () => controller.abort(input.parentSignal?.reason || 'parent-aborted');
      if (input.parentSignal.aborted) abortFromParent();
      else {
        input.parentSignal.addEventListener('abort', abortFromParent, { once: true });
        detachParent = () => input.parentSignal?.removeEventListener('abort', abortFromParent);
      }
    }
    const operation: ActiveOperation = {
      subject: input.subject,
      operationId: input.operationId,
      controller,
      ...(detachParent ? { detachParent } : {}),
      ...(input.releaseInput ? { releaseInput: input.releaseInput } : {}),
    };
    state.operations.set(input.operationId, operation);
    let finished = false;
    return {
      signal: controller.signal,
      abort(reason?: unknown) {
        controller.abort(reason);
      },
      finish: async () => {
        if (finished) return;
        finished = true;
        await this.releaseOperation(state, operation);
      },
    };
  }

  registerCleanup(
    subject: SurfaceGrantSubjectV1,
    cleanup: () => void | Promise<void>,
  ): () => void {
    this.sessions.requireOwned(subject.sessionId, subject);
    const state = this.stateFor(subject.sessionId);
    state.cleanup.add(cleanup);
    return () => state.cleanup.delete(cleanup);
  }

  async pause(subject: SurfaceGrantSubjectV1): Promise<void> {
    const session = this.sessions.requireOwned(subject.sessionId, subject);
    if (session.state !== 'running') {
      throw this.controlError(subject, 'pause', session.provider, session.surface, session.state);
    }
    await this.abortActive(subject, 'surface-paused');
    this.sessions.transition(subject.sessionId, subject, 'paused');
  }

  resume(subject: SurfaceGrantSubjectV1): void {
    const session = this.sessions.requireOwned(subject.sessionId, subject);
    if (session.state !== 'paused' && session.state !== 'waiting_human') {
      throw this.controlError(subject, 'resume', session.provider, session.surface, session.state);
    }
    this.sessions.transition(subject.sessionId, subject, 'running');
  }

  async takeover(subject: SurfaceGrantSubjectV1): Promise<void> {
    const session = this.sessions.requireOwned(subject.sessionId, subject);
    if (session.state !== 'running' && session.state !== 'paused') {
      throw this.controlError(subject, 'takeover', session.provider, session.surface, session.state);
    }
    await this.abortActive(subject, 'surface-human-takeover');
    this.sessions.transition(subject.sessionId, subject, 'waiting_human');
  }

  async stop(subject: SurfaceGrantSubjectV1): Promise<void> {
    const session = this.sessions.requireOwned(subject.sessionId, subject);
    if (session.state === 'completed' || session.state === 'failed') return;
    if (session.state !== 'stopping') {
      this.sessions.transition(subject.sessionId, subject, 'stopping');
    }
    await this.abortActive(subject, 'surface-stopped');
  }

  async endSession(subject: SurfaceGrantSubjectV1): Promise<void> {
    const before = this.sessions.requireOwned(subject.sessionId, subject);
    if (before.state === 'completed' || before.state === 'failed') return;
    await this.stop(subject);
    const state = this.stateFor(subject.sessionId);
    try {
      for (const cleanup of state.cleanup) await cleanup();
      state.cleanup.clear();
      this.sessions.transition(subject.sessionId, subject, 'completed');
    } catch (error) {
      this.sessions.transition(subject.sessionId, subject, 'failed');
      throw new SurfaceExecutionRuntimeError({
        code: 'SURFACE_CLEANUP_FAILED',
        message: error instanceof Error ? error.message : String(error),
        phase: 'cleanup',
        retryable: true,
        userActionRequired: true,
        recommendedAction: 'Keep the target open and retry cleanup or recover it manually.',
        surface: before.surface,
        provider: before.provider,
        sessionId: before.sessionId,
        ...(before.activeTarget ? { targetRef: before.activeTarget } : {}),
      });
    }
  }

  activeOperationCount(subject: SurfaceGrantSubjectV1): number {
    this.sessions.requireOwned(subject.sessionId, subject);
    return this.stateFor(subject.sessionId).operations.size;
  }

  private stateFor(sessionId: string): SessionInterruptState {
    let state = this.states.get(sessionId);
    if (!state) {
      state = { operations: new Map(), cleanup: new Set() };
      this.states.set(sessionId, state);
    }
    return state;
  }

  private async abortActive(subject: SurfaceGrantSubjectV1, reason: string): Promise<void> {
    const state = this.stateFor(subject.sessionId);
    const operations = Array.from(state.operations.values()).filter((operation) => (
      operation.subject.runId === subject.runId && operation.subject.agentId === subject.agentId
    ));
    for (const operation of operations) operation.controller.abort(reason);
    for (const operation of operations) {
      await this.releaseOperation(state, operation);
    }
  }

  private async releaseOperation(
    state: SessionInterruptState,
    operation: ActiveOperation,
  ): Promise<void> {
    if (operation.released) return;
    operation.released = true;
    state.operations.delete(operation.operationId);
    operation.detachParent?.();
    await operation.releaseInput?.();
  }

  private controlError(
    subject: SurfaceGrantSubjectV1,
    control: string,
    provider: string,
    surface: 'browser' | 'computer',
    state: string,
  ): SurfaceExecutionRuntimeError {
    return new SurfaceExecutionRuntimeError({
      code: 'SURFACE_SESSION_BUSY',
      message: `Cannot ${control} a Surface session while ${state}.`,
      phase: 'human',
      recommendedAction: 'Refresh the session state and choose an available control.',
      surface,
      provider,
      sessionId: subject.sessionId,
    });
  }
}
