import { beforeEach, describe, expect, it, vi } from 'vitest';

const eventBusState = vi.hoisted(() => ({
  publish: vi.fn(),
}));

vi.mock('../../../src/host/services/eventing/bus', () => ({
  getEventBus: () => eventBusState,
}));

import { SwarmEventEmitter } from '../../../src/host/agent/swarmEventPublisher';

describe('SwarmEventEmitter', () => {
  beforeEach(() => {
    eventBusState.publish.mockReset();
  });

  it('stamps direct user messages with the active runId and provided sessionId', () => {
    const emitter = new SwarmEventEmitter();

    emitter.started(1, 'session-1');
    const runId = emitter.getCurrentRunId();
    expect(runId).toBeTruthy();

    eventBusState.publish.mockClear();
    emitter.userMessage('agent-reviewer', '请看这段', { sessionId: 'session-1' });

    expect(eventBusState.publish).toHaveBeenCalledWith(
      'swarm',
      'user:message',
      expect.objectContaining({
        type: 'swarm:user:message',
        sessionId: 'session-1',
        runId,
        data: expect.objectContaining({
          agentId: 'agent-reviewer',
          message: expect.objectContaining({
            from: 'user',
            to: 'agent-reviewer',
            content: '请看这段',
          }),
        }),
      }),
      { bridgeToRenderer: false },
    );
  });

  it('publishes SharedContext updates as swarm:context:update with the update payload and at-derived timestamp', () => {
    const emitter = new SwarmEventEmitter();
    emitter.started(2, 'session-ctx');
    const runId = emitter.getCurrentRunId();
    eventBusState.publish.mockClear();

    emitter.contextUpdate({
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
        // timestamp 必须复用 update.at（SharedContext 版本戳），保证讨论流时序对齐数据新鲜度
        timestamp: 1700000000000,
        runId,
        sessionId: 'session-ctx',
        data: expect.objectContaining({
          agentId: 'agent_researcher_0',
          contextUpdate: expect.objectContaining({
            kind: 'decision',
            role: 'researcher',
            content: '采用方案 A：服务端聚合',
            at: 1700000000000,
          }),
        }),
      }),
      { bridgeToRenderer: false },
    );
  });
});
