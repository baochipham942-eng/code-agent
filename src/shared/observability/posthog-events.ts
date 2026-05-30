// PostHog 事件名常量 — renderer / node 共用，避免事件名分歧。
export const POSTHOG_EVENTS = {
  APP_OPENED: 'app_opened',
  SESSION_STARTED: 'session_started',
  RUN_COMPLETED: 'run_completed',
  RUN_FAILED: 'run_failed',
  RUN_CANCELLED: 'run_cancelled',
  RUN_INTERRUPTED: 'run_interrupted',
  RUN_ABORTED: 'run_aborted',
  RUN_GOAL_MET: 'run_goal_met',
  TOOL_USED: 'tool_used',
  MODEL_SELECTED: 'model_selected',
} as const;

export type PostHogEvent = (typeof POSTHOG_EVENTS)[keyof typeof POSTHOG_EVENTS];
