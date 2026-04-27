import { beforeEach, describe, expect, it, vi } from 'vitest';

const eventBusState = vi.hoisted(() => ({
  publish: vi.fn(),
}));

vi.mock('../../../src/main/services/eventing/bus', () => ({
  getEventBus: () => eventBusState,
}));

import { SwarmEventEmitter } from '../../../src/main/agent/swarmEventPublisher';

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
});
