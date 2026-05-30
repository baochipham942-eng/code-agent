import { describe, expect, it } from 'vitest';
import {
  getRunTerminalAgentEventType,
  getRunTerminalPostHogEvent,
  RUN_TERMINAL_POSTHOG_EVENT,
  type RunTerminalStatus,
} from '../../../src/main/agent/runtime/runTerminalStatus';
import { POSTHOG_EVENTS } from '../../../src/shared/observability/posthog-events';

describe('run terminal status mapping', () => {
  it('keeps each runtime terminal status visible to PostHog', () => {
    const expected: Record<RunTerminalStatus, string> = {
      completed: POSTHOG_EVENTS.RUN_COMPLETED,
      failed: POSTHOG_EVENTS.RUN_FAILED,
      cancelled: POSTHOG_EVENTS.RUN_CANCELLED,
      interrupted: POSTHOG_EVENTS.RUN_INTERRUPTED,
      goal_met: POSTHOG_EVENTS.RUN_GOAL_MET,
      aborted: POSTHOG_EVENTS.RUN_ABORTED,
    };

    expect(RUN_TERMINAL_POSTHOG_EVENT).toEqual(expected);
    for (const status of Object.keys(expected) as RunTerminalStatus[]) {
      expect(getRunTerminalPostHogEvent(status)).toBe(expected[status]);
    }
  });

  it('preserves the legacy renderer terminal event while keeping status-specific analytics', () => {
    expect(getRunTerminalAgentEventType('cancelled')).toBe('agent_cancelled');
    expect(getRunTerminalAgentEventType('completed')).toBe('agent_complete');
    expect(getRunTerminalAgentEventType('failed')).toBe('agent_complete');
    expect(getRunTerminalAgentEventType('interrupted')).toBe('agent_complete');
    expect(getRunTerminalAgentEventType('goal_met')).toBe('agent_complete');
    expect(getRunTerminalAgentEventType('aborted')).toBe('agent_complete');
  });
});
