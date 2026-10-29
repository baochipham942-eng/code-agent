import React, { useEffect, useState } from 'react';
import { Button } from '../../primitives/Button';
import { useI18n } from '../../../hooks/useI18n';
import { interpolate } from '../../../i18n/interpolate';

function formatQuotaWaitWhen(dueAt: number, now = Date.now()): string {
  const due = new Date(dueAt);
  const clock = `${String(due.getHours()).padStart(2, '0')}:${String(due.getMinutes()).padStart(2, '0')}`;
  const today = new Date(now);
  const sameDay = due.getFullYear() === today.getFullYear()
    && due.getMonth() === today.getMonth()
    && due.getDate() === today.getDate();
  if (sameDay) return clock;
  const date = `${due.getFullYear()}-${String(due.getMonth() + 1).padStart(2, '0')}-${String(due.getDate()).padStart(2, '0')}`;
  return `${date} ${clock}`;
}

export function QuotaWaitNotice(props: {
  dueAt: number;
  duePassed: boolean;
  onCancel: () => void;
  onRetryNow: () => void;
}): React.ReactElement {
  const { t } = useI18n();
  // duePassed 是投影时快照，会话列表不刷新就停在旧值：到点翻转靠本地一次性定时器补上
  // （与宿主 armQuotaWaitOnPark 同为 one-shot），自动续跑失败时文案也不会停在过期的「预计」。
  const [dueReached, setDueReached] = useState(false);
  useEffect(() => {
    setDueReached(false);
    if (props.duePassed || props.dueAt <= Date.now()) return;
    const timer = setTimeout(() => setDueReached(true), props.dueAt - Date.now());
    return () => clearTimeout(timer);
  }, [props.duePassed, props.dueAt]);
  const duePassed = props.duePassed || dueReached || props.dueAt <= Date.now();
  const text = duePassed
    ? t.chat.quotaWaitDue
    : interpolate(t.chat.quotaWaitUntil, { when: formatQuotaWaitWhen(props.dueAt) });
  return (
    <div data-testid="quota-wait-notice" className="mx-4 mb-2 flex items-center justify-between gap-3 rounded-lg border border-border-muted bg-surface-subtle px-3 py-2 text-sm text-zinc-300">
      <span>{text}</span>
      <span className="flex shrink-0 gap-2">
        <Button type="button" variant="ghost" size="sm" data-testid="quota-wait-cancel" onClick={props.onCancel}>{t.common.cancel}</Button>
        <Button type="button" variant="secondary" size="sm" data-testid="quota-wait-retry" onClick={props.onRetryNow}>{t.chat.quotaWaitRetryNow}</Button>
      </span>
    </div>
  );
}
