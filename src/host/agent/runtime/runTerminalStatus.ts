import { POSTHOG_EVENTS, type PostHogEvent } from '../../../shared/observability/posthog-events';

export type RunTerminalStatus = 'completed' | 'cancelled' | 'interrupted' | 'failed' | 'goal_met' | 'aborted';

export interface RunTerminalInfo {
  status?: RunTerminalStatus;
  error?: unknown;
}

export const RUN_TERMINAL_POSTHOG_EVENT: Record<RunTerminalStatus, PostHogEvent> = {
  completed: POSTHOG_EVENTS.RUN_COMPLETED,
  failed: POSTHOG_EVENTS.RUN_FAILED,
  cancelled: POSTHOG_EVENTS.RUN_CANCELLED,
  interrupted: POSTHOG_EVENTS.RUN_INTERRUPTED,
  goal_met: POSTHOG_EVENTS.RUN_GOAL_MET,
  aborted: POSTHOG_EVENTS.RUN_ABORTED,
};

export function getRunTerminalPostHogEvent(status: RunTerminalStatus): PostHogEvent {
  return RUN_TERMINAL_POSTHOG_EVENT[status];
}

export function getRunTerminalAgentEventType(status: RunTerminalStatus): 'agent_complete' | 'agent_cancelled' {
  return status === 'cancelled' ? 'agent_cancelled' : 'agent_complete';
}
