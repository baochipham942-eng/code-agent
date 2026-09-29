import { beforeEach, describe, expect, it } from 'vitest';
import { envelopeRendererAgentEvent } from '../../../src/host/protocol/rendererAgentStreamCursor';
import {
  envelopeWebAgentEvent,
  getWebStreamEpoch,
  resetWebAgentEventSequencesForTests,
} from '../../../src/web/helpers/agentStreamCursor';

describe('rendererAgentStreamCursor', () => {
  beforeEach(() => {
    resetWebAgentEventSequencesForTests();
  });

  it('shares one process epoch and continues the same per-session seq as the web cursor', () => {
    const first = envelopeRendererAgentEvent('cursor-session-a', {
      type: 'turn_start',
      data: { turnId: 'turn-1', iteration: 1 },
    });
    const otherSession = envelopeRendererAgentEvent('cursor-session-b', {
      type: 'turn_start',
      data: { turnId: 'turn-2', iteration: 1 },
    });
    const second = envelopeWebAgentEvent('cursor-session-a', {
      type: 'turn_end',
      data: { turnId: 'turn-1' },
    });

    expect(first.streamEpoch).toMatch(/^http:/);
    expect(first.streamEpoch).toBe(getWebStreamEpoch());
    expect(otherSession.streamEpoch).toBe(first.streamEpoch);
    expect(second.streamEpoch).toBe(first.streamEpoch);
    expect(first.seq).toBe(1);
    expect(otherSession.seq).toBe(1);
    expect(second.seq).toBe(2);
  });
});
