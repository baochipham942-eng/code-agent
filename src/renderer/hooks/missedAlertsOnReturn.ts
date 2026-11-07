// 用户离开 app 期间到达的 urgent 通知（失败 / 需要输入）排队，窗口回到前台时合并成一条 toast。
// 纯队列：不碰 DOM、store 与 toast，由 useCronOsNotification 接线。

import type { NotificationShowEvent } from '@shared/ipc';

export interface MissedAlertToastSpec {
  type: 'error' | 'warning';
  count: number;
  /** 最近一条仍有效的事件：单条时展示它，多条时「查看」打开它。 */
  latest: NotificationShowEvent;
}

export function createMissedAlertQueue() {
  const queue: NotificationShowEvent[] = [];
  return {
    record(event: NotificationShowEvent, attended: boolean): void {
      if (event.urgent !== true || attended) return;
      if (queue.some((e) => e.id === event.id)) return;
      queue.push(event);
    },
    /** 审批裁决后 host 广播 retract：按 dedupeKey 把还没补提醒的 needs-input 事件移出队列。 */
    remove(dedupeKey: string | undefined): void {
      if (!dedupeKey) return;
      const index = queue.findIndex((entry) => entry.dedupeKey === dedupeKey);
      if (index !== -1) queue.splice(index, 1);
    },
    /** 清空队列；回来时已经在看的会话不再提醒。 */
    flush(currentSessionId: string | null): MissedAlertToastSpec | null {
      const pending = queue.splice(0).filter((e) => !e.sessionId || e.sessionId !== currentSessionId);
      if (pending.length === 0) return null;
      return {
        type: pending.some((e) => e.failure === true) ? 'error' : 'warning',
        count: pending.length,
        latest: pending[pending.length - 1],
      };
    },
  };
}
