import { describe, expect, it, vi } from 'vitest';
import { NativeRecoveryHost, type NativeRecoveryDescriptor, type NativeRecoveryHostPorts } from '../../../../src/host/runtime/nativeRecoveryHost';
import type { RunRehydrationPlan } from '../../../../src/host/runtime/durableRunStores';
import type { PendingOperation } from '../../../../src/shared/contract/durableRun';
import type { RunRegistry } from '../../../../src/host/runtime/runRegistry';

function plan(operation: PendingOperation): RunRehydrationPlan {
  const state = {
    schemaVersion: 1 as const, kind: 'native' as const, sourceMessageId: 'message-1',
    provider: 'provider', model: 'model',
    workspace: { root: '/repo', cwd: '/repo', fingerprint: 'fp' },
    logicalOperationId: 'logical', operationId: operation.operationId,
    phase: operation.kind === 'approval' ? 'approval_waiting' as const
      : operation.kind === 'tool_call' ? 'tool_dispatched' as const : 'after_model_dispatch' as const,
    checkpointSequence: 1,
    ...(operation.kind === 'approval' ? { approvalId: 'approval-1' } : {}),
  };
  return {
    envelope: {
      schemaVersion: 1, runId: 'run-1', sessionId: 'session-1', engine: { kind: 'native' },
      status: 'recovering', attempt: 2, cursor: { nextEventSeq: 2, checkpointSeq: 1 },
      owner: { ownerId: 'owner', processInstanceId: 'new', epoch: 2, leaseExpiresAt: 100 },
      pendingOperations: [operation], childRuns: [], createdAt: 1, updatedAt: 2,
    },
    previousAttempt: { runId: 'run-1', attempt: 1, processInstanceId: 'old', ownerId: 'owner', ownerEpoch: 1, status: 'lost', startedAt: 1 },
    checkpoint: { runId: 'run-1', checkpointSeq: 1, attempt: 1, eventSeq: 1, status: 'running', cursor: { nextEventSeq: 2, checkpointSeq: 1 }, state, checksum: 'x', createdAt: 1 },
    pendingOperations: [operation], childRuns: [], requiresHumanConfirmation: [],
  };
}

function operation(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    runId: 'run-1', operationId: 'op-1', attempt: 1, kind: 'model_call', status: 'dispatched',
    idempotencyKey: 'stable', sideEffect: false, preparedAt: 1, updatedAt: 1, ...overrides,
  };
}

function fixture(overrides: Partial<NativeRecoveryHostPorts> = {}) {
  const registry = { checkpointDurable: vi.fn(), terminalDurable: vi.fn() } as unknown as RunRegistry;
  const ports: NativeRecoveryHostPorts = {
    resolveWorkspace: vi.fn(async (_descriptor: NativeRecoveryDescriptor) => ({ ok: true as const, root: '/repo', cwd: '/repo', fingerprint: 'fp' })),
    model: {
      dispatchPrepared: vi.fn(async () => ({ resultRef: 'model:prepared' })),
      queryResult: vi.fn(async () => ({ resultRef: 'model:queried' })),
      canRetrySafely: vi.fn(async () => true),
      retrySafe: vi.fn(async () => ({ resultRef: 'model:retried' })),
    },
    tool: { queryResult: vi.fn(async () => ({ resultRef: 'tool:queried' })) },
    approval: { read: vi.fn(async (_approvalId: string) => 'pending' as const) },
    ...overrides,
  };
  return { registry, ports, handler: new NativeRecoveryHost(registry, ports).createHandler() };
}

describe('NativeRecoveryHost production recovery', () => {
  it.each([
    [operation({ status: 'prepared' }), 'execute_prepared_model_once'],
    [operation({ providerOperationId: 'provider-result' }), 'query_original_model_result'],
    [operation(), 'retry_safe_model_compute_once'],
    [operation({ kind: 'tool_call', sideEffect: true, providerOperationId: 'tool-ledger' }), 'query_confirmed_tool_result'],
  ] as const)('commits one result and one terminal for safe recovery %#', async (pending, reason) => {
    const { handler, registry } = fixture();
    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({ status: 'recovered', reason });
    expect(registry.checkpointDurable).toHaveBeenCalledOnce();
    expect(registry.terminalDurable).toHaveBeenCalledOnce();
  });

  it('keeps unknown writes in review without invoking the tool', async () => {
    const { handler, ports, registry } = fixture();
    const pending = operation({ kind: 'tool_call', sideEffect: true, providerOperationId: undefined });
    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({ status: 'requires_review', reason: 'unknown_write_side_effect' });
    expect(ports.tool.queryResult).not.toHaveBeenCalled();
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('reuses the unanswered approval identity', async () => {
    const { handler, ports, registry } = fixture();
    const pending = operation({ kind: 'approval', status: 'waiting', providerOperationId: 'approval:approval-1' });
    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({ status: 'observing', reason: 'restore_same_approval' });
    expect(ports.approval.read).toHaveBeenCalledWith('approval-1');
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });
});
