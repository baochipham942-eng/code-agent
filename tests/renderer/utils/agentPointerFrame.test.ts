import { describe, expect, it } from 'vitest';
import type { AgentPointerEvent } from '../../../src/shared/contract';
import { resolveAgentPointerFramePosition } from '../../../src/renderer/utils/agentPointerFrame';

const baseEvent: AgentPointerEvent = {
  id: 'pointer-frame-test',
  surface: 'computer',
  tone: 'computer',
  phase: 'click',
  coordSpace: 'surfacePreview',
  point: { x: 50, y: 25, unit: 'percent' },
  targetSource: 'fallback',
  success: true,
};

describe('agentPointerFrame', () => {
  it('maps percent pointer coordinates into PiP frame pixels', () => {
    expect(resolveAgentPointerFramePosition(baseEvent, 800, 600)).toEqual({
      x: 400,
      y: 150,
    });
  });

  it('clamps pixel coordinates inside the frame margin', () => {
    const position = resolveAgentPointerFramePosition({
      ...baseEvent,
      point: { x: -200, y: 9999, unit: 'px' },
    }, 320, 240);

    expect(position?.x).toBeGreaterThan(0);
    expect(position?.y).toBeLessThan(240);
  });

  it('returns null when there is no pointer point', () => {
    expect(resolveAgentPointerFramePosition({
      ...baseEvent,
      point: null,
    }, 320, 240)).toBeNull();
  });
});
