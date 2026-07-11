import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  PendingOperation,
  RunAttempt,
  RunCheckpoint,
  RunEnvelope,
  RunOwnerLease,
} from '../../../src/shared/contract/durableRun';
import type { RunKernelAdapter } from '../../../src/host/runtime/durableRunKernel';
import type { RunRehydrationPlan } from '../../../src/host/runtime/durableRunStores';
import {
  AgentTeamDurableRuntime,
  configureAgentTeamDurableRuntime,
  getAgentTeamDurableRuntime,
  stableAgentTeamApprovalId,
  stableAgentTeamRunId,
} from '../../../src/host/agent/agentTeamDurableAdapter';
import {
  buildAgentTeamRecoveryDecision,
  canRecoverAgentTeam,
  rehydrateAgentTeam,
} from '../../../src/host/agent/agentTeamRecovery';
import {
  AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION,
  type AgentTeamCheckpointState,
  type AgentTeamDurableParentHost,
} from '../../../src/host/agent/agentTeamDurableTypes';
import { ParallelAgentCoordinator } from '../../../src/host/agent/parallelAgentCoordinator';
import {
  createRunTraceContext,
  withRunTraceContext,
} from '../../../src/host/telemetry/runTraceContext';
import { RunRegistry } from '../../../src/host/runtime/runRegistry';

const scope = {
  sessionId: 'session-a',
  runId: stableAgentTeamRunId('native-a', 'tool-call-a'),
  treeId: stableAgentTeamRunId('native-a', 'tool-call-a'),
  parentNativeRunId: 'native-a',
};

function node(overrides: Partial<AgentTeamCheckpointState['taskGraph'][number]> = {}): AgentTeamCheckpointState['taskGraph'][number] {
  return {
    id: 'node-a',
    role: 'explore',
    task: 'inspect',
    dependsOn: [],
    tools: ['Read'],
    permissionProfile: 'readonly',
    sideEffect: false,
    status: 'dispatched',
    operationId: 'node:node-a',
    artifactRefs: [],
    ...overrides,
  };
}

function state(overrides: Partial<AgentTeamCheckpointState> = {}): AgentTeamCheckpointState {
  return {
    schemaVersion: AGENT_TEAM_CHECKPOINT_SCHEMA_VERSION,
    kind: 'agent_team',
    teamId: scope.runId,
    treeId: scope.treeId,
    scope,
    parentRunId: 'native-a',
    taskGraph: [node()],
    mailbox: { nextSeq: 1, committedCursor: 0, pending: [], consumedMessageIds: [] },
    findings: {},
    decisions: {},
    errors: [],
    completedNodeResultRefs: {},
    runningChildRefs: ['node-a'],
    pendingApprovalRefs: [],
    worktreeRefs: {},
    artifactRefs: {},
    cancelled: false,
    updatedAt: 100,
    ...overrides,
  };
}

function operation(overrides: Partial<PendingOperation> = {}): PendingOperation {
  return {
    runId: scope.runId,
    operationId: 'node:node-a',
    attempt: 2,
    kind: 'child_run',
    status: 'dispatched',
    idempotencyKey: 'stable-node-a',
    sideEffect: false,
    preparedAt: 10,
    updatedAt: 20,
    ...overrides,
  };
}

function plan(checkpointState: unknown, overrides: Partial<RunRehydrationPlan> = {}): RunRehydrationPlan {
  const owner: RunOwnerLease = { ownerId: 'new', processInstanceId: 'p2', epoch: 2, leaseExpiresAt: 999 };
  const envelope: RunEnvelope = {
    schemaVersion: 1,
    runId: scope.runId,
    sessionId: scope.sessionId,
    engine: { kind: 'agent_team', treeId: scope.treeId },
    status: 'recovering',
    attempt: 2,
    cursor: { nextEventSeq: 3, checkpointSeq: 1 },
    owner,
    parentRunId: 'native-a',
    pendingOperations: [operation()],
    childRuns: [],
    createdAt: 1,
    updatedAt: 100,
  };
  const checkpoint: RunCheckpoint = {
    runId: scope.runId,
    checkpointSeq: 1,
    attempt: 1,
    eventSeq: 2,
    status: 'running',
    cursor: { nextEventSeq: 3, checkpointSeq: 1 },
    state: checkpointState,
    checksum: 'x',
    createdAt: 100,
  };
  return {
    envelope,
    previousAttempt: {
      runId: scope.runId,
      attempt: 1,
      processInstanceId: 'p1',
      ownerId: 'old',
      ownerEpoch: 1,
      status: 'lost',
      startedAt: 1,
    },
    checkpoint,
    pendingOperations: [operation()],
    childRuns: [],
    requiresHumanConfirmation: [],
    ...overrides,
  };
}

describe('Agent Team recovery decision matrix', () => {
  it('reuses a completed child and does not schedule it again', () => {
    const completed = node({
      status: 'completed',
      resultRef: 'result://node-a',
      result: {
        success: true,
        output: 'done',
        toolsUsed: ['Read'],
        iterations: 1,
        taskId: 'node-a',
        role: 'explore',
        startTime: 1,
        endTime: 2,
        duration: 1,
      },
    });
    const decision = buildAgentTeamRecoveryDecision(plan(state({ taskGraph: [completed], runningChildRefs: [] })));
    expect(decision.nodes[0]).toMatchObject({ classification: 'reuse_completed', resultRef: 'result://node-a' });
    expect(decision.classification).toBe('reuse_completed');
  });

  it('retries a running read-only child safely', () => {
    expect(buildAgentTeamRecoveryDecision(plan(state())).nodes[0].classification).toBe('retry_safe');
  });

  it('requires review for an uncertain write child', () => {
    const write = node({ tools: ['Write'], permissionProfile: 'write', sideEffect: true });
    const p = plan(state({ taskGraph: [write] }), {
      pendingOperations: [operation({ sideEffect: true, requiresHumanConfirmation: true, status: 'unknown' })],
    });
    expect(buildAgentTeamRecoveryDecision(p).nodes[0].classification).toBe('requires_review');
  });

  it('allows provider lookup/dedup recovery for an uncertain side effect', () => {
    const write = node({ tools: ['Write'], permissionProfile: 'write', sideEffect: true });
    const p = plan(state({ taskGraph: [write] }), {
      pendingOperations: [operation({ sideEffect: true, providerOperationId: 'provider-1', requiresHumanConfirmation: false })],
    });
    expect(buildAgentTeamRecoveryDecision(p).nodes[0].classification).toBe('retry_safe');
  });

  it('preserves the same waiting approval after restart', () => {
    const approvalId = stableAgentTeamApprovalId(scope.runId);
    const decision = buildAgentTeamRecoveryDecision(plan(state({
      pendingApprovalRefs: [{ approvalId, operationId: `approval:${approvalId}`, status: 'waiting' }],
    })));
    expect(decision.classification).toBe('waiting_for_approval');
    expect(decision.nodes[0].reason).toContain(approvalId);
  });

  it('cancels every child when the parent checkpoint is cancelled', () => {
    const decision = buildAgentTeamRecoveryDecision(plan(state({ cancelled: true })));
    expect(decision.classification).toBe('cancelled');
    expect(decision.nodes.every((entry) => entry.classification === 'cancelled')).toBe(true);
  });

  it('surfaces orphan children instead of continuing silently', () => {
    const decision = buildAgentTeamRecoveryDecision(plan(state({ runningChildRefs: ['node-a', 'orphan-x'] })));
    expect(decision.orphanChildRefs).toEqual(['orphan-x']);
    expect(decision.classification).toBe('requires_review');
  });

  it('fails closed when the checkpoint schema is absent', () => {
    const p = plan(null);
    expect(canRecoverAgentTeam(p)).toBe(false);
    expect(buildAgentTeamRecoveryDecision(p).classification).toBe('requires_review');
  });

  it('rehydrates completed results into a run-scoped coordinator', async () => {
    const completed = node({
      status: 'completed',
      resultRef: 'result://node-a',
      result: { success: true, output: 'cached', toolsUsed: [], iterations: 1, taskId: 'node-a', role: 'explore', startTime: 1, endTime: 2, duration: 1 },
    });
    const p = plan(state({ taskGraph: [completed], runningChildRefs: [] }));
    const result = await rehydrateAgentTeam(p, {
      createCoordinator: (checkpoint) => new ParallelAgentCoordinator({}, checkpoint.scope),
    });
    expect(result.coordinator?.getCompletedTasks()).toHaveLength(1);
    expect(result.coordinator?.getCompletedTasks()[0].output).toBe('cached');
    expect(result.coordinator?.acceptsDurableOwnerEpoch(2)).toBe(true);
    expect(result.coordinator?.acceptsDurableOwnerEpoch(1)).toBe(false);
  });
});

function fakeKernel(currentEpoch: { value: number } = { value: 1 }): RunKernelAdapter {
  const owner: RunOwnerLease = { ownerId: 'team-owner', processInstanceId: 'team-process', epoch: 1, leaseExpiresAt: 1000 };
  const attempt: RunAttempt = {
    runId: scope.runId,
    attempt: 1,
    processInstanceId: owner.processInstanceId,
    ownerId: owner.ownerId,
    ownerEpoch: owner.epoch,
    status: 'active',
    startedAt: 1,
  };
  let checkpointSeq = 0;
  return {
    createRun: vi.fn(async (input) => ({
      owner,
      attempt: { ...attempt, runId: input.runId },
      envelope: {
        schemaVersion: 1,
        runId: input.runId,
        sessionId: input.sessionId,
        engine: input.engine,
        status: input.initialStatus ?? 'running',
        attempt: 1,
        cursor: { nextEventSeq: 1, checkpointSeq: 0, engineCursor: input.initialEngineCursor },
        owner,
        parentRunId: input.parentRunId,
        pendingOperations: input.initialPendingOperations ?? [],
        childRuns: input.initialChildRuns ?? [],
        createdAt: input.now,
        updatedAt: input.now,
      },
    })),
    createNativeRun: vi.fn(),
    heartbeat: vi.fn(async () => owner),
    checkpoint: vi.fn(async (input) => {
      if (input.owner.epoch !== currentEpoch.value) throw new Error('fenced stale owner');
      checkpointSeq += 1;
      return {
        runId: input.runId,
        checkpointSeq,
        attempt: input.attempt,
        eventSeq: checkpointSeq,
        status: input.status,
        cursor: { nextEventSeq: checkpointSeq + 1, checkpointSeq, engineCursor: input.engineCursor },
        state: input.state,
        checksum: 'checksum',
        createdAt: input.now,
      };
    }),
    terminal: vi.fn(async (input) => ({
      schemaVersion: 1,
      runId: input.runId,
      sessionId: scope.sessionId,
      engine: { kind: 'agent_team', treeId: scope.treeId },
      status: input.status,
      attempt: 1,
      cursor: { nextEventSeq: 2, checkpointSeq },
      terminal: { status: input.status, eventSeq: 1, at: input.now },
      createdAt: 1,
      updatedAt: input.now,
    })),
    release: vi.fn(async () => true),
    recoverOnStartup: vi.fn(async () => []),
    prepareOperation: vi.fn((input) => ({
      runId: input.runId,
      operationId: input.operationId,
      attempt: input.attempt,
      kind: input.kind,
      status: 'prepared',
      idempotencyKey: `stable:${input.logicalOperationId ?? input.operationId}`,
      sideEffect: input.sideEffect,
      requiresHumanConfirmation: input.requiresHumanConfirmation || (input.sideEffect && !input.canDeduplicate),
      providerOperationId: input.providerOperationId,
      preparedAt: input.now,
      updatedAt: input.now,
    })),
    prepareToolOperation: vi.fn(),
  } as RunKernelAdapter;
}

describe('Agent Team durable adapter', () => {
  let parentHost: AgentTeamDurableParentHost;

  beforeEach(() => {
    configureAgentTeamDurableRuntime(null);
    parentHost = {
      prepareAgentTeamChild: vi.fn(async () => undefined),
      projectAgentTeamChildTerminal: vi.fn(async () => undefined),
    };
  });

  it('persists parent preparation and the Team checkpoint before dispatch', async () => {
    const kernel = fakeKernel();
    const runtime = new AgentTeamDurableRuntime(kernel, parentHost);
    const controller = await runtime.start({
      scope,
      parentRunId: 'native-a',
      logicalOperationId: 'tool-call-a',
      sideEffect: false,
      tasks: [{ id: 'node-a', role: 'explore', task: 'inspect', tools: ['Read'] }],
      now: 10,
    });
    expect(parentHost.prepareAgentTeamChild).toHaveBeenCalledTimes(1);
    expect(kernel.createRun).toHaveBeenCalledWith(expect.objectContaining({
      runId: scope.runId,
      engine: { kind: 'agent_team', treeId: scope.treeId },
      parentRunId: 'native-a',
    }));
    expect(kernel.checkpoint).toHaveBeenCalledTimes(1);
    expect(controller.getState().taskGraph[0].status).toBe('prepared');
  });

  it('projects the stable Team child and terminal result onto the Native parent', async () => {
    const kernel = fakeKernel();
    const nativeOwner: RunOwnerLease = { ownerId: 'native-owner', processInstanceId: 'native-process', epoch: 1, leaseExpiresAt: 1000 };
    vi.mocked(kernel.createNativeRun).mockResolvedValue({
      owner: nativeOwner,
      attempt: {
        runId: 'native-a', attempt: 1, processInstanceId: nativeOwner.processInstanceId, ownerId: nativeOwner.ownerId, ownerEpoch: 1, status: 'active', startedAt: 1,
      },
      envelope: {
        schemaVersion: 1,
        runId: 'native-a',
        sessionId: 'session-a',
        engine: { kind: 'native' },
        status: 'running',
        attempt: 1,
        cursor: { nextEventSeq: 1, checkpointSeq: 0 },
        owner: nativeOwner,
        pendingOperations: [],
        childRuns: [],
        createdAt: 1,
        updatedAt: 1,
      },
    });
    const registry = new RunRegistry();
    registry.configureDurableKernel(kernel);
    await registry.startDurable({ runId: 'native-a', sessionId: 'session-a', workspace: '/repo' }, 1);
    await registry.checkpointDurable('native-a', {
      now: 1,
      status: 'running',
      state: { nativeCursor: 'preserve-me' },
      pendingOperations: [],
      childRuns: [],
      events: [{ type: 'native_checkpoint', payload: {}, recordedAt: 1 }],
    });
    await registry.prepareAgentTeamChild({
      parentRunId: 'native-a', teamRunId: scope.runId, treeId: scope.treeId, logicalOperationId: 'tool-call-a', sideEffect: false, now: 2,
    });
    const prepared = vi.mocked(kernel.checkpoint).mock.calls.at(-1)?.[0];
    expect(prepared?.pendingOperations).toEqual([expect.objectContaining({ kind: 'child_run', status: 'prepared' })]);
    expect(prepared?.childRuns).toEqual([expect.objectContaining({ childRunId: scope.runId, status: 'created' })]);
    expect(prepared?.state).toMatchObject({ nativeState: { nativeCursor: 'preserve-me' } });

    await registry.projectAgentTeamChildTerminal({
      parentRunId: 'native-a', teamRunId: scope.runId, status: 'completed', resultRef: 'agent-team:done', now: 3,
    });
    const completed = vi.mocked(kernel.checkpoint).mock.calls.at(-1)?.[0];
    expect(completed?.pendingOperations).toEqual([expect.objectContaining({ status: 'succeeded', resultRef: 'agent-team:done' })]);
    expect(completed?.childRuns).toEqual([expect.objectContaining({ childRunId: scope.runId, status: 'completed', terminalAt: 3 })]);
    registry.clear();
  });

  it('recovers mailbox cursor monotonically and deduplicates by message id', async () => {
    const runtime = new AgentTeamDurableRuntime(fakeKernel(), parentHost);
    const controller = await runtime.start({
      scope,
      parentRunId: 'native-a',
      logicalOperationId: 'tool-call-a',
      sideEffect: false,
      tasks: [{ id: 'node-a', role: 'explore', task: 'inspect', tools: ['Read'] }],
      now: 10,
    });
    const first = await controller.enqueueMessage('node-a', 'one', 'parent', 'text', 11);
    const second = await controller.enqueueMessage('node-a', 'two', 'parent', 'text', 12);
    expect([first.seq, second.seq]).toEqual([1, 2]);
    expect((await controller.consumeMessages('node-a')).map((message) => message.id)).toEqual([first.id, second.id]);
    expect(await controller.consumeMessages('node-a')).toEqual([]);
    expect(controller.getState().mailbox.committedCursor).toBe(2);
    const eventPayloads = vi.mocked((runtime as unknown as { kernel: RunKernelAdapter }).kernel.checkpoint)
      .mock.calls.map(([input]) => JSON.stringify(input.events));
    expect(eventPayloads.some((payload) => payload.includes('one') || payload.includes('two'))).toBe(false);
  });

  it('keeps different trees from sharing mailbox messages', async () => {
    const runtime = new AgentTeamDurableRuntime(fakeKernel(), parentHost);
    const controller = await runtime.start({
      scope,
      parentRunId: 'native-a',
      logicalOperationId: 'tool-call-a',
      sideEffect: false,
      tasks: [{ id: 'node-a', role: 'explore', task: 'inspect', tools: ['Read'] }],
      now: 10,
    });
    await controller.enqueueMessage('node-a', 'tree-a');
    const restored = controller.getState();
    restored.mailbox.pending.push({
      id: 'other:mail:1', seq: 99, treeId: 'other-tree', agentId: 'node-a', from: 'x', type: 'text', body: 'wrong', createdAt: 1,
    });
    expect((await controller.consumeMessages('node-a')).map((message) => message.body)).toEqual(['tree-a']);
  });

  it('rejects a stale child terminal/checkpoint after owner epoch takeover', async () => {
    const epoch = { value: 1 };
    const runtime = new AgentTeamDurableRuntime(fakeKernel(epoch), parentHost);
    const controller = await runtime.start({
      scope,
      parentRunId: 'native-a',
      logicalOperationId: 'tool-call-a',
      sideEffect: false,
      tasks: [{ id: 'node-a', role: 'explore', task: 'inspect', tools: ['Read'] }],
      now: 10,
    });
    epoch.value = 2;
    await expect(controller.markNodeDispatched({ id: 'node-a', role: 'explore', task: 'inspect', tools: ['Read'] }, 20))
      .rejects.toThrow('fenced stale owner');
  });

  it('links Team and child trace identity to the Native parent without recording message bodies', async () => {
    const parent = createRunTraceContext({
      runId: 'native-a', sessionId: 'session-a', attempt: 1, ownerEpoch: 1, engine: 'native', workspace: '/repo', processInstanceId: 'native-process',
    });
    const runtime = new AgentTeamDurableRuntime(fakeKernel(), parentHost);
    const controller = await withRunTraceContext(parent, () => runtime.start({
      scope,
      parentRunId: 'native-a',
      logicalOperationId: 'tool-call-a',
      sideEffect: false,
      tasks: [{ id: 'node-a', role: 'explore', task: 'inspect', tools: ['Read'] }],
      now: 10,
    }));
    expect(controller.traceContext).toMatchObject({
      traceId: parent.traceId,
      runId: scope.runId,
      parentRunId: 'native-a',
      engine: 'agent_team',
      ownerEpoch: 1,
    });
  });

  it('fails closed when no Durable runtime/store is configured', () => {
    configureAgentTeamDurableRuntime(null);
    expect(() => getAgentTeamDurableRuntime()).toThrow('persistence is unavailable');
  });
});
