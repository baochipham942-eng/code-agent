import { describe, expect, it } from 'vitest';
import {
  evaluateNotificationPolicy,
  sanitizeNotificationText,
  type NotificationIntent,
} from '../../../src/main/services/infra/notificationPolicy';

describe('notification policy gate', () => {
  it('only allows terminal or user-intervention intents into system notifications', () => {
    const allowed: NotificationIntent[] = ['needs_input', 'task_complete', 'task_failed'];
    const blocked: NotificationIntent[] = ['progress', 'typing', 'stream_delta', 'tool_started', 'channel_reply'];

    for (const intent of allowed) {
      expect(evaluateNotificationPolicy(intent).allowed).toBe(true);
    }
    for (const intent of blocked) {
      expect(evaluateNotificationPolicy(intent).allowed).toBe(false);
    }
  });

  it('scrubs notification body text', () => {
    const body = sanitizeNotificationText('failed with sk-proj-' + 'a'.repeat(48) + ' at /Users/linchen/app.ts');
    expect(body).not.toContain('sk-proj-');
    expect(body).not.toContain('/Users/linchen');
  });
});
