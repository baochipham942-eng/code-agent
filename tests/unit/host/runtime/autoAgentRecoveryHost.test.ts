import { describe, expect, it, vi } from 'vitest';
import { AutoAgentRecoveryHost } from '../../../../src/host/runtime/autoAgentRecoveryHost';
import type { RunRegistry } from '../../../../src/host/runtime/runRegistry';
import type { RunRehydrationPlan } from '../../../../src/host/runtime/durableRunStores';

function plan(): RunRehydrationPlan {
  const cursor = { schemaVersion: 1 as const, runtime: 'auto_agent' as const, sourceMessageId: 'message-1', graphId: 'graph-1', workspaceFingerprint: 'fp' };
  const graphCheckpoint = {
    version: 1 as const, graphId: 'graph-1', runId: 'run-1', sessionId: 'session-1', attempt: 1,
    status: 'running' as const, eventSequence: 1,
    scheduler: { nodes: [] },
    nodes: [
      { nodeId: 'done', status: 'completed' as const, attempts: 1, result: { status: 'completed' as const, sideEffectState: 'confirmed' as const } },
      { nodeId: 'ready', status: 'ready' as const, attempts: 0 },
    ],
    createdAt: 1, updatedAt: 2,
  };
  const operation = {
    runId: 'run-1', operationId: 'auto-agent-graph', attempt: 1, kind: 'child_run' as const,
    status: 'prepared' as const, idempotencyKey: 'stable', sideEffect: false, preparedAt: 1, updatedAt: 1,
  };
  return {
    envelope: {
      schemaVersion: 1, runId: 'run-1', sessionId: 'session-1', engine: { kind: 'agent_team', treeId: 'graph-1' },
      status: 'recovering', attempt: 2, cursor: { nextEventSeq: 2, checkpointSeq: 1, engineCursor: cursor },
      owner: { ownerId: 'owner', processInstanceId: 'new', epoch: 2, leaseExpiresAt: 100 },
      pendingOperations: [operation], childRuns: [], createdAt: 1, updatedAt: 2,
    },
    previousAttempt: { runId: 'run-1', attempt: 1, processInstanceId: 'old', ownerId: 'owner', ownerEpoch: 1, status: 'lost', startedAt: 1 },
    checkpoint: {
      runId: 'run-1', checkpointSeq: 1, attempt: 1, eventSeq: 1, status: 'running',
      cursor: { nextEventSeq: 2, checkpointSeq: 1, engineCursor: cursor },
      state: { schemaVersion: 1, kind: 'auto_agent', sourceMessageId: 'message-1', workspace: { root: '/repo', cwd: '/repo', fingerprint: 'fp' }, graphCheckpoint, cancelled: false },
      checksum: 'x', createdAt: 1,
    },
    pendingOperations: [operation], childRuns: [], requiresHumanConfirmation: [],
  };
}

describe('AutoAgentRecoveryHost', () => {
  it('reuses completed nodes, deduplicates Graph terminal, and ignores subscriber failure', async () => {
    const registry = { checkpointDurable: vi.fn(), terminalDurable: vi.fn() } as unknown as RunRegistry;
    const graphSubscriber = vi.fn(() => { throw new Error('projection failed'); });
    const diagnostic = vi.fn();
    const host = new AutoAgentRecoveryHost(registry, {
      async resume({ plan: recovered, state, emit, persist }) {
        expect(state.graphCheckpoint.nodes.find((node) => node.nodeId === 'done')?.status).toBe('completed');
        const checkpoint = { ...state.graphCheckpoint, attempt: recovered.envelope.attempt, status: 'completed' as const, terminalEventType: 'graph_completed' as const, updatedAt: 10 };
        await persist(checkpoint);
        const terminal = { type: 'graph_completed' as const, graphId: 'graph-1', runId: 'run-1', sessionId: 'session-1', attempt: 2, sequence: 2, timestamp: 10, graphStatus: 'completed' as const };
        await emit(terminal);
        await emit(terminal);
        return { status: 'completed' as const, checkpoint, results: {} };
      },
    }, { graph: graphSubscriber, diagnostic });
    await expect(host.createHandler().recover(plan(), 10)).resolves.toMatchObject({ status: 'recovered' });
    expect(graphSubscriber).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledOnce();
    expect(registry.terminalDurable).toHaveBeenCalledOnce();
  });
});
