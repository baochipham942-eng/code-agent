import { beforeEach, describe, expect, it, vi } from 'vitest';

const eventBusState = vi.hoisted(() => ({ publish: vi.fn() }));

vi.mock('../../../src/host/services/eventing/bus', () => ({
  getEventBus: () => eventBusState,
}));

import { SwarmEventEmitter } from '../../../src/host/agent/swarmEventPublisher';
import {
  createScopedSwarmMessageId,
  type SwarmRunScope,
} from '../../../src/shared/contract/swarm';

const scopeA: SwarmRunScope = {
  sessionId: 'session-a',
  runId: 'run-a',
  treeId: 'tree-a',
  parentNativeRunId: 'native-run-a',
};
const scopeB: SwarmRunScope = {
  sessionId: 'session-b',
  runId: 'run-b',
  treeId: 'tree-b',
  parentNativeRunId: 'native-run-b',
};

describe('SwarmEventEmitter', () => {
  beforeEach(() => eventBusState.publish.mockReset());

  it('stamps every direct user message from the explicit immutable run scope', () => {
    const emitter = new SwarmEventEmitter();
    emitter.userMessage(scopeA, 'agent-reviewer', '请看这段', 'message-a');

    expect(eventBusState.publish).toHaveBeenCalledWith(
      'swarm',
      'user:message',
      expect.objectContaining({
        type: 'swarm:user:message',
        ...scopeA,
        data: expect.objectContaining({
          agentId: 'agent-reviewer',
          message: expect.objectContaining({
            id: createScopedSwarmMessageId(scopeA, 'message-a'),
            from: 'user',
            to: 'agent-reviewer',
            content: '请看这段',
          }),
        }),
      }),
      { bridgeToRenderer: false, sessionId: scopeA.sessionId },
    );
  });

  it('rejects a supplied message identity from another Team scope', () => {
    const emitter = new SwarmEventEmitter();
    const foreignId = createScopedSwarmMessageId(scopeB, 'message-b');
    expect(() => emitter.agentMessage(
      scopeA,
      'agent-a',
      'agent-b',
      'cross scope',
      'coordination',
      foreignId,
    )).toThrow(/different Team run/);
    expect(eventBusState.publish).not.toHaveBeenCalled();
  });

  it('keeps interleaved events from two Teams on their original scopes', () => {
    const emitter = new SwarmEventEmitter();
    emitter.started(scopeA, 1);
    emitter.started(scopeB, 1);
    emitter.agentCompleted(scopeA, 'same-role-a', 'A done');
    emitter.agentCompleted(scopeB, 'same-role-b', 'B done');

    const events = eventBusState.publish.mock.calls.map((call) => call[2]);
    expect(events.map((event) => [event.sessionId, event.runId, event.treeId])).toEqual([
      [scopeA.sessionId, scopeA.runId, scopeA.treeId],
      [scopeB.sessionId, scopeB.runId, scopeB.treeId],
      [scopeA.sessionId, scopeA.runId, scopeA.treeId],
      [scopeB.sessionId, scopeB.runId, scopeB.treeId],
    ]);
  });

  it('publishes SharedContext updates with the explicit scope and at-derived timestamp', () => {
    const emitter = new SwarmEventEmitter();
    emitter.contextUpdate(scopeA, {
      kind: 'decision',
      agentId: 'agent_researcher_0',
      role: 'researcher',
      content: '采用方案 A：服务端聚合',
      at: 1700000000000,
    });

    expect(eventBusState.publish).toHaveBeenCalledWith(
      'swarm',
      'context:update',
      expect.objectContaining({
        type: 'swarm:context:update',
        timestamp: 1700000000000,
        ...scopeA,
        data: expect.objectContaining({
          agentId: 'agent_researcher_0',
          contextUpdate: expect.objectContaining({
            kind: 'decision',
            content: '采用方案 A：服务端聚合',
          }),
        }),
      }),
      { bridgeToRenderer: false, sessionId: scopeA.sessionId },
    );
  });
});
