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
    tool: {
      queryResult: vi.fn(async () => ({ resultRef: 'tool:queried' })),
      classifyReplaySafety: vi.fn(async () => ({ stored: 'unknown' as const, current: 'unknown' as const })),
      dispatchPrepared: vi.fn(async () => ({ resultRef: 'tool:replayed' })),
      interrupt: vi.fn(async () => ({ resultRef: 'tool:interrupted' })),
    },
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
  ] as const)('commits the recovered operation without terminalizing the run %#', async (pending, reason) => {
    const { handler, registry } = fixture();
    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject(
      pending.kind === 'model_call'
        ? { status: 'requires_review' }
        : { status: 'recovered', reason },
    );
    expect(registry.checkpointDurable).toHaveBeenCalledOnce();
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('feeds an unknown local write back as interrupted without replaying the tool', async () => {
    const { handler, ports, registry } = fixture({
      tool: {
        queryResult: vi.fn(async () => null),
        classifyReplaySafety: vi.fn(async () => ({ stored: 'unknown' as const, current: 'unknown' as const })),
        dispatchPrepared: vi.fn(async () => ({ resultRef: 'must-not-dispatch' })),
        interrupt: vi.fn(async () => ({ resultRef: 'must-not-interrupt' })),
      },
    });
    const pending = operation({ kind: 'tool_call', sideEffect: true, providerOperationId: undefined });
    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({ status: 'recovered', reason: 'interrupt_unproven_tool_replay' });
    expect(ports.tool.queryResult).not.toHaveBeenCalled();
    expect(ports.tool.dispatchPrepared).not.toHaveBeenCalled();
    expect(ports.tool.interrupt).toHaveBeenCalledOnce();
    expect(registry.checkpointDurable).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'running' }));
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('parks an unknown external write with guard_halt and never dispatches it', async () => {
    const { handler, ports, registry } = fixture({
      tool: {
        queryResult: vi.fn(async () => null),
        classifyReplaySafety: vi.fn(async () => ({ stored: 'unknown' as const, current: 'unknown' as const })),
        dispatchPrepared: vi.fn(async () => ({ resultRef: 'must-not-dispatch' })),
        interrupt: vi.fn(async () => ({ resultRef: 'must-not-interrupt' })),
      },
    });
    const pending = operation({ kind: 'tool_call', sideEffect: true, providerOperationId: 'mcp-task:v1:write-1' });
    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({
      status: 'requires_review', reason: 'unknown_write_side_effect',
    });
    expect(ports.tool.dispatchPrepared).not.toHaveBeenCalled();
    expect(ports.tool.interrupt).not.toHaveBeenCalled();
    expect(registry.checkpointDurable).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 'waiting', interruptCause: 'guard_halt',
    }));
  });

  it('settles every non-terminal sibling before returning to the loop', async () => {
    const first = operation({ operationId: 'tool:first', kind: 'tool_call', providerOperationId: 'first-ledger', sideEffect: false });
    const second = operation({ operationId: 'tool:second', kind: 'tool_call', providerOperationId: 'second-ledger', sideEffect: false });
    const recoveryPlan = plan(second);
    recoveryPlan.pendingOperations = [first, second];
    recoveryPlan.envelope.pendingOperations = [first, second];
    const continueLoop = vi.fn(async () => undefined);
    const { handler, ports, registry } = fixture({ continueLoop });

    await expect(handler.recover(recoveryPlan, 10)).resolves.toMatchObject({
      status: 'recovered', reason: 'resume_live_loop',
    });
    expect(ports.tool.queryResult).toHaveBeenCalledTimes(2);
    expect(continueLoop).toHaveBeenCalledOnce();
    const checkpoint = (registry.checkpointDurable as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1] as {
      pendingOperations: PendingOperation[];
    };
    expect(checkpoint.pendingOperations).toEqual(expect.arrayContaining([
      expect.objectContaining({ operationId: 'tool:first', status: 'succeeded' }),
      expect.objectContaining({ operationId: 'tool:second', status: 'succeeded' }),
    ]));
  });

  it('passes settled siblings into the prepared model continuation fence', async () => {
    const sibling = operation({
      operationId: 'tool:sibling',
      kind: 'tool_call',
      providerOperationId: 'sibling-ledger',
      sideEffect: false,
    });
    const model = operation({ operationId: 'model:target', status: 'prepared' });
    const recoveryPlan = plan(model);
    recoveryPlan.pendingOperations = [sibling, model];
    recoveryPlan.envelope.pendingOperations = [sibling, model];
    const { handler, ports } = fixture({
      model: {
        dispatchPrepared: vi.fn(async (input) => {
          expect(input.plan.pendingOperations).toEqual([
            expect.objectContaining({ operationId: 'tool:sibling', status: 'succeeded' }),
            expect.objectContaining({ operationId: 'model:target', status: 'prepared' }),
          ]);
          return { resultRef: 'model:prepared' };
        }),
        queryResult: vi.fn(async () => ({ resultRef: 'model:queried' })),
        canRetrySafely: vi.fn(async () => true),
        retrySafe: vi.fn(async () => ({ resultRef: 'model:retried' })),
      },
      tool: {
        queryResult: vi.fn(async () => ({ resultRef: 'tool:sibling' })),
        classifyReplaySafety: vi.fn(async () => ({ stored: 'unknown' as const, current: 'unknown' as const })),
        dispatchPrepared: vi.fn(async () => ({ resultRef: 'tool:replayed' })),
        interrupt: vi.fn(async () => ({ resultRef: 'tool:interrupted' })),
      },
    });

    await expect(handler.recover(recoveryPlan, 10)).resolves.toMatchObject({ status: 'recovered' });
    expect(ports.model.dispatchPrepared).toHaveBeenCalledOnce();
  });

  it('reviews an already-settled model operation without requesting it again', async () => {
    const pending = operation({ status: 'succeeded', resultRef: 'model:final' });
    const { handler, ports, registry } = fixture();

    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({
      status: 'requires_review', reason: 'native_operation_already_settled',
    });
    expect(ports.model.dispatchPrepared).not.toHaveBeenCalled();
    expect(registry.checkpointDurable).toHaveBeenCalledWith('run-1', expect.objectContaining({ status: 'waiting' }));
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('replays only when stored and current declarations are both automatic', async () => {
    const { handler, ports } = fixture({
      tool: {
        queryResult: vi.fn(async () => null),
        classifyReplaySafety: vi.fn(async () => ({ stored: 'automatic' as const, current: 'automatic' as const })),
        dispatchPrepared: vi.fn(async () => ({ resultRef: 'tool:replayed' })),
        interrupt: vi.fn(async () => ({ resultRef: 'tool:interrupted' })),
      },
    });
    const pending = operation({ kind: 'tool_call', sideEffect: false, providerOperationId: 'tool-ledger' });

    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({
      status: 'recovered',
      reason: 'replay_safe_tool_once',
    });
    expect(ports.tool.dispatchPrepared).toHaveBeenCalledOnce();
    expect(ports.tool.interrupt).not.toHaveBeenCalled();
  });

  it('interrupts when the stored automatic declaration has degraded to unknown', async () => {
    const { handler, ports } = fixture({
      tool: {
        queryResult: vi.fn(async () => null),
        classifyReplaySafety: vi.fn(async () => ({ stored: 'automatic' as const, current: 'unknown' as const })),
        dispatchPrepared: vi.fn(async () => ({ resultRef: 'tool:replayed' })),
        interrupt: vi.fn(async () => ({ resultRef: 'tool:interrupted' })),
      },
    });
    const pending = operation({ kind: 'tool_call', sideEffect: false, providerOperationId: 'tool-ledger' });

    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({
      status: 'recovered',
      reason: 'interrupt_unproven_tool_replay',
    });
    expect(ports.tool.dispatchPrepared).not.toHaveBeenCalled();
    expect(ports.tool.interrupt).toHaveBeenCalledOnce();
  });

  it('reuses the unanswered approval identity', async () => {
    const { handler, ports, registry } = fixture();
    const pending = operation({ kind: 'approval', status: 'waiting', providerOperationId: 'approval:approval-1' });
    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({ status: 'observing', reason: 'restore_same_approval' });
    expect(ports.approval.read).toHaveBeenCalledWith('approval-1');
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('dispatches an approved operation once, fences it, and returns to the live loop', async () => {
    const continueLoop = vi.fn(async () => undefined);
    const dispatchPrepared = vi.fn(async () => ({ resultRef: 'approval:executed' }));
    const pending = operation({
      kind: 'approval',
      status: 'waiting',
      operationId: 'approval:approval-1',
      providerOperationId: 'approval:approval-1',
    });
    const { handler, registry } = fixture({
      continueLoop,
      approval: {
        read: vi.fn(async () => ({ status: 'approved' as const })),
        dispatchPrepared,
      },
    });

    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({
      status: 'recovered',
      reason: 'resume_live_loop',
      detail: { resultRef: 'approval:executed' },
    });
    expect(dispatchPrepared).toHaveBeenCalledOnce();
    expect(continueLoop).toHaveBeenCalledOnce();
    expect(registry.checkpointDurable).toHaveBeenCalledWith('run-1', expect.objectContaining({
      events: [expect.objectContaining({ type: 'native_approval_recovery_dispatch_fenced' })],
      pendingOperations: [expect.objectContaining({ status: 'unknown', requiresHumanConfirmation: true })],
    }));
    expect((registry.checkpointDurable as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1])
      .toMatchObject({ pendingOperations: [expect.objectContaining({ status: 'succeeded', resultRef: 'approval:executed' })] });
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('parks a fenced approval after a crash when no result was materialized', async () => {
    const continueLoop = vi.fn(async () => undefined);
    const dispatchPrepared = vi.fn(async () => ({ resultRef: 'approval:executed' }));
    const queryResult = vi.fn(async () => null);
    const initial = operation({
      kind: 'approval',
      status: 'waiting',
      operationId: 'approval:approval-1',
      providerOperationId: 'approval:approval-1',
    });
    const { handler } = fixture({
      continueLoop,
      approval: {
        read: vi.fn(async () => ({ status: 'approved' as const })),
        queryResult,
        dispatchPrepared,
      },
    });

    await expect(handler.recover(plan(initial), 10)).resolves.toMatchObject({ status: 'recovered' });
    const fenced = { ...initial, status: 'unknown' as const, requiresHumanConfirmation: true };
    await expect(handler.recover(plan(fenced), 11)).resolves.toMatchObject({
      status: 'requires_review',
      reason: 'approval_dispatch_outcome_unknown',
    });
    expect(dispatchPrepared).toHaveBeenCalledOnce();
    expect(queryResult).toHaveBeenCalledOnce();
  });

  it('feeds a rejected approval and its feedback to the model before resuming the loop', async () => {
    const continueLoop = vi.fn(async () => undefined);
    const reject = vi.fn(async (_input, feedback?: string | null) => {
      expect(feedback).toBe('需要补充范围');
      return { resultRef: 'approval:rejected' };
    });
    const pending = operation({
      kind: 'approval',
      status: 'waiting',
      operationId: 'approval:approval-1',
      providerOperationId: 'approval:approval-1',
    });
    const { handler, ports, registry } = fixture({
      continueLoop,
      approval: {
        read: vi.fn(async () => ({ status: 'rejected' as const, feedback: '需要补充范围' })),
        reject,
      },
    });

    await expect(handler.recover(plan(pending), 10)).resolves.toMatchObject({
      status: 'recovered',
      reason: 'resume_live_loop',
      detail: { resultRef: 'approval:rejected' },
    });
    expect(ports.approval.read).toHaveBeenCalledWith('approval-1');
    expect(reject).toHaveBeenCalledOnce();
    expect(continueLoop).toHaveBeenCalledOnce();
    expect((registry.checkpointDurable as unknown as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[1])
      .toMatchObject({ pendingOperations: [expect.objectContaining({ status: 'failed', resultRef: 'approval:rejected' })] });
  });

  it('resumes the live-loop replacement when the fenced model op was settled as abandoned', async () => {
    const fenced = operation({
      operationId: 'model:fenced',
      status: 'abandoned',
      resultRef: 'model-recovery:superseded-by-live-loop:model:fenced',
    });
    const live = operation({ operationId: 'model:live', status: 'prepared', idempotencyKey: 'live' });
    const dispatchPrepared = vi.fn(async (_input: Parameters<NativeRecoveryHostPorts['model']['dispatchPrepared']>[0]) => ({ resultRef: 'model:live-result', loopResumed: true }));
    const { handler, registry } = fixture({
      continuationExecutor: 'available',
      model: {
        dispatchPrepared,
        queryResult: vi.fn(async () => null),
        canRetrySafely: vi.fn(async () => false),
        retrySafe: vi.fn(async () => ({ resultRef: 'unused' })),
      },
    });
    const recoveryPlan = plan(live);
    recoveryPlan.pendingOperations = [fenced, live];
    recoveryPlan.envelope.pendingOperations = [fenced, live];
    (recoveryPlan.checkpoint!.state as NativeRecoveryDescriptor).operationId = live.operationId;

    await expect(handler.recover(recoveryPlan, 10)).resolves.toMatchObject({
      status: 'recovered',
      reason: 'resume_live_loop',
    });
    expect(dispatchPrepared).toHaveBeenCalledOnce();
    expect(dispatchPrepared.mock.calls[0]?.[0]?.operation.operationId).toBe('model:live');
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('does not auto-replay a leftover unknown model_call beside a live-loop replacement', async () => {
    const unknown = operation({ operationId: 'model:unknown', status: 'unknown' });
    const live = operation({ operationId: 'model:live', status: 'prepared', idempotencyKey: 'live' });
    const dispatchPrepared = vi.fn(async () => ({ resultRef: 'must-not-run', loopResumed: true }));
    const { handler } = fixture({
      continuationExecutor: 'available',
      model: {
        dispatchPrepared,
        queryResult: vi.fn(async () => null),
        canRetrySafely: vi.fn(async () => false),
        retrySafe: vi.fn(async () => ({ resultRef: 'unused' })),
      },
    });
    const recoveryPlan = plan(live);
    recoveryPlan.pendingOperations = [unknown, live];
    recoveryPlan.envelope.pendingOperations = [unknown, live];
    (recoveryPlan.checkpoint!.state as NativeRecoveryDescriptor).operationId = live.operationId;

    await expect(handler.recover(recoveryPlan, 10)).resolves.toMatchObject({
      status: 'requires_review',
      reason: 'native_operation_not_safely_recoverable',
    });
    expect(dispatchPrepared).not.toHaveBeenCalled();
  });

  it('fails closed when the persisted multi-source scope no longer matches the Project', async () => {
    const pending = operation({ status: 'prepared' });
    const recoveryPlan = plan(pending);
    const descriptor = recoveryPlan.checkpoint!.state as NativeRecoveryDescriptor;
    descriptor.workspace.scope = {
      projectId: 'project-1',
      primaryRoot: '/repo',
      roots: [{
        sourceId: 'primary',
        path: '/repo',
        role: 'primary',
        access: 'read_write',
        identityDev: '1',
        identityIno: '2',
      }],
      version: 'scope-v1',
    };
    const { handler, ports, registry } = fixture({
      resolveWorkspaceScopeVersion: vi.fn(async () => 'scope-v2'),
    });

    await expect(handler.recover(recoveryPlan, 10)).resolves.toMatchObject({
      status: 'requires_review',
      reason: 'native_workspace_scope_drift',
    });
    expect(ports.model.dispatchPrepared).not.toHaveBeenCalled();
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('keeps workspace scope drift in manual review even without a continuation executor', async () => {
    const pending = operation({ status: 'prepared' });
    const recoveryPlan = plan(pending);
    const descriptor = recoveryPlan.checkpoint!.state as NativeRecoveryDescriptor;
    descriptor.workspace.scope = {
      projectId: 'project-1',
      primaryRoot: '/repo',
      roots: [],
      version: 'scope-v1',
    };
    const { handler, registry } = fixture({
      continuationExecutor: 'unavailable',
      resolveWorkspaceScopeVersion: vi.fn(async () => 'scope-v2'),
    });

    await expect(handler.recover(recoveryPlan, 10)).resolves.toMatchObject({
      status: 'requires_review',
      reason: 'native_workspace_scope_drift',
    });
    expect(registry.checkpointDurable).toHaveBeenCalledWith('run-1', expect.objectContaining({
      status: 'waiting',
    }));
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('recovers a legacy synthetic scope when the recomputed version still matches', async () => {
    const pending = operation({ status: 'prepared' });
    const recoveryPlan = plan(pending);
    const descriptor = recoveryPlan.checkpoint!.state as NativeRecoveryDescriptor;
    // startDurable 未带 Project scope 时 checkpoint 落的就是这个合成 scope。
    descriptor.workspace.scope = {
      projectId: 'legacy-background-authority',
      primaryRoot: '/repo',
      roots: [{
        sourceId: 'legacy-background-primary',
        path: '/repo',
        role: 'primary',
        access: 'read_write',
      }],
      version: 'legacy-v1',
    };
    const resolveWorkspaceScopeVersion = vi.fn(async () => 'legacy-v1');
    const { handler, registry } = fixture({ resolveWorkspaceScopeVersion });

    await expect(handler.recover(recoveryPlan, 10)).resolves.toMatchObject({
      status: 'requires_review',
      reason: 'native_model_result_materialized_requires_review',
    });
    // 端口契约：入参是整个 scope（恢复侧据 projectId 分流重算/查库），不是裸 id。
    expect(resolveWorkspaceScopeVersion).toHaveBeenCalledWith(descriptor.workspace.scope);
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('still reviews when the Project behind a real scope was deleted', async () => {
    const pending = operation({ status: 'prepared' });
    const recoveryPlan = plan(pending);
    const descriptor = recoveryPlan.checkpoint!.state as NativeRecoveryDescriptor;
    descriptor.workspace.scope = {
      projectId: 'project-deleted',
      primaryRoot: '/repo',
      roots: [],
      version: 'scope-v1',
    };
    const { handler, registry } = fixture({
      resolveWorkspaceScopeVersion: vi.fn(async () => null),
    });

    await expect(handler.recover(recoveryPlan, 10)).resolves.toMatchObject({
      status: 'requires_review',
      reason: 'native_workspace_scope_drift',
    });
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });
});

describe('NativeRecoveryHost interrupted goal run (P0 false-completion止血)', () => {
  const goalState = {
    contract: { goal: 'ship the change', verifyCommand: 'npm test', tokenBudget: 1000, maxTurns: 5, allowSwarm: false },
    status: 'pending' as const,
    inactiveTurns: 0,
    completionRequested: false,
    swarmTokensUsed: 0,
    gateFailureCounts: { 1: 0, 2: 0 },
    verificationDegraded: false,
    turnsCompleted: 1,
    tokensUsed: 20,
    inputTokensUsed: 12,
    outputTokensUsed: 8,
    wallClockElapsedMs: 120,
  };

  function goalPlan(pending: PendingOperation): RunRehydrationPlan {
    const base = plan(pending);
    const checkpoint = base.checkpoint!;
    return {
      ...base,
      checkpoint: { ...checkpoint, state: { ...(checkpoint.state as object), isGoalRun: true, goalState } },
    };
  }

  function checkpointArg(registry: RunRegistry) {
    const mock = registry.checkpointDurable as unknown as ReturnType<typeof vi.fn>;
    return mock.mock.calls[0][1] as {
      status: string;
      events: Array<{ type: string; payload: unknown }>;
    };
  }

  it('routes prepared goal recovery to review without false completion', async () => {
    const { handler, ports, registry } = fixture();
    await expect(handler.recover(goalPlan(operation({ status: 'prepared' })), 10))
      .resolves.toMatchObject({ status: 'requires_review' });
    expect(registry.terminalDurable).not.toHaveBeenCalled();
    expect(registry.checkpointDurable).toHaveBeenCalledOnce();
    expect(ports.model.dispatchPrepared).toHaveBeenCalledOnce();
  });

  it('parks a goal whose state cannot be rebuilt, without emitting a false completion', async () => {
    const { handler, registry } = fixture();
    const broken = goalPlan(operation({ status: 'prepared' }));
    (broken.checkpoint!.state as Record<string, unknown>).goalState = undefined;
    await expect(handler.recover(broken, 10)).resolves.toMatchObject({
      status: 'requires_review', reason: 'goal_run_state_rebuild_failed',
    });
    const checkpoint = checkpointArg(registry);
    expect(checkpoint.status).toBe('waiting');
    expect((registry.checkpointDurable as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1]).toEqual(expect.objectContaining({
      interruptCause: 'guard_halt',
    }));
    expect(checkpoint.events).toContainEqual(expect.objectContaining({
      type: 'native_recovery_requires_review',
      payload: { reason: 'goal_run_state_rebuild_failed' },
    }));
  });

  it('refuses to auto-complete even for a confirmed side-effect tool result', async () => {
    const { handler, ports, registry } = fixture();
    const pending = operation({ kind: 'tool_call', sideEffect: true, providerOperationId: 'tool-ledger' });
    await expect(handler.recover(goalPlan(pending), 10)).resolves.toMatchObject({ status: 'recovered' });
    expect(ports.tool.queryResult).toHaveBeenCalledOnce();
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('parks a goal state rebuild failure even when no continuation executor is available', async () => {
    const { handler, registry } = fixture({ continuationExecutor: 'unavailable' });
    const broken = goalPlan(operation({ status: 'prepared' }));
    (broken.checkpoint!.state as Record<string, unknown>).goalState = undefined;
    await expect(handler.recover(broken, 10))
      .resolves.toMatchObject({ status: 'requires_review', reason: 'goal_run_state_rebuild_failed' });
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('non-goal descriptor with a prepared model requires review without re-dispatch', async () => {
    const { handler, registry } = fixture();
    await expect(handler.recover(plan(operation({ status: 'prepared' })), 10))
      .resolves.toMatchObject({ status: 'requires_review' });
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('legacy checkpoint without isGoalRun field is treated as non-goal (back-compat)', async () => {
    const { handler, registry } = fixture();
    const legacy = plan(operation({ status: 'prepared' }));
    expect('isGoalRun' in (legacy.checkpoint!.state as object)).toBe(false);
    await expect(handler.recover(legacy, 10)).resolves.toMatchObject({ status: 'requires_review' });
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('does not re-enter the loop when goal reconstruction fails', async () => {
    const continueLoop = vi.fn(async () => undefined);
    const { handler, registry } = fixture({ continueLoop });
    const broken = goalPlan(operation({ status: 'prepared' }));
    (broken.checkpoint!.state as Record<string, unknown>).goalState = {
      ...goalState,
      contract: { ...goalState.contract, tokenBudget: 0 },
    };
    await expect(handler.recover(broken, 10)).resolves.toMatchObject({
      status: 'requires_review', reason: 'goal_run_state_rebuild_failed',
    });
    expect(continueLoop).not.toHaveBeenCalled();
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });

  it('reconstructs a pending goal and resumes without a completed terminal', async () => {
    const continueLoop = vi.fn(async () => undefined);
    const { handler, registry } = fixture({
      continueLoop,
      model: {
        dispatchPrepared: vi.fn(async () => ({ resultRef: 'model:prepared', loopResumed: true })),
        queryResult: vi.fn(async () => ({ resultRef: 'model:queried' })),
        canRetrySafely: vi.fn(async () => true),
        retrySafe: vi.fn(async () => ({ resultRef: 'model:retried' })),
      },
    });
    await expect(handler.recover(goalPlan(operation({ status: 'prepared' })), 10))
      .resolves.toMatchObject({ status: 'recovered', reason: 'resume_live_loop' });
    expect(registry.terminalDurable).not.toHaveBeenCalled();
  });
});
