import { beforeEach, describe, expect, it, vi } from 'vitest';

const platformState = vi.hoisted(() => {
  const handlers = new Map<string, (event: unknown, payload?: never) => unknown>();
  return {
    handlers,
    reset() { handlers.clear(); },
  };
});

const sessionManagerState = vi.hoisted(() => ({ addMessageToSession: vi.fn() }));
const teammateState = vi.hoisted(() => ({
  onUserMessage: vi.fn(),
  getHistory: vi.fn().mockReturnValue([]),
  approvePlan: vi.fn(),
  rejectPlan: vi.fn(),
}));
const planApprovalState = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  cancelAgent: vi.fn(),
  getPlan: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));
const launchApprovalState = vi.hoisted(() => ({
  cancelRun: vi.fn(),
  approve: vi.fn(),
  reject: vi.fn(),
}));
const coordinatorA = vi.hoisted(() => ({
  getScope: vi.fn(),
  canReceiveMessage: vi.fn(),
  sendMessage: vi.fn(),
  abortTask: vi.fn(),
  getTaskDefinition: vi.fn(),
  retryTask: vi.fn(),
}));
const coordinatorB = vi.hoisted(() => ({
  getScope: vi.fn(),
  canReceiveMessage: vi.fn(),
  sendMessage: vi.fn(),
  abortTask: vi.fn(),
  getTaskDefinition: vi.fn(),
  retryTask: vi.fn(),
}));
const coordinatorRegistryState = vi.hoisted(() => ({
  getByRun: vi.fn(),
  get: vi.fn(),
  abortRun: vi.fn(),
  abortSession: vi.fn(),
}));
const spawnGuardState = vi.hoisted(() => ({
  get: vi.fn(),
  sendMessage: vi.fn(),
  cancel: vi.fn(),
  cancelRun: vi.fn(),
  cancelSession: vi.fn(),
}));
const swarmEmitterState = vi.hoisted(() => ({
  cancelled: vi.fn(),
  agentCancelled: vi.fn(),
  agentUpdated: vi.fn(),
  agentCompleted: vi.fn(),
  agentFailed: vi.fn(),
}));
const eventBusState = vi.hoisted(() => ({ subscribe: vi.fn() }));
const traceRepoState = vi.hoisted(() => ({
  listRuns: vi.fn(),
  getRunDetail: vi.fn(),
}));
const databaseState = vi.hoisted(() => ({
  getSwarmRunDetailPreferLedger: vi.fn(),
}));

vi.mock('../../../src/host/platform', () => ({
  AppWindow: { getAllWindows: () => [] },
  ipcHost: {
    handle: (channel: string, handler: (event: unknown, payload?: never) => unknown) => {
      platformState.handlers.set(channel, handler);
    },
    removeHandler: (channel: string) => platformState.handlers.delete(channel),
  },
}));

vi.mock('../../../src/host/services', () => ({ getSessionManager: () => sessionManagerState }));
vi.mock('../../../src/host/agent/swarmServices', () => ({
  getSwarmServices: () => ({
    planApproval: planApprovalState,
    launchApproval: launchApprovalState,
    parallelCoordinators: coordinatorRegistryState,
    spawnGuard: spawnGuardState,
    teammateService: teammateState,
    swarmTraceRepo: traceRepoState,
  }),
}));
vi.mock('../../../src/host/agent/swarmEventPublisher', () => ({
  getSwarmEventEmitter: () => swarmEmitterState,
}));
vi.mock('../../../src/host/services/eventing/bus', () => ({ getEventBus: () => eventBusState }));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => databaseState,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import {
  createScopedSwarmAgentId,
  createScopedSwarmMessageId,
  type SwarmRunScope,
} from '../../../src/shared/contract/swarm';
import type {
  SwarmRunDetail,
  SwarmRunListItem,
} from '../../../src/shared/contract/swarmTrace';
import { registerSwarmHandlers } from '../../../src/host/ipc/swarm.ipc';

const scopeA: SwarmRunScope = { sessionId: 'session-a', runId: 'run-a', treeId: 'tree-a' };
const scopeB: SwarmRunScope = { sessionId: 'session-b', runId: 'run-b', treeId: 'tree-b' };
const foreignTreeScope: SwarmRunScope = { ...scopeA, treeId: 'tree-foreign' };
const agentA = createScopedSwarmAgentId(scopeA, 'reviewer');
const writerA = createScopedSwarmAgentId(scopeA, 'writer');
const agentB = createScopedSwarmAgentId(scopeB, 'reviewer');
const foreignTreeAgent = createScopedSwarmAgentId(foreignTreeScope, 'reviewer');

function traceListItem(id: string, sessionId: string): SwarmRunListItem {
  return {
    id,
    sessionId,
    status: 'completed',
    coordinator: 'parallel',
    startedAt: 1,
    endedAt: 2,
    durationMs: 1,
    totalAgents: 1,
    completedCount: 1,
    failedCount: 0,
    totalCostUsd: 0,
    totalTokensIn: 1,
    totalTokensOut: 1,
    trigger: 'llm-spawn',
  };
}

function traceDetail(id: string, sessionId: string): SwarmRunDetail {
  return {
    run: {
      ...traceListItem(id, sessionId),
      parallelPeak: 1,
      totalToolCalls: 0,
      errorSummary: null,
      aggregation: null,
      tags: [],
    },
    agents: [],
    events: [],
  };
}

function handler(channel: string) {
  const registered = platformState.handlers.get(channel);
  expect(registered).toBeTypeOf('function');
  return registered!;
}

describe('swarm.ipc run-scoped control plane', () => {
  beforeEach(() => {
    platformState.reset();
    vi.clearAllMocks();

    coordinatorA.getScope.mockReturnValue(scopeA);
    coordinatorB.getScope.mockReturnValue(scopeB);
    coordinatorA.canReceiveMessage.mockReturnValue(true);
    coordinatorB.canReceiveMessage.mockReturnValue(true);
    coordinatorA.sendMessage.mockReturnValue(true);
    coordinatorB.sendMessage.mockReturnValue(true);
    coordinatorA.abortTask.mockReturnValue(false);
    coordinatorB.abortTask.mockReturnValue(false);
    coordinatorRegistryState.getByRun.mockImplementation((ref: { sessionId: string; runId: string }) => {
      if (ref.sessionId === scopeA.sessionId && ref.runId === scopeA.runId) return coordinatorA;
      if (ref.sessionId === scopeB.sessionId && ref.runId === scopeB.runId) return coordinatorB;
      return undefined;
    });
    coordinatorRegistryState.get.mockImplementation((scope: SwarmRunScope) => (
      scope.sessionId === scopeA.sessionId && scope.runId === scopeA.runId ? coordinatorA : coordinatorB
    ));
    coordinatorRegistryState.abortRun.mockReturnValue(true);
    spawnGuardState.get.mockReturnValue(undefined);
    spawnGuardState.sendMessage.mockReturnValue(false);
    spawnGuardState.cancel.mockReturnValue(false);
    planApprovalState.cancelAgent.mockReturnValue(0);
    sessionManagerState.addMessageToSession.mockResolvedValue(undefined);
    teammateState.onUserMessage.mockReturnValue({ id: 'ledger-message' });
    traceRepoState.listRuns.mockReturnValue([]);
    traceRepoState.getRunDetail.mockReturnValue(null);
    databaseState.getSwarmRunDetailPreferLedger.mockReturnValue(null);

    registerSwarmHandlers(() => null);
  });

  it('routes identical roles to the exact Team and preserves one scoped message identity', async () => {
    const result = await handler('swarm:send-user-message')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentA,
      message: '只发给 Team A reviewer',
      messageId: 'source-message-1',
      timestamp: 123456,
      metadata: { workbench: { routingMode: 'direct' } },
    } as never);

    expect(result).toEqual({ delivered: true, persisted: true });
    const stableId = createScopedSwarmMessageId(scopeA, 'conversation:source-message-1');
    const deliveryId = createScopedSwarmMessageId(
      scopeA,
      `delivery:${stableId}:${agentA}`,
    );
    expect(sessionManagerState.addMessageToSession).toHaveBeenCalledWith(scopeA.sessionId, {
      id: stableId,
      role: 'user',
      content: '只发给 Team A reviewer',
      timestamp: 123456,
      metadata: expect.objectContaining({
        agentTeam: {
          sessionId: scopeA.sessionId,
          runId: scopeA.runId,
          treeId: scopeA.treeId,
          agentId: agentA,
          targetAgentIds: [agentA],
        },
      }),
    });
    expect(coordinatorA.sendMessage).toHaveBeenCalledWith(agentA, '只发给 Team A reviewer');
    expect(coordinatorB.sendMessage).not.toHaveBeenCalled();
    expect(teammateState.onUserMessage).toHaveBeenCalledWith(
      scopeA,
      agentA,
      '只发给 Team A reviewer',
      { id: deliveryId, timestamp: 123456 },
    );
  });

  it('persists one canonical Direct turn while keeping per-target delivery identities', async () => {
    sessionManagerState.addMessageToSession
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('UNIQUE constraint failed: messages.id'));
    const metadata = {
      workbench: {
        routingMode: 'direct' as const,
        targetAgentIds: [agentA, writerA],
      },
    };

    const first = await handler('swarm:send-user-message')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentA,
      message: 'fan out once',
      messageId: 'multi-target-source',
      metadata,
    } as never);
    const second = await handler('swarm:send-user-message')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: writerA,
      message: 'fan out once',
      messageId: 'multi-target-source',
      metadata,
    } as never);

    expect(first).toEqual({ delivered: true, persisted: true });
    expect(second).toEqual({ delivered: true, persisted: true });
    const canonicalId = createScopedSwarmMessageId(scopeA, 'conversation:multi-target-source');
    expect(sessionManagerState.addMessageToSession).toHaveBeenNthCalledWith(
      1,
      scopeA.sessionId,
      expect.objectContaining({
        id: canonicalId,
        metadata: expect.objectContaining({
          agentTeam: {
            sessionId: scopeA.sessionId,
            runId: scopeA.runId,
            treeId: scopeA.treeId,
            agentId: agentA,
            targetAgentIds: [agentA, writerA],
          },
        }),
      }),
    );
    expect(sessionManagerState.addMessageToSession).toHaveBeenNthCalledWith(
      2,
      scopeA.sessionId,
      expect.objectContaining({ id: canonicalId }),
    );
    expect(teammateState.onUserMessage).toHaveBeenNthCalledWith(
      1,
      scopeA,
      agentA,
      'fan out once',
      {
        id: createScopedSwarmMessageId(scopeA, `delivery:${canonicalId}:${agentA}`),
        timestamp: expect.any(Number),
      },
    );
    expect(teammateState.onUserMessage).toHaveBeenNthCalledWith(
      2,
      scopeA,
      writerA,
      'fan out once',
      {
        id: createScopedSwarmMessageId(scopeA, `delivery:${canonicalId}:${writerA}`),
        timestamp: expect.any(Number),
      },
    );
  });

  it('treats duplicate scoped persistence as idempotent', async () => {
    sessionManagerState.addMessageToSession.mockRejectedValueOnce(
      new Error('UNIQUE constraint failed: messages.id'),
    );
    const result = await handler('swarm:send-user-message')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentA,
      message: 'retry',
      messageId: 'same-source',
    } as never);
    expect(result).toEqual({ delivered: true, persisted: true });
  });

  it('rejects a spoofed agent identity before persistence or delivery', async () => {
    const result = await handler('swarm:send-user-message')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentB,
      message: 'cross-run spoof',
    } as never);

    expect(result).toEqual({ delivered: false, persisted: false });
    expect(sessionManagerState.addMessageToSession).not.toHaveBeenCalled();
    expect(coordinatorA.sendMessage).not.toHaveBeenCalled();
    expect(coordinatorB.sendMessage).not.toHaveBeenCalled();
  });

  it('does not display/persist a phantom success for an unavailable target', async () => {
    coordinatorA.canReceiveMessage.mockReturnValue(false);
    const result = await handler('swarm:send-user-message')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentA,
      message: 'missing',
    } as never);
    expect(result).toEqual({ delivered: false, persisted: false });
    expect(sessionManagerState.addMessageToSession).not.toHaveBeenCalled();
  });

  it('does not persist when a target becomes unavailable after the precheck', async () => {
    coordinatorA.canReceiveMessage.mockReturnValue(true);
    coordinatorA.sendMessage.mockReturnValue(false);
    const result = await handler('swarm:send-user-message')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentA,
      message: 'raced with completion',
    } as never);

    expect(result).toEqual({ delivered: false, persisted: false });
    expect(coordinatorA.sendMessage).toHaveBeenCalled();
    expect(sessionManagerState.addMessageToSession).not.toHaveBeenCalled();
    expect(teammateState.onUserMessage).not.toHaveBeenCalled();
  });

  it('reports delivered:true when durable persistence fails after delivery', async () => {
    sessionManagerState.addMessageToSession.mockRejectedValueOnce(new Error('disk unavailable'));
    const result = await handler('swarm:send-user-message')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentA,
      message: 'delivered but not durable',
    } as never);

    expect(result).toEqual({ delivered: true, persisted: false });
    expect(coordinatorA.sendMessage).toHaveBeenCalled();
    expect(teammateState.onUserMessage).toHaveBeenCalled();
  });

  it('cancels only the requested run and leaves the concurrent Team untouched', async () => {
    const result = await handler('swarm:cancel-run')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
    } as never);

    expect(result).toBe(true);
    expect(planApprovalState.cancelRun).toHaveBeenCalledWith(scopeA, 'swarm_cancelled');
    expect(launchApprovalState.cancelRun).toHaveBeenCalledWith(scopeA, 'swarm_cancelled');
    expect(spawnGuardState.cancelRun).toHaveBeenCalledWith(scopeA, 'swarm_cancelled');
    expect(coordinatorRegistryState.abortRun).toHaveBeenCalledWith(scopeA, 'swarm_cancelled');
    expect(swarmEmitterState.cancelled).toHaveBeenCalledWith(scopeA);
    expect(coordinatorB.abortTask).not.toHaveBeenCalled();
  });

  it('cancels one scoped agent without touching the same role in Team B', async () => {
    planApprovalState.cancelAgent.mockReturnValueOnce(1);
    spawnGuardState.cancel.mockReturnValueOnce(true);
    coordinatorA.abortTask.mockReturnValueOnce(true);
    const result = await handler('swarm:cancel-agent')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentA,
    } as never);

    expect(result).toBe(true);
    expect(spawnGuardState.cancel).toHaveBeenCalledWith(agentA, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentA,
    });
    expect(planApprovalState.cancelAgent).toHaveBeenCalledWith({
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentA,
    }, 'user-cancel');
    expect(coordinatorA.abortTask).toHaveBeenCalledWith(agentA);
    expect(swarmEmitterState.agentCancelled).toHaveBeenCalledWith(
      scopeA,
      agentA,
      'Cancelled by user',
    );
    expect(coordinatorB.abortTask).not.toHaveBeenCalled();
  });

  it('queries conversation history with the exact target tree scope', async () => {
    teammateState.getHistory.mockReturnValueOnce([
      { id: 'a1', from: 'user', to: agentA, type: 'coordination', content: 'A', timestamp: 1 },
    ]);
    const result = await handler('swarm:get-agent-messages')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: agentA,
    } as never);
    expect(teammateState.getHistory).toHaveBeenCalledWith(
      scopeA,
      200,
    );
    expect(result).toEqual([
      { id: 'a1', from: 'user', to: agentA, content: 'A', timestamp: 1, messageType: 'coordination' },
    ]);
  });

  it('fails closed for the same session/run agent identity from a foreign tree', async () => {
    const result = await handler('swarm:get-agent-messages')({}, {
      sessionId: scopeA.sessionId,
      runId: scopeA.runId,
      agentId: foreignTreeAgent,
    } as never);

    expect(result).toEqual([]);
    expect(teammateState.getHistory).not.toHaveBeenCalled();
  });

  it('lists only the requested session without letting newer foreign runs consume the limit', async () => {
    traceRepoState.listRuns.mockReturnValueOnce([
      traceListItem('opaque-foreign-newest', scopeB.sessionId),
      traceListItem('opaque-a-newest', scopeA.sessionId),
      traceListItem('opaque-foreign-middle', scopeB.sessionId),
      traceListItem('opaque-a-older', scopeA.sessionId),
    ]);

    const result = await handler('swarm:list-trace-runs')({}, {
      sessionId: scopeA.sessionId,
      limit: 1,
    } as never);

    expect(traceRepoState.listRuns).toHaveBeenCalledWith(200);
    expect(result).toEqual([traceListItem('opaque-a-newest', scopeA.sessionId)]);
  });

  it('rejects a foreign-session trace detail while preserving the opaque storage id', async () => {
    const opaqueStorageRunId = 'opaque.storage.identity.without.parsing';
    databaseState.getSwarmRunDetailPreferLedger.mockReturnValueOnce(
      traceDetail(opaqueStorageRunId, scopeB.sessionId),
    );

    const result = await handler('swarm:get-trace-run-detail')({}, {
      sessionId: scopeA.sessionId,
      runId: opaqueStorageRunId,
    } as never);

    expect(databaseState.getSwarmRunDetailPreferLedger).toHaveBeenCalledWith(opaqueStorageRunId);
    expect(result).toBeNull();
  });

  it('applies the same session ownership check to the rollup repository fallback', async () => {
    const opaqueStorageRunId = 'opaque-fallback-id';
    databaseState.getSwarmRunDetailPreferLedger.mockImplementationOnce(() => {
      throw new Error('ledger unavailable');
    });
    traceRepoState.getRunDetail.mockReturnValueOnce(
      traceDetail(opaqueStorageRunId, scopeB.sessionId),
    );

    const result = await handler('swarm:get-trace-run-detail')({}, {
      sessionId: scopeA.sessionId,
      runId: opaqueStorageRunId,
    } as never);

    expect(traceRepoState.getRunDetail).toHaveBeenCalledWith(opaqueStorageRunId);
    expect(result).toBeNull();
  });
});
