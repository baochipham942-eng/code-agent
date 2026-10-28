import { useCallback, useEffect, useRef } from 'react';

const SCROLL_EDGE_EPSILON_PX = 1;

export function useScrollEdgeFade(): (scroller: HTMLElement | null) => void {
  const cleanupRef = useRef<(() => void) | null>(null);
  useEffect(() => () => cleanupRef.current?.(), []);
  return useCallback((scroller: HTMLElement | null) => {
    cleanupRef.current?.();
    cleanupRef.current = null;
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
    const resizeObserver = new ResizeObserver(scheduleUpdate);
    const observeTree = (root: Element) => {
      resizeObserver.observe(root);
      root.querySelectorAll('*').forEach((element) => resizeObserver.observe(element));
    };
    const mutationObserver = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        mutation.addedNodes.forEach((node) => {
          if (node instanceof Element) observeTree(node);
        });
      }
      scheduleUpdate();
    });
    scheduleUpdate();
    observeTree(scroller);
    mutationObserver.observe(scroller, { childList: true, subtree: true });
    scroller.addEventListener('scroll', scheduleUpdate, { passive: true });
    cleanupRef.current = () => {
      scroller.removeEventListener('scroll', scheduleUpdate);
      mutationObserver.disconnect();
      resizeObserver.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);
}
