import { afterEach, describe, expect, it, vi } from 'vitest';
vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import type { RunKernelAdapter } from '../../../../src/host/runtime/durableRunKernel';
import { DurableRunKernel } from '../../../../src/host/runtime/durableRunKernel';
import type { RunRehydrationPlan } from '../../../../src/host/runtime/durableRunStores';
import { createDurableRecoveryRuntime } from '../../../../src/host/runtime/durableRecoveryRuntime';
import { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import { DurableRunRepository } from '../../../../src/host/services/core/repositories/DurableRunRepository';

function nativePlan(): RunRehydrationPlan {
  return {
    envelope: {
      schemaVersion: 1, runId: 'native-recovery', sessionId: 'session-recovery', engine: { kind: 'native' },
      status: 'recovering', attempt: 2, cursor: { nextEventSeq: 2, checkpointSeq: 1 },
      owner: { ownerId: 'owner', processInstanceId: 'new', epoch: 2, leaseExpiresAt: 10_000 },
      pendingOperations: [], childRuns: [], createdAt: 1, updatedAt: 2,
    },
    previousAttempt: { runId: 'native-recovery', attempt: 1, processInstanceId: 'old', ownerId: 'owner', ownerEpoch: 1, status: 'ended', startedAt: 1 },
    checkpoint: null, pendingOperations: [], childRuns: [], requiresHumanConfirmation: [],
  };
}

function agentTeamPlan(): RunRehydrationPlan {
  const runId = 'team-recovery';
  return {
    envelope: {
      schemaVersion: 1,
      runId,
      sessionId: 'session-team-recovery',
      engine: { kind: 'agent_team', treeId: 'tree-recovery' },
      status: 'recovering',
      attempt: 113,
      cursor: { nextEventSeq: 2, checkpointSeq: 1 },
      owner: { ownerId: 'owner', processInstanceId: 'new', epoch: 113, leaseExpiresAt: 10_000 },
      pendingOperations: [{
        runId,
        operationId: 'node:swarm-agent.v1',
        attempt: 112,
        kind: 'child_run',
        status: 'dispatched',
        idempotencyKey: 'stable:team-recovery:child',
        sideEffect: false,
        preparedAt: 1,
        updatedAt: 2,
      }],
      childRuns: [],
      createdAt: 1,
      updatedAt: 2,
    },
    previousAttempt: {
      runId,
      attempt: 112,
      processInstanceId: 'old',
      ownerId: 'owner',
      ownerEpoch: 112,
      status: 'ended',
      startedAt: 1,
    },
    checkpoint: null,
    pendingOperations: [{
      runId,
      operationId: 'node:swarm-agent.v1',
      attempt: 112,
      kind: 'child_run',
      status: 'dispatched',
      idempotencyKey: 'stable:team-recovery:child',
      sideEffect: false,
      preparedAt: 1,
      updatedAt: 2,
    }],
    childRuns: [],
    requiresHumanConfirmation: [],
  };
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('DurableRecoveryRuntime startup ordering', () => {
  it('has handlers registered before the first recovery plan is consumed', async () => {
    const recoverDurable = vi.fn(async () => [nativePlan()]);
    const checkpointDurable = vi.fn(async () => undefined);
    const terminalDurable = vi.fn(async () => undefined);
    const runtime = createDurableRecoveryRuntime({
      registry: { recoverDurable, checkpointDurable, terminalDurable } as unknown as RunRegistry,
      kernel: {} as RunKernelAdapter,
      dataDir: '/tmp/durable-runtime-test',
      getMcpClient: () => { throw new Error('MCP is not needed for this plan'); },
      externalRunners: { codex: vi.fn(), claude: vi.fn() } as never,
    });
    const results = await runtime.recoverAndDispatch(100);
    expect(recoverDurable).toHaveBeenCalledWith(100);
    expect(results[0]).toMatchObject({ handler: 'native_production', status: 'failed' });
    await runtime.shutdown();
  });

  it('routes stored child runs through agent_team_production without a duplicate unsupported result', async () => {
    const recoverDurable = vi.fn(async () => [agentTeamPlan()]);
    const runtime = createDurableRecoveryRuntime({
      registry: { recoverDurable } as unknown as RunRegistry,
      kernel: {} as RunKernelAdapter,
      dataDir: '/tmp/durable-runtime-test',
      getMcpClient: () => { throw new Error('MCP is not needed for this plan'); },
      externalRunners: { codex: vi.fn(), claude: vi.fn() } as never,
    });

    const results = await runtime.recoverAndDispatch(100);

    expect(results).toEqual([
      expect.objectContaining({
        runId: 'team-recovery',
        attempt: 113,
        phase: 'engine',
        handler: 'agent_team_production',
        status: 'requires_review',
      }),
    ]);
    await runtime.shutdown();
  });

  it('reclaims an expired run on the next periodic tick through listRecoverable', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const db = new Database(':memory:');
    const repository = new DurableRunRepository(db);
    repository.migrate();
    const listRecoverable = vi.spyOn(repository, 'listRecoverable');
    const firstRegistry = new RunRegistry();
    firstRegistry.configureDurableKernel(new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'stopped-worker',
      leaseDurationMs: 200,
    }));
    await firstRegistry.startDurable({
      runId: 'run-swept',
      sessionId: 'session-swept',
      workspace: '/repo',
      cwd: '/repo',
    }, Date.now());
    firstRegistry.clear();

    const recoveryRegistry = new RunRegistry();
    const recoveryKernel = new DurableRunKernel({
      stores: repository,
      ownerId: 'native-host',
      processInstanceId: 'sweeper-worker',
      leaseDurationMs: 200,
    });
    recoveryRegistry.configureDurableKernel(recoveryKernel);
    const recover = vi.fn(async () => ({ status: 'recovered' as const, reason: 'test recovery' }));
    const runtime = createDurableRecoveryRuntime({
      registry: recoveryRegistry,
      kernel: recoveryKernel,
      dataDir: '/tmp/durable-runtime-test',
      getMcpClient: () => { throw new Error('unused'); },
      externalRunners: { codex: vi.fn(), claude: vi.fn() } as never,
      handlerOverrides: { native: { name: 'native_test', engineKind: 'native', recover } },
    });
    const onResults = vi.fn();
    const consoleError = vi.spyOn(console, 'error');
    runtime.startSweeper(100, { onResults });
    await vi.advanceTimersByTimeAsync(100);
    expect(await repository.get('run-swept')).toMatchObject({ attempt: 1, status: 'running' });
    await vi.advanceTimersByTimeAsync(100);
    expect(listRecoverable).toHaveBeenLastCalledWith(1_200, 100);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(await repository.get('run-swept')).toMatchObject({
      attempt: 2,
      status: 'recovering',
      owner: { processInstanceId: 'sweeper-worker', epoch: 2 },
    });
    expect(onResults).toHaveBeenLastCalledWith([
      expect.objectContaining({ runId: 'run-swept', attempt: 2, status: 'recovered' }),
    ]);
    expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[durable-sweeper] reclaimed runId=run-swept'));
    recoveryRegistry.clear();
    await runtime.shutdown();
    db.close();
  });

  it('does not reenter recovery while the previous tick is still running', async () => {
    vi.useFakeTimers();
    let finishFirstSweep: ((value: RunRehydrationPlan[]) => void) | undefined;
    const recoverDurable = vi.fn(() => new Promise<RunRehydrationPlan[]>((resolve) => {
      finishFirstSweep = resolve;
    }));
    const runtime = createDurableRecoveryRuntime({
      registry: { recoverDurable } as unknown as RunRegistry,
      kernel: {} as RunKernelAdapter,
      dataDir: '/tmp/durable-runtime-test',
      getMcpClient: () => { throw new Error('unused'); },
      externalRunners: { codex: vi.fn(), claude: vi.fn() } as never,
    });

    runtime.startSweeper(100);
    await vi.advanceTimersByTimeAsync(100);
    await vi.advanceTimersByTimeAsync(300);
    expect(recoverDurable).toHaveBeenCalledTimes(1);
    finishFirstSweep?.([]);
    await Promise.resolve();
    await Promise.resolve();
    await runtime.shutdown();
  });

  it('cancels the periodic timer on shutdown', async () => {
    vi.useFakeTimers();
    const recoverDurable = vi.fn(async () => []);
    const runtime = createDurableRecoveryRuntime({
      registry: { recoverDurable } as unknown as RunRegistry,
      kernel: {} as RunKernelAdapter,
      dataDir: '/tmp/durable-runtime-test',
      getMcpClient: () => { throw new Error('unused'); },
      externalRunners: { codex: vi.fn(), claude: vi.fn() } as never,
    });

    runtime.startSweeper(100);
    expect(vi.getTimerCount()).toBe(1);
    await runtime.shutdown();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    expect(recoverDurable).not.toHaveBeenCalled();
  });
});
