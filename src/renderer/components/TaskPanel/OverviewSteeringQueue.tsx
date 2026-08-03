// ============================================================================
// OverviewSteeringQueue —— 概览主视线第二层：跑中排队的用户消息（T1）
// ----------------------------------------------------------------------------
// 只是 host steering 队列的投影。删除 = useAgent 的 cancelQueuedRuntimeInput
// （host QueuedInput retract），立即发送 = sendQueuedRuntimeInput（host
// markSending + steer/send）。两个动作都由 runControlStore 从 useAgent 交过来，
// 本文件不发任何 IPC，也不改 host steering 语义。
// ============================================================================

import React from 'react';
import { SendHorizontal, X } from 'lucide-react';
import { useI18n } from '../../hooks/useI18n';
import { useRunControlStore } from '../../stores/runControlStore';
import { IconButton } from '../primitives';
import { Card } from './Card';

export const OverviewSteeringQueue: React.FC = () => {
  const { t } = useI18n();
  const queue = useRunControlStore((state) => state.queue);
  const actions = useRunControlStore((state) => state.actions);

  // 队列空时不占主视线（工单：主视线是进度与干预，不是空壳瀑布）。
  if (queue.length === 0) return null;

  return (
    <Card
      title={t.workbenchTabs.overviewQueueLabel}
      storageKey="overview-queue"
      count={String(queue.length)}
    >
      <ul className="space-y-1" data-testid="overview-queue-rows">
        {queue.map((item) => (
          <li
            key={item.id}
            data-testid="overview-queue-row"
            className="flex min-w-0 items-center gap-2 rounded-md px-1.5 py-1 hover:bg-white/[0.025]"
          >
            <span className="min-w-0 flex-1 truncate text-xs text-zinc-300" title={item.content}>
              {item.content}
            </span>
            {item.attachmentsCount > 0 && (
              <span className="shrink-0 text-[10px] text-zinc-600">
                {t.workbenchTabs.overviewQueueAttachments.replace('{count}', String(item.attachmentsCount))}
              </span>
            )}
            {item.sendFailed && (
              <span className="shrink-0 text-[10px] text-badge-warning">
                {t.workbenchTabs.overviewQueueSendFailed}
              </span>
            )}
            {/* 发送失败的条目宿主已不接受重发，只留删除，不摆点了没反应的按钮 */}
            {!item.sendFailed && actions && (
              <IconButton
                size="sm"
                variant="ghost"
                data-testid={`overview-queue-send-${item.id}`}
                aria-label={t.workbenchTabs.overviewQueueSendNow}
                title={t.workbenchTabs.overviewQueueSendNow}
                icon={<SendHorizontal />}
                onClick={() => { void actions.sendQueuedNow(item.id); }}
              />
            )}
            {actions && (
              <IconButton
                size="sm"
                variant="ghost"
                data-testid={`overview-queue-remove-${item.id}`}
                aria-label={t.workbenchTabs.overviewQueueRemove}
                title={t.workbenchTabs.overviewQueueRemove}
                icon={<X />}
                onClick={() => { void actions.retractQueued(item.id); }}
              />
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
};
