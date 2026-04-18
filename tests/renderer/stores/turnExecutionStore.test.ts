import { beforeEach, describe, expect, it } from 'vitest';
import { useTurnExecutionStore } from '../../../src/renderer/stores/turnExecutionStore';

describe('turnExecutionStore', () => {
  beforeEach(() => {
    useTurnExecutionStore.getState().reset();
  });

  it('stores direct and auto routing evidence per session', () => {
    const store = useTurnExecutionStore.getState();

    store.recordRoutingEvidence('session-1', {
      kind: 'direct',
      mode: 'direct',
      timestamp: 100,
      turnMessageId: 'user-1',
      targetAgentIds: ['agent-reviewer'],
      targetAgentNames: ['reviewer'],
      deliveredTargetIds: ['agent-reviewer'],
      missingTargetIds: [],
    });
    store.recordRoutingEvidence('session-1', {
      kind: 'auto',
      mode: 'auto',
      timestamp: 120,
      agentId: 'default',
      agentName: 'default',
      reason: 'fallback',
      score: 0,
      fallbackToDefault: true,
    });

    expect(useTurnExecutionStore.getState().routingEventsBySession['session-1']).toEqual([
      expect.objectContaining({
        kind: 'direct',
        turnMessageId: 'user-1',
      }),
      expect.objectContaining({
        kind: 'auto',
        agentName: 'default',
        fallbackToDefault: true,
      }),
    ]);
  });
});
