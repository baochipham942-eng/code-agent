import {
  createRunContext,
  createRunHandle,
  type CreateRunContextInput,
  type RunHandle,
} from './runContext';

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

  start(input: CreateRunContextInput): RunHandle {
    const context = createRunContext(input);
    const handle = createRunHandle(context);
    this.register(handle);
    return handle;
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
    this.handlesByRunId.clear();
    this.runIdBySessionId.clear();
  }

  get size(): number {
    return this.handlesByRunId.size;
  }

  list(): RunHandle[] {
    return [...this.handlesByRunId.values()];
  }
}
