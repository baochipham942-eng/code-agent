import { useEffect } from 'react';

const EVENT_VALIDATION_SELECTOR = [
  '[data-testid="cron-event-validation"]',
  '[data-testid="cron-event-mail-validation"]',
  '[data-testid="cron-webhook-validation"]',
].join(', ');

/** 基本设置页的账号/群目录是异步加载的，内容会在滚动后继续长高：这段时间内持续校正。 */
const SETTLE_WINDOW_MS = 1500;

/**
 * tick 递增（跳到基本设置页后）把首个事件校验内联提示滚进视野；tick 0 = 还没提交过，不动。
 * 目录加载会把提示往下顶，所以在短窗口内祖先尺寸变化时再校正一次；用户一动手滚动就停。
 */
export function useScrollToEventValidation(tick: number): void {
  useEffect(() => {
    if (tick === 0) return undefined;
    const el = document.querySelector(EVENT_VALIDATION_SELECTOR);
    if (!el) return undefined;
    const reveal = () => el.scrollIntoView?.({ block: 'nearest' });
    reveal();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(reveal);
    for (let node = el.parentElement; node; node = node.parentElement) observer.observe(node);
    const stop = () => observer.disconnect();
    const timer = window.setTimeout(stop, SETTLE_WINDOW_MS);
    window.addEventListener('wheel', stop, { once: true, passive: true });
    window.addEventListener('touchmove', stop, { once: true, passive: true });
    window.addEventListener('keydown', stop, { once: true });
    return () => {
      window.clearTimeout(timer);
      stop();
      window.removeEventListener('wheel', stop);
      window.removeEventListener('touchmove', stop);
      window.removeEventListener('keydown', stop);
    };
  }, [tick]);
}
