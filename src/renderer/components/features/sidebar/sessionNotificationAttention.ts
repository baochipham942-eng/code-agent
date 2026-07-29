import type { NotificationShowEvent } from '@shared/ipc';

export interface SessionNotificationAttentionDeps {
  markSessionUnread: (sessionId: string) => void;
}

/**
 * 把主进程明确标成“会话有新结果”的通知接到现有未读状态。
 * 普通系统通知没有 markSessionUnread，不改变任何文本会话的侧栏状态。
 */
export function applySessionNotificationAttention(
  event: NotificationShowEvent,
  deps: SessionNotificationAttentionDeps,
): boolean {
  if (event.markSessionUnread !== true) return false;
  deps.markSessionUnread(event.sessionId);
  return true;
}
