import { useEffect, useRef, type ReactNode } from 'react';
import type { messages } from '../i18n';

export function SheetHost({ page, title, hasParent, close, back, text, children }: {
  page: string; title: string; hasParent: boolean; close(): void; back(): void;
  text: ReturnType<typeof messages>; children: ReactNode;
}) {
  const panel = useRef<HTMLElement>(null);
  const start = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => { previous?.focus({ preventScroll: true }); };
  }, []);
  useEffect(() => { panel.current?.focus({ preventScroll: true }); }, [page]);
  return <div className="sheet-layer" data-testid="sheet-host">
    <button className="scrim" aria-label={text.closeSheet} tabIndex={-1} onClick={close} />
    <section ref={panel} tabIndex={-1} className="sheet" role="dialog" aria-modal="true" aria-labelledby="sheet-title"
      onKeyDown={event => {
        if (event.key !== 'Tab') return;
        const items = panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea,[tabindex="0"]');
        if (!items?.length) return;
        const first = items[0], last = items[items.length - 1];
        if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }}>
      <div className="drag-handle" data-testid="sheet-handle" aria-label={text.drag}
        onPointerDown={event => { start.current = { x: event.clientX, y: event.clientY }; event.currentTarget.setPointerCapture(event.pointerId); }}
        onPointerCancel={() => { start.current = null; }}
        onPointerUp={event => {
          const initial = start.current; start.current = null;
          if (initial && event.clientY - initial.y > 86 && Math.abs(event.clientX - initial.x) < 70) close();
        }}><span /></div>
      <header className="sheet-header">
        {hasParent ? <button aria-label={text.back} onClick={back}>‹</button> : <span className="header-spacer" />}
        <h2 id="sheet-title">{title}</h2><button aria-label={text.closeSheet} onClick={close}>×</button>
      </header>
      <div className="sheet-content" data-page={page}>{children}</div>
    </section>
  </div>;
}
