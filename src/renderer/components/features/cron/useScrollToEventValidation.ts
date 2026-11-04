import { useEffect } from 'react';

const EVENT_VALIDATION_SELECTOR = [
  '[data-testid="cron-event-validation"]',
  '[data-testid="cron-event-mail-validation"]',
  '[data-testid="cron-webhook-validation"]',
].join(', ');

/** tick 递增（跳到基本设置页后）把首个事件校验内联提示滚进视野；tick 0 = 还没提交过，不动。 */
export function useScrollToEventValidation(tick: number): void {
  useEffect(() => {
    if (tick === 0) return;
    document.querySelector(EVENT_VALIDATION_SELECTOR)?.scrollIntoView?.({ block: 'nearest' });
  }, [tick]);
}
