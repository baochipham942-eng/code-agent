import { useEffect } from 'react';

const SCROLL_EDGE_EPSILON_PX = 1;

export function useScrollEdgeFade(scroller: HTMLElement | null): void {
  useEffect(() => {
    if (!scroller) return;
    let frame: number | null = null;
    const update = () => {
      frame = null;
      scroller.dataset.fadeTop = String(scroller.scrollTop > SCROLL_EDGE_EPSILON_PX);
      scroller.dataset.fadeBottom = String(
        scroller.scrollTop + scroller.clientHeight < scroller.scrollHeight - SCROLL_EDGE_EPSILON_PX,
      );
    };
    const scheduleUpdate = () => {
      if (frame === null) frame = requestAnimationFrame(update);
    };
    scheduleUpdate();
    scroller.addEventListener('scroll', scheduleUpdate, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', scheduleUpdate);
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [scroller]);
}
