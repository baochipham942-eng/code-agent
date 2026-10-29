import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

export function useMenuKeyboardNav(
  open: boolean,
  containerRef: RefObject<HTMLElement | null>,
  closeAndReturnFocus: () => void,
): void {
  const closeRef = useRef(closeAndReturnFocus);
  closeRef.current = closeAndReturnFocus;

  useEffect(() => {
    if (!open) return undefined;
    const container = containerRef.current;
    if (!container) return undefined;

    const enabledItems = () => Array.from(
      container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).filter((item) => !item.hasAttribute('disabled') && item.getAttribute('aria-disabled') !== 'true');

    enabledItems()[0]?.focus();

    const onDocumentKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      event.stopPropagation();
      closeRef.current();
    };

    const onKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;

      const items = enabledItems();
      if (items.length === 0) return;
      event.preventDefault();

      const currentIndex = items.indexOf(document.activeElement as HTMLElement);
      let nextIndex = 0;
      if (event.key === 'End') nextIndex = items.length - 1;
      if (event.key === 'ArrowUp') nextIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
      if (event.key === 'ArrowDown' && currentIndex >= 0) nextIndex = (currentIndex + 1) % items.length;
      items[nextIndex]?.focus();
    };

    document.addEventListener('keydown', onDocumentKeyDown);
    container.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onDocumentKeyDown);
      container.removeEventListener('keydown', onKeyDown);
    };
  }, [open, containerRef]);
}
