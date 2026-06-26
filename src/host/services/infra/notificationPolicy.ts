// ============================================================================
// Notification Policy Gate
// ============================================================================

import { scrubUserFacingText } from '../../security/userFacingError';

export type NotificationIntent =
  | 'needs_input'
  | 'task_complete'
  | 'task_failed'
  | 'progress'
  | 'typing'
  | 'stream_delta'
  | 'tool_started'
  | 'channel_reply';

export interface NotificationPolicyDecision {
  allowed: boolean;
  reason: string;
}

const ALLOWED_SYSTEM_NOTIFICATION_INTENTS = new Set<NotificationIntent>([
  'needs_input',
  'task_complete',
  'task_failed',
]);

export function evaluateNotificationPolicy(intent: NotificationIntent): NotificationPolicyDecision {
  if (ALLOWED_SYSTEM_NOTIFICATION_INTENTS.has(intent)) {
    return { allowed: true, reason: 'User intervention or terminal task state.' };
  }
  return { allowed: false, reason: 'Progress and channel surface updates stay in their own surface.' };
}

export function sanitizeNotificationText(value: unknown, maxLength = 240): string {
  return scrubUserFacingText(value, {
    surface: 'desktop_notification',
    maxLength,
  });
}
