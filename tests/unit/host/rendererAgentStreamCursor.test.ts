import { describe, expect, it } from 'vitest';
import { envelopeRendererAgentEvent } from '../../../src/host/protocol/rendererAgentStreamCursor';

describe('rendererAgentStreamCursor', () => {
  it('uses one process epoch and independent monotonic session watermarks', () => {
    const first = envelopeRendererAgentEvent('cursor-session-a', {
      type: 'turn_start',
      data: { turnId: 'turn-1', iteration: 1 },
    });
    const otherSession = envelopeRendererAgentEvent('cursor-session-b', {
      type: 'turn_start',
      data: { turnId: 'turn-2', iteration: 1 },
    });
    const second = envelopeRendererAgentEvent('cursor-session-a', {
      type: 'turn_end',
      data: { turnId: 'turn-1' },
    });

    expect(first.streamEpoch).toMatch(/^native:/);
    expect(otherSession.streamEpoch).toBe(first.streamEpoch);
    expect(second.streamEpoch).toBe(first.streamEpoch);
    expect(first.seq).toBe(1);
    expect(otherSession.seq).toBe(1);
    expect(second.seq).toBe(2);
  });
});
