import { describe, expect, it, vi } from 'vitest';
import type { NotificationShowEvent } from '../../../src/shared/ipc';
import { applySessionNotificationAttention } from '../../../src/renderer/components/features/sidebar/sessionNotificationAttention';

function notification(overrides: Partial<NotificationShowEvent> = {}): NotificationShowEvent {
  return {
    id: 'notification-1',
    title: '任务完成 - 普通会话',
    body: '已完成',
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('侧栏通知未读接线', () => {
  it('挂断后语音任务的终态通知复用会话未读标记', () => {
    const markSessionUnread = vi.fn();

    const handled = applySessionNotificationAttention(
      notification({
        title: '语音任务完成 - 建日报',
        markSessionUnread: true,
      }),
      { markSessionUnread },
    );

    expect(handled).toBe(true);
    expect(markSessionUnread).toHaveBeenCalledOnce();
    expect(markSessionUnread).toHaveBeenCalledWith('session-1');
  });

  it('普通文本任务通知不改变会话未读状态', () => {
    const markSessionUnread = vi.fn();

    const handled = applySessionNotificationAttention(
      notification(),
      { markSessionUnread },
    );

    expect(handled).toBe(false);
    expect(markSessionUnread).not.toHaveBeenCalled();
  });
});
