import { afterEach, describe, expect, it, vi } from 'vitest';

import { SwarmTraceWriter } from '../../../src/host/agent/swarmTraceWriter';
import { getEventBus, shutdownEventBus } from '../../../src/host/services/eventing/bus';
import type { SwarmEvent, SwarmExecutionState } from '../../../src/shared/contract/swarm';
import type { SwarmTraceRepo } from '../../../src/shared/contract/swarmTrace';

function stats(total: number): SwarmExecutionState['statistics'] {
  return {
    total,
    completed: 0,
    failed: 0,
    running: 0,
    pending: total,
    parallelPeak: 0,
    totalTokens: 0,
    totalToolCalls: 0,
  };
}

function publish(event: SwarmEvent, busSessionId = event.sessionId): void {
  getEventBus().publish('swarm', event.type.slice('swarm:'.length), event, {
    sessionId: busSessionId,
    bridgeToRenderer: false,
  });
}

describe('SwarmTraceWriter strict run scope', () => {
  afterEach(() => {
    shutdownEventBus();
  });

  it('keeps same runId in different sessions active independently and rejects foreign scope', async () => {
    const startRun = vi.fn();
    const closeRun = vi.fn();
    const upsertAgent = vi.fn();
    const appendEvent = vi.fn();
    const repo: SwarmTraceRepo = {
      startRun,
      closeRun,
      upsertAgent,
      appendEvent,
      listRuns: () => [],
      getRunDetail: () => null,
      replaceRunCache: () => {},
      deleteRun: () => false,
      clearAll: () => {},
    };
    const writer = new SwarmTraceWriter(repo);
    writer.install();

    const startedA: SwarmEvent = {
      type: 'swarm:started',
      sessionId: 'session-a',
      runId: 'same-run',
      treeId: 'tree-a',
      timestamp: 1,
      data: { statistics: stats(1) },
    };
    const startedB: SwarmEvent = {
      ...startedA,
      sessionId: 'session-b',
      treeId: 'tree-b',
      timestamp: 2,
    };
    publish(startedA);
    publish(startedB);
    publish({
      type: 'swarm:agent:added',
      sessionId: 'session-a',
      runId: 'same-run',
      treeId: 'tree-a',
      timestamp: 3,
      data: {
        agentId: 'agent-a',
        agentState: { id: 'agent-a', name: 'A', role: 'reviewer', status: 'running', iterations: 0 },
      },
    });
    publish({
      type: 'swarm:completed',
      sessionId: 'session-a',
      runId: 'same-run',
      treeId: 'tree-a',
      timestamp: 4,
      data: { statistics: { ...stats(1), completed: 1, pending: 0 } },
    });
    // B must remain active after A closes despite sharing the raw runId.
    publish({
      type: 'swarm:agent:added',
      sessionId: 'session-b',
      runId: 'same-run',
      treeId: 'tree-b',
      timestamp: 5,
      data: {
        agentId: 'agent-b',
        agentState: { id: 'agent-b', name: 'B', role: 'reviewer', status: 'running', iterations: 0 },
      },
    });
    // Same session/run with a foreign tree must be ignored.
    publish({
      type: 'swarm:agent:added',
      sessionId: 'session-b',
      runId: 'same-run',
      treeId: 'foreign-tree',
      timestamp: 6,
      data: {
        agentId: 'foreign',
        agentState: { id: 'foreign', name: 'X', role: 'reviewer', status: 'running', iterations: 0 },
      },
    });
    // The Bus envelope is part of the scope boundary too.
    publish({
      type: 'swarm:agent:added',
      sessionId: 'session-b',
      runId: 'same-run',
      treeId: 'tree-b',
      timestamp: 7,
      data: {
        agentId: 'spoofed',
        agentState: { id: 'spoofed', name: 'Y', role: 'reviewer', status: 'running', iterations: 0 },
      },
    }, 'session-a');

    await writer.drain();
    expect(startRun).toHaveBeenCalledTimes(2);
    expect(upsertAgent.mock.calls.map(([input]) => input.agentId)).toEqual(['agent-a', 'agent-b']);
    expect(closeRun).toHaveBeenCalledTimes(1);
    expect(appendEvent.mock.calls.some(([input]) => input.agentId === 'foreign')).toBe(false);
    expect(appendEvent.mock.calls.some(([input]) => input.agentId === 'spoofed')).toBe(false);
    await writer.dispose();
  });

  it('does not attach a runtime-cast event with missing scope to the only active run', async () => {
    const appendEvent = vi.fn();
    const repo = {
      startRun: vi.fn(), closeRun: vi.fn(), upsertAgent: vi.fn(), appendEvent,
      listRuns: () => [], getRunDetail: () => null, replaceRunCache: () => {},
      deleteRun: () => false, clearAll: () => {},
    } satisfies SwarmTraceRepo;
    const writer = new SwarmTraceWriter(repo);
    writer.install();
    publish({
      type: 'swarm:started', sessionId: 'session-a', runId: 'run-a', treeId: 'tree-a',
      timestamp: 1, data: { statistics: stats(1) },
    });
    getEventBus().publish('swarm', 'agent:message', {
      type: 'swarm:agent:message',
      timestamp: 2,
      data: { message: { id: 'legacy', from: 'a', to: 'b', content: 'legacy' } },
    } as SwarmEvent, { bridgeToRenderer: false });
    await writer.drain();

    expect(appendEvent.mock.calls.some(([input]) => input.timestamp === 2)).toBe(false);
    await writer.dispose();
  });
});
