import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AgentEngineRunResult } from '../../../src/shared/contract/agentEngine';
import { createRunContext, type RunHandle } from '../../../src/host/runtime/runContext';
import type { RunRegistry } from '../../../src/host/runtime/runRegistry';
import { ExternalEngineDurableLifecycle } from '../../../src/host/services/agentEngine';
import { createAgentDurableRouteRunLifecycle } from '../../../src/web/routes/agentDurableRouteLifecycle';

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createRunHandle(runId = 'run-1', sessionId = 'session-1'): RunHandle {
  return {
    context: createRunContext({
      runId,
      sessionId,
      workspace: '/workspace',
      cwd: '/workspace',
      createdAt: 1,
    }),
    isAttached: false,
    cancellationRequested: false,
    cancel: vi.fn(async () => undefined),
    pause: vi.fn(async () => undefined),
    resume: vi.fn(async () => undefined),
    steer: vi.fn(async () => undefined),
    attach: vi.fn(async () => undefined),
  };
}

function createRunRegistry(runHandle = createRunHandle()) {
  const runRegistry = {
    start: vi.fn(() => runHandle),
    startDurable: vi.fn(async () => runHandle),
    terminalDurable: vi.fn(async () => undefined),
    releaseDurable: vi.fn(async () => true),
    unregister: vi.fn(() => true),
  };
  return { runRegistry: runRegistry as unknown as RunRegistry, mocks: runRegistry, runHandle };
}

function createLifecycle(input: {
  runRegistry: RunRegistry;
  durableActivation?: boolean;
  externalEngine?: 'codex_cli';
}) {
  return createAgentDurableRouteRunLifecycle({
    runRegistry: input.runRegistry,
    sessionId: 'session-1',
    workspace: '/workspace',
    durableActivation: input.durableActivation ?? true,
    externalEngine: input.externalEngine,
    logger,
  });
}

function externalResult(overrides: Partial<AgentEngineRunResult> = {}): AgentEngineRunResult {
  return {
    runId: 'run-1',
    sessionId: 'session-1',
    engine: 'codex_cli',
    status: 'completed',
    outputText: 'done',
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

describe('Agent durable route run lifecycle', () => {
  it('starts and terminalizes a successful Native durable run once, then unregisters on release once', async () => {
    const { runRegistry, mocks, runHandle } = createRunRegistry();
    const lifecycle = createLifecycle({ runRegistry });

    await expect(lifecycle.start()).resolves.toMatchObject({ runHandle });
    await lifecycle.markSuccess({ finalStatus: 'completed' });
    await lifecycle.markFailure({ disconnected: false, message: 'late failure' });
    await lifecycle.markSuccess({ finalStatus: 'completed' });
    await lifecycle.release();
    await lifecycle.release();

    expect(mocks.startDurable).toHaveBeenCalledOnce();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.terminalDurable).toHaveBeenCalledOnce();
    expect(mocks.terminalDurable).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 'completed',
      reason: 'completed',
      event: expect.objectContaining({
        type: 'run_completed',
        payload: { sessionId: 'session-1' },
      }),
    }), runHandle);
    expect(mocks.releaseDurable).not.toHaveBeenCalled();
    expect(mocks.unregister).toHaveBeenCalledOnce();
    expect(mocks.unregister).toHaveBeenCalledWith('run-1', runHandle);
  });

  it('uses the external lifecycle for success and preserves the terminal-evidence rule', async () => {
    const { runRegistry, mocks, runHandle } = createRunRegistry();
    const externalLifecycle = {
      handle: runHandle,
      runId: 'run-1',
      sessionId: 'session-1',
      engine: 'codex_cli',
      finish: vi.fn(async () => 'failed' as const),
    } as unknown as ExternalEngineDurableLifecycle;
    vi.spyOn(ExternalEngineDurableLifecycle, 'start').mockResolvedValue(externalLifecycle);
    const lifecycle = createLifecycle({ runRegistry, externalEngine: 'codex_cli' });
    const result = externalResult({ outputText: '   ' });

    await expect(lifecycle.start()).resolves.toMatchObject({ runHandle, externalLifecycle });
    await expect(lifecycle.markSuccess({ result })).resolves.toBe('failed');
    await expect(lifecycle.markSuccess({ result })).resolves.toBe('failed');
    await lifecycle.release();

    expect(ExternalEngineDurableLifecycle.start).toHaveBeenCalledWith({
      registry: runRegistry,
      engine: 'codex_cli',
      sessionId: 'session-1',
      workspace: '/workspace',
      cwd: '/workspace',
    });
    expect(externalLifecycle.finish).toHaveBeenCalledOnce();
    expect(externalLifecycle.finish).toHaveBeenCalledWith(result, false);
    expect(mocks.startDurable).not.toHaveBeenCalled();
    expect(mocks.start).not.toHaveBeenCalled();
    expect(mocks.terminalDurable).not.toHaveBeenCalled();
    expect(mocks.unregister).toHaveBeenCalledWith('run-1', runHandle);
  });

  it('marks an external failure terminal through its lifecycle and skips the Native fallback', async () => {
    const { runRegistry, mocks, runHandle } = createRunRegistry();
    const externalLifecycle = {
      handle: runHandle,
      runId: 'run-1',
      sessionId: 'session-1',
      engine: 'codex_cli',
      finish: vi.fn(async () => undefined),
    } as unknown as ExternalEngineDurableLifecycle;
    vi.spyOn(ExternalEngineDurableLifecycle, 'start').mockResolvedValue(externalLifecycle);
    const lifecycle = createLifecycle({ runRegistry, externalEngine: 'codex_cli' });

    await lifecycle.start();
    await lifecycle.markFailure({
      disconnected: true,
      message: 'client disconnected',
    });
    await lifecycle.release();

    expect(externalLifecycle.finish).toHaveBeenCalledWith({
      runId: 'run-1',
      sessionId: 'session-1',
      engine: 'codex_cli',
      status: 'cancelled',
      error: 'client disconnected',
    }, true);
    expect(mocks.terminalDurable).not.toHaveBeenCalled();
    expect(mocks.releaseDurable).not.toHaveBeenCalled();
    expect(mocks.unregister).toHaveBeenCalledWith('run-1', runHandle);
  });

  it('falls back to Native terminal failure when the external terminal commit fails', async () => {
    const { runRegistry, mocks, runHandle } = createRunRegistry();
    const externalError = new Error('external terminal unavailable');
    const externalLifecycle = {
      handle: runHandle,
      runId: 'run-1',
      sessionId: 'session-1',
      engine: 'codex_cli',
      finish: vi.fn(async () => { throw externalError; }),
    } as unknown as ExternalEngineDurableLifecycle;
    vi.spyOn(ExternalEngineDurableLifecycle, 'start').mockResolvedValue(externalLifecycle);
    const lifecycle = createLifecycle({ runRegistry, externalEngine: 'codex_cli' });

    await lifecycle.start();
    await lifecycle.markFailure({ disconnected: false, message: 'adapter failed' });
    await lifecycle.release();

    expect(logger.error).toHaveBeenCalledWith('External Durable Run terminal commit failed:', externalError);
    expect(mocks.terminalDurable).toHaveBeenCalledOnce();
    expect(mocks.terminalDurable).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 'failed',
      reason: 'adapter failed',
      event: expect.objectContaining({
        type: 'run_failed',
        payload: { message: 'adapter failed' },
      }),
    }), runHandle);
    expect(mocks.releaseDurable).not.toHaveBeenCalled();
    expect(mocks.unregister).toHaveBeenCalledWith('run-1', runHandle);
  });

  it('records a disconnected Native failure as cancelled with a run_cancelled event', async () => {
    const { runRegistry, mocks, runHandle } = createRunRegistry();
    const lifecycle = createLifecycle({ runRegistry });

    await lifecycle.start();
    await lifecycle.markFailure({ disconnected: true, message: 'client disconnected' });

    expect(mocks.terminalDurable).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 'cancelled',
      reason: 'client disconnected',
      event: expect.objectContaining({
        type: 'run_cancelled',
        payload: { message: 'client disconnected' },
      }),
    }), runHandle);
  });

  it('records a connected Native failure as failed with a run_failed event', async () => {
    const { runRegistry, mocks, runHandle } = createRunRegistry();
    const lifecycle = createLifecycle({ runRegistry });

    await lifecycle.start();
    await lifecycle.markFailure({ disconnected: false, message: 'native failed' });

    expect(mocks.terminalDurable).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 'failed',
      reason: 'native failed',
      event: expect.objectContaining({
        type: 'run_failed',
        payload: { message: 'native failed' },
      }),
    }), runHandle);
  });

  it('releases an unterminated durable run once instead of unregistering it', async () => {
    const { runRegistry, mocks, runHandle } = createRunRegistry();
    const lifecycle = createLifecycle({ runRegistry });

    await lifecycle.start();
    await lifecycle.release();
    await lifecycle.release();

    expect(mocks.terminalDurable).not.toHaveBeenCalled();
    expect(mocks.releaseDurable).toHaveBeenCalledOnce();
    expect(mocks.releaseDurable).toHaveBeenCalledWith('run-1', runHandle);
    expect(mocks.unregister).not.toHaveBeenCalled();
  });

  it('keeps non-durable runs on the legacy start and unregister path', async () => {
    const { runRegistry, mocks, runHandle } = createRunRegistry();
    const lifecycle = createLifecycle({ runRegistry, durableActivation: false });

    await lifecycle.start();
    await lifecycle.markSuccess({ finalStatus: 'interrupted' });
    await lifecycle.release();

    expect(mocks.start).toHaveBeenCalledOnce();
    expect(mocks.startDurable).not.toHaveBeenCalled();
    expect(mocks.terminalDurable).not.toHaveBeenCalled();
    expect(mocks.releaseDurable).not.toHaveBeenCalled();
    expect(mocks.unregister).toHaveBeenCalledWith('run-1', runHandle);
  });
});
