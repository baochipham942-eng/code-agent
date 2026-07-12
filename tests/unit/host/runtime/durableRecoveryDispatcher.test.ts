import { describe, expect, it, vi } from 'vitest';
import type { PendingOperation, RunEngineRef, RunStatus } from '../../../../src/shared/contract/durableRun';
import {
  DurableRecoveryDispatcher,
  type DurableEngineRecoveryHandler,
} from '../../../../src/host/runtime/durableRecoveryDispatcher';
import type { RunRehydrationPlan } from '../../../../src/host/runtime/durableRunStores';

function plan(input: {
  runId: string;
  engine: RunEngineRef;
  status?: RunStatus;
  operations?: PendingOperation[];
  attempt?: number;
}): RunRehydrationPlan {
  const attempt = input.attempt ?? 2;
  const owner = { ownerId: 'owner', processInstanceId: `process-${attempt}`, epoch: attempt, leaseExpiresAt: 99_999 };
  return {
    envelope: {
      schemaVersion: 1,
      runId: input.runId,
      sessionId: `session-${input.runId}`,
      engine: input.engine,
      status: input.status ?? 'recovering',
      attempt,
      cursor: { nextEventSeq: 2, checkpointSeq: 1 },
      owner,
      pendingOperations: input.operations ?? [],
      childRuns: [],
      createdAt: 1,
      updatedAt: 2,
    },
    previousAttempt: {
      runId: input.runId, attempt: attempt - 1, processInstanceId: 'old', ownerId: 'owner', ownerEpoch: attempt - 1,
      status: 'ended', startedAt: 1,
    },
    checkpoint: null,
    pendingOperations: input.operations ?? [],
    childRuns: [],
    requiresHumanConfirmation: [],
  };
}

function operation(runId: string, operationId: string, providerOperationId?: string): PendingOperation {
  return {
    runId,
    operationId,
    attempt: 1,
    kind: 'tool_call',
    status: 'waiting',
    idempotencyKey: `stable:${runId}:${operationId}`,
    sideEffect: true,
    providerOperationId,
    preparedAt: 1,
    updatedAt: 1,
  };
}

function engineHandler(engineKind: RunEngineRef['kind'], recover = vi.fn(async () => ({
  status: 'recovered' as const,
  reason: 'ok',
}))): DurableEngineRecoveryHandler {
  return { name: engineKind, engineKind, recover };
}

describe('DurableRecoveryDispatcher', () => {
  it('routes Team and External plans to their engine handlers', async () => {
    const dispatcher = new DurableRecoveryDispatcher();
    const team = vi.fn(async () => ({ status: 'recovered' as const, reason: 'team' }));
    const external = vi.fn(async () => ({ status: 'recovered' as const, reason: 'external' }));
    dispatcher.registerEngineHandler(engineHandler('agent_team', team));
    dispatcher.registerEngineHandler(engineHandler('external_cli', external));
    await dispatcher.dispatch([
      plan({ runId: 'team', engine: { kind: 'agent_team', treeId: 'tree' } }),
      plan({ runId: 'external', engine: { kind: 'external_cli', engine: 'codex_cli', externalSessionId: 'thread' } }),
    ]);
    expect(team).toHaveBeenCalledTimes(1);
    expect(external).toHaveBeenCalledTimes(1);
  });

  it.each([
    { kind: 'native' as const },
    { kind: 'agent_team' as const, treeId: 'tree' },
  ])('finds explicit MCP operations inside $kind plans', async (engine) => {
    const dispatcher = new DurableRecoveryDispatcher();
    dispatcher.registerEngineHandler(engineHandler(engine.kind));
    const recover = vi.fn(async () => ({ status: 'observing' as const, reason: 'mcp queried' }));
    dispatcher.registerOperationHandler({
      name: 'mcp',
      matches: (_plan, candidate) => candidate.providerOperationId?.startsWith('mcp-task:v1:') === true,
      recover,
    });
    const run = plan({ runId: `run-${engine.kind}`, engine, operations: [operation(`run-${engine.kind}`, 'tool-1', 'mcp-task:v1:handle')] });
    const results = await dispatcher.dispatch([run]);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(results).toEqual(expect.arrayContaining([expect.objectContaining({ phase: 'operation', handler: 'mcp', status: 'observing' })]));
  });

  it('isolates one handler failure and still checks every run', async () => {
    const dispatcher = new DurableRecoveryDispatcher();
    const recover = vi.fn(async (candidate: RunRehydrationPlan) => {
      if (candidate.envelope.runId === 'bad') throw new Error('broken handler');
      return { status: 'recovered' as const, reason: 'healthy' };
    });
    dispatcher.registerEngineHandler(engineHandler('native', recover));
    const results = await dispatcher.dispatch([
      plan({ runId: 'bad', engine: { kind: 'native' } }),
      plan({ runId: 'good', engine: { kind: 'native' } }),
    ]);
    expect(recover).toHaveBeenCalledTimes(2);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ runId: 'bad', status: 'failed' }),
      expect.objectContaining({ runId: 'good', status: 'recovered' }),
    ]));
  });

  it('dispatches the same run/attempt/owner only once', async () => {
    const dispatcher = new DurableRecoveryDispatcher();
    const recover = vi.fn(async () => ({ status: 'recovered' as const, reason: 'started once' }));
    dispatcher.registerEngineHandler(engineHandler('agent_team', recover));
    const candidate = plan({ runId: 'same', engine: { kind: 'agent_team', treeId: 'tree' } });
    await Promise.all([dispatcher.dispatch([candidate]), dispatcher.dispatch([candidate])]);
    const repeated = await dispatcher.dispatch([candidate]);
    expect(recover).toHaveBeenCalledTimes(1);
    expect(repeated[0]).toMatchObject({ status: 'duplicate' });
  });

  it.each(['completed', 'failed', 'cancelled'] as const)('never invokes handlers for terminal %s runs', async (status) => {
    const dispatcher = new DurableRecoveryDispatcher();
    const recover = vi.fn(async () => ({ status: 'recovered' as const, reason: 'should not run' }));
    dispatcher.registerEngineHandler(engineHandler('external_cli', recover));
    const results = await dispatcher.dispatch([plan({ runId: status, engine: { kind: 'external_cli', engine: 'codex_cli' }, status })]);
    expect(recover).not.toHaveBeenCalled();
    expect(results[0]).toMatchObject({ status: 'already_terminal' });
  });

  it('reports unsupported pending operations instead of silently dropping them', async () => {
    const dispatcher = new DurableRecoveryDispatcher();
    dispatcher.registerEngineHandler(engineHandler('native'));
    const results = await dispatcher.dispatch([plan({ runId: 'unknown-op', engine: { kind: 'native' }, operations: [operation('unknown-op', 'tool-x')] })]);
    expect(results).toEqual(expect.arrayContaining([
      expect.objectContaining({ phase: 'operation', status: 'unsupported', operationId: 'tool-x' }),
    ]));
  });
});
