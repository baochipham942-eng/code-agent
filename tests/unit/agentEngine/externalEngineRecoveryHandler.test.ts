import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ExternalAgentEngineKind } from '../../../src/shared/contract/agentEngine';
import type { RunKernelAdapter } from '../../../src/host/runtime/durableRunKernel';
import type { RunRehydrationPlan } from '../../../src/host/runtime/durableRunStores';
import { DurableRecoveryDispatcher } from '../../../src/host/runtime/durableRecoveryDispatcher';
import { createExternalEngineRecoveryHandler } from '../../../src/host/runtime/durableRecoveryHandlers';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';

function externalPlan(engine: ExternalAgentEngineKind, externalSessionId?: string): RunRehydrationPlan {
  const owner = { ownerId: 'owner', processInstanceId: 'new-process', epoch: 4, leaseExpiresAt: Date.now() + 60_000 };
  const operation = {
    runId: 'logical-run', operationId: 'external-engine-launch', attempt: 1, kind: 'external_engine' as const,
    status: 'waiting' as const, idempotencyKey: 'stable-launch', sideEffect: true,
    providerOperationId: externalSessionId ? `external-session:${externalSessionId}` : undefined,
    preparedAt: 1, updatedAt: 2,
  };
  return {
    envelope: {
      schemaVersion: 1, runId: 'logical-run', sessionId: 'logical-session',
      engine: { kind: 'external_cli', engine, ...(externalSessionId ? { externalSessionId } : {}) },
      status: 'recovering', attempt: 3,
      cursor: { nextEventSeq: 5, checkpointSeq: 1, engineCursor: { schemaVersion: 1, engine, externalSessionId } },
      owner, pendingOperations: [operation], childRuns: [], createdAt: 1, updatedAt: 3,
    },
    previousAttempt: { runId: 'logical-run', attempt: 2, processInstanceId: 'old-process', ownerId: 'owner', ownerEpoch: 3, status: 'ended', startedAt: 1 },
    checkpoint: {
      runId: 'logical-run', checkpointSeq: 1, attempt: 2, eventSeq: 4, status: 'running',
      cursor: { nextEventSeq: 5, checkpointSeq: 1, engineCursor: { schemaVersion: 1, engine, externalSessionId } },
      state: {
        schemaVersion: 1, engineKind: 'external_cli', engine,
        workspace: { cwd: '/tmp', fingerprint: 'workspace' },
        permissionProfile: 'read_only', model: 'audited-model',
      },
      checksum: 'checksum', createdAt: 2,
    },
    pendingOperations: [operation], childRuns: [], requiresHumanConfirmation: [],
  };
}

function registryFor(plan: RunRehydrationPlan): RunRegistry {
  const kernel = {
    recoverOnStartup: vi.fn(async () => [plan]),
    heartbeat: vi.fn(async (_runId, owner) => owner),
  } as unknown as RunKernelAdapter;
  const registry = new RunRegistry();
  registry.configureDurableKernel(kernel);
  return registry;
}

afterEach(() => vi.restoreAllMocks());

describe('external engine recovery handler', () => {
  it.each([
    ['codex_cli', 'codex'],
    ['claude_code', 'claude'],
  ] as const)('routes %s through its audited resume builder and preserves recovered identity', async (engine, runnerName) => {
    const candidate = externalPlan(engine, 'external-session');
    const registry = registryFor(candidate);
    await registry.recoverDurable();
    const codex = vi.fn(async (request) => ({
      runId: request.durableLifecycle!.runId, sessionId: request.sessionId, engine: 'codex_cli' as const,
      status: 'completed' as const, exitCode: 0,
    }));
    const claude = vi.fn(async (request) => ({
      runId: request.durableLifecycle!.runId, sessionId: request.sessionId, engine: 'claude_code' as const,
      status: 'completed' as const, exitCode: 0,
    }));
    const dispatcher = new DurableRecoveryDispatcher();
    dispatcher.registerEngineHandler(createExternalEngineRecoveryHandler({ registry, runners: { codex, claude } }));
    const first = await dispatcher.dispatch([candidate]);
    const second = await dispatcher.dispatch([candidate]);
    const runner = runnerName === 'codex' ? codex : claude;
    expect(first[0].reason).toBe('external resume completed');
    expect(first[0]).toMatchObject({ status: 'recovered', runId: 'logical-run', attempt: 3, ownerEpoch: 4 });
    expect(runner).toHaveBeenCalledTimes(1);
    expect(second[0]).toMatchObject({ status: 'duplicate' });
    const request = runner.mock.calls[0][0];
    expect(request).toMatchObject({ sessionId: 'logical-session', cwd: '/tmp', permissionProfile: 'read_only' });
    expect(request.resumeLaunch).toMatchObject({
      runId: 'logical-run', sessionId: 'logical-session', attempt: 3, ownerEpoch: 4,
      externalSessionId: 'external-session', permissionProfile: 'read_only',
    });
    expect(request.resumeLaunch.args).toContain(engine === 'codex_cli' ? 'resume' : '--resume');
    registry.clear();
  });

  it.each(['mimo_code', 'kimi_code'] as const)('keeps %s in requires_review without spawning', async (engine) => {
    const candidate = externalPlan(engine, 'external-session');
    const registry = registryFor(candidate);
    await registry.recoverDurable();
    const codex = vi.fn();
    const claude = vi.fn();
    const dispatcher = new DurableRecoveryDispatcher();
    dispatcher.registerEngineHandler(createExternalEngineRecoveryHandler({ registry, runners: { codex, claude } as never }));
    const results = await dispatcher.dispatch([candidate]);
    expect(results[0]).toMatchObject({ status: 'requires_review' });
    expect(codex).not.toHaveBeenCalled();
    expect(claude).not.toHaveBeenCalled();
    registry.clear();
  });

  it('does not spawn when the stable external session id is missing', async () => {
    const candidate = externalPlan('codex_cli');
    const registry = registryFor(candidate);
    await registry.recoverDurable();
    const codex = vi.fn();
    const claude = vi.fn();
    const dispatcher = new DurableRecoveryDispatcher();
    dispatcher.registerEngineHandler(createExternalEngineRecoveryHandler({ registry, runners: { codex, claude } as never }));
    const results = await dispatcher.dispatch([candidate]);
    expect(results[0]).toMatchObject({ status: 'requires_review' });
    expect(codex).not.toHaveBeenCalled();
    registry.clear();
  });
});
