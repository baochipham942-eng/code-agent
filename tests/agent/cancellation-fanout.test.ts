// ============================================================================
// appService.cancel fan-out — AC-A + AC-C
// ============================================================================
//
// AC-A: user-cancel fans out to spawnGuard.cancelAll + parallelCoordinator
//       .abortAllRunning so single-spawn / parallel subagents both get the
//       signal within 1s.
//
// AC-C (reverse): child-error / non-cascade reasons MUST NOT trigger
//       cancelAll / abortAllRunning. Sibling subagents must remain
//       autonomous. This locks LangChain deepagents Issue #694 regression
//       out of the codebase.
// ============================================================================

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp/code-agent-test') },
}));

vi.mock('../../src/host/services/infra/logger', () => ({
  logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: vi.fn(() => ({
    info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn(),
  })),
  LogLevel: { DEBUG: 0, INFO: 1, WARN: 2, ERROR: 3 },
}));

import { AgentAppServiceImpl } from '../../src/host/app/agentAppService';
import { registerSwarmServices, resetSwarmServices } from '../../src/host/agent/swarmServices';

type AnyMock = ReturnType<typeof vi.fn>;

function buildSwarmServicesMock() {
  const spawnGuard = {
    cancel: vi.fn().mockReturnValue(true) as AnyMock,
    cancelAll: vi.fn().mockReturnValue(3) as AnyMock,
    get: vi.fn(),
    sendMessage: vi.fn(),
  };
  const parallelCoordinator = {
    abortAllRunning: vi.fn() as AnyMock,
    abortTask: vi.fn(),
  };
  return { spawnGuard, parallelCoordinator };
}

function buildTaskManagerMock(sessionId: string, opts?: { tmOwned?: boolean }) {
  return {
    getSessionState: vi.fn().mockReturnValue({ status: opts?.tmOwned ? 'running' : 'idle' }),
    cancelTask: vi.fn().mockResolvedValue(undefined),
    getOrCreateCurrentOrchestrator: vi.fn().mockReturnValue({
      cancel: vi.fn().mockResolvedValue(undefined),
    }),
  };
}

describe('appService.cancel fan-out — AC-A (cascade) / AC-C (no cascade on child-error)', () => {
  beforeEach(() => {
    resetSwarmServices();
  });

  it('AC-A: user-cancel fans out to spawnGuard.cancelAll + parallelCoordinator.abortAllRunning', async () => {
    const swarm = buildSwarmServicesMock();
    registerSwarmServices(swarm as Parameters<typeof registerSwarmServices>[0]);

    const sessionId = 'sess-fanout-a';
    const tm = buildTaskManagerMock(sessionId);
    const svc = new AgentAppServiceImpl(
      () => tm as unknown as Parameters<typeof AgentAppServiceImpl>[0] extends never ? never : Parameters<ConstructorParameters<typeof AgentAppServiceImpl>[0]>[0] extends never ? never : ReturnType<ConstructorParameters<typeof AgentAppServiceImpl>[0]>,
      () => null,
      () => sessionId,
      () => {},
    );

    await svc.cancel(sessionId, 'user-cancel');

    expect(swarm.spawnGuard.cancelAll).toHaveBeenCalledWith('user-cancel');
    expect(swarm.parallelCoordinator.abortAllRunning).toHaveBeenCalledWith('user-cancel');
  });

  it("AC-A (legacy): cancel(sessionId, 'user') is normalized to user-cancel and still cascades", async () => {
    const swarm = buildSwarmServicesMock();
    registerSwarmServices(swarm as Parameters<typeof registerSwarmServices>[0]);
    const sessionId = 'sess-legacy';
    const tm = buildTaskManagerMock(sessionId);
    const svc = new AgentAppServiceImpl(
      () => tm as never,
      () => null,
      () => sessionId,
      () => {},
    );
    await svc.cancel(sessionId, 'user');
    expect(swarm.spawnGuard.cancelAll).toHaveBeenCalledWith('user-cancel');
    expect(swarm.parallelCoordinator.abortAllRunning).toHaveBeenCalledWith('user-cancel');
  });

  it('cancel(session-switch) also cascades', async () => {
    const swarm = buildSwarmServicesMock();
    registerSwarmServices(swarm as Parameters<typeof registerSwarmServices>[0]);
    const sessionId = 'sess-switch';
    const tm = buildTaskManagerMock(sessionId);
    const svc = new AgentAppServiceImpl(
      () => tm as never,
      () => null,
      () => sessionId,
      () => {},
    );
    await svc.cancel(sessionId, 'session-switch');
    expect(swarm.spawnGuard.cancelAll).toHaveBeenCalledWith('session-switch');
    expect(swarm.parallelCoordinator.abortAllRunning).toHaveBeenCalledWith('session-switch');
  });

  it('AC-C: child-error reason does NOT trigger cancelAll / abortAllRunning', async () => {
    const swarm = buildSwarmServicesMock();
    registerSwarmServices(swarm as Parameters<typeof registerSwarmServices>[0]);
    const sessionId = 'sess-child-err';
    const tm = buildTaskManagerMock(sessionId);
    const svc = new AgentAppServiceImpl(
      () => tm as never,
      () => null,
      () => sessionId,
      () => {},
    );

    await svc.cancel(sessionId, 'child-error');

    // anti-#694: child-error MUST NOT cause sibling cascade
    expect(swarm.spawnGuard.cancelAll).not.toHaveBeenCalled();
    expect(swarm.parallelCoordinator.abortAllRunning).not.toHaveBeenCalled();
  });

  it('AC-C: idle-timeout / timeout / budget-exceeded all skip the fan-out', async () => {
    for (const reason of ['idle-timeout', 'timeout', 'budget-exceeded'] as const) {
      resetSwarmServices();
      const swarm = buildSwarmServicesMock();
      registerSwarmServices(swarm as Parameters<typeof registerSwarmServices>[0]);
      const sessionId = `sess-nc-${reason}`;
      const tm = buildTaskManagerMock(sessionId);
      const svc = new AgentAppServiceImpl(
        () => tm as never,
        () => null,
        () => sessionId,
        () => {},
      );
      await svc.cancel(sessionId, reason);
      expect(swarm.spawnGuard.cancelAll, `${reason} must NOT cascade`).not.toHaveBeenCalled();
      expect(swarm.parallelCoordinator.abortAllRunning, `${reason} must NOT cascade`).not.toHaveBeenCalled();
    }
  });

  it('double ESC during in-flight cancel is deduped (single fan-out)', async () => {
    const swarm = buildSwarmServicesMock();
    registerSwarmServices(swarm as Parameters<typeof registerSwarmServices>[0]);

    const sessionId = 'sess-dedupe';
    let cancelTaskResolve: () => void = () => {};
    const tm = {
      getSessionState: vi.fn().mockReturnValue({ status: 'running' }),
      cancelTask: vi.fn().mockImplementation(
        () => new Promise<void>((resolve) => { cancelTaskResolve = resolve; }),
      ),
      getOrCreateCurrentOrchestrator: vi.fn(),
    };
    const svc = new AgentAppServiceImpl(
      () => tm as never,
      () => null,
      () => sessionId,
      () => {},
    );

    const first = svc.cancel(sessionId, 'user-cancel');
    const second = svc.cancel(sessionId, 'user-cancel');

    // second invocation should reuse the first promise (no extra cancelTask)
    expect(tm.cancelTask).toHaveBeenCalledTimes(1);

    cancelTaskResolve();
    await Promise.all([first, second]);

    // fan-out triggered exactly once
    expect(swarm.spawnGuard.cancelAll).toHaveBeenCalledTimes(1);
    expect(swarm.parallelCoordinator.abortAllRunning).toHaveBeenCalledTimes(1);
  });
});
