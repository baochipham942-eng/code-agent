import { afterEach, describe, expect, it } from 'vitest';
import type { AgentPointerEvent } from '../../../src/shared/contract';
import { isAgentPointerEvent, useAgentPointerStore } from '../../../src/renderer/stores/agentPointerStore';

const browserEvent: AgentPointerEvent = {
  id: 'browser-pointer',
  surface: 'browser',
  tone: 'browser',
  phase: 'click',
  coordSpace: 'browserViewport',
  point: { x: 120, y: 80, unit: 'px' },
  targetSource: 'selector',
  success: true,
};

const computerEvent: AgentPointerEvent = {
  id: 'computer-pointer',
  surface: 'computer',
  tone: 'computer',
  phase: 'move',
  coordSpace: 'screen',
  point: { x: 400, y: 240, unit: 'px' },
  targetSource: 'coordinate',
  success: null,
};

describe('agentPointerStore', () => {
  afterEach(() => {
    useAgentPointerStore.getState().clearAll();
  });

  it('records the latest pointer per surface and keeps a timeline', () => {
    useAgentPointerStore.getState().recordEvent(browserEvent);
    useAgentPointerStore.getState().recordEvent(computerEvent);

    const state = useAgentPointerStore.getState();
    expect(state.lastBySurface.browser?.event.id).toBe('browser-pointer');
    expect(state.lastBySurface.computer?.event.id).toBe('computer-pointer');
    expect(state.lastBySurface.browser?.visibleUntilMs).toBeGreaterThan(state.lastBySurface.browser?.receivedAtMs || 0);
    expect(state.timeline.map((entry) => entry.event.id)).toEqual([
      'browser-pointer',
      'computer-pointer',
    ]);
  });

  it('prunes expired surface pointers while keeping timeline history', () => {
    useAgentPointerStore.getState().recordEvent({
      ...browserEvent,
      expiresAtMs: 10,
    });

    useAgentPointerStore.getState().pruneExpired(11);
    const state = useAgentPointerStore.getState();

    expect(state.lastBySurface.browser).toBeNull();
    expect(state.timeline).toHaveLength(1);
    expect(state.timeline[0].event.id).toBe('browser-pointer');
  });

  it('guards runtime metadata before putting it in the live store', () => {
    expect(isAgentPointerEvent(browserEvent)).toBe(true);
    expect(isAgentPointerEvent({ ...browserEvent, point: { x: 'bad', y: 1, unit: 'px' } })).toBe(false);
  });
});
