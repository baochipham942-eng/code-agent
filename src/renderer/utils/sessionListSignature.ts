import type { SessionWithMeta } from '../stores/sessionStore';

/**
 * 会话列表轻量签名：只覆盖侧栏渲染会用到的字段。两次 loadSessions 签名相同 = 列表视觉无变化，
 * 可保留旧数组引用、跳过 setState，避免云端同步广播触发无谓重渲染（会话历史刷新闪烁根因）。
 * 注意：运行态/审批/后台任务在各自 store，不进此签名，故不影响实时状态更新。
 */
export function sessionsSignature(list: SessionWithMeta[]): string {
  return list
    .map((s) =>
      [
        s.id,
        s.updatedAt ?? 0,
        s.status ?? '',
        s.messageCount ?? 0,
        s.turnCount ?? 0,
        s.isArchived ? 1 : 0,
        s.title ?? '',
        s.workingDirectory ?? '',
      ].join(':'),
    )
    .join('|');
}
