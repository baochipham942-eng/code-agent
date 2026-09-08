import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { messages } from '../../i18n';

export function VirtualHistory({ text }: { text: ReturnType<typeof messages> }) {
  const viewport = useRef<HTMLDivElement>(null);
  const [count, setCount] = useState(1000);
  const [top, setTop] = useState(0);
  const [height, setHeight] = useState(600);
  const rowHeight = 112;
  const first = Math.max(0, Math.floor(top / rowHeight) - 3);
  const last = Math.min(count, first + Math.ceil(height / rowHeight) + 7);
  useLayoutEffect(() => {
    const element = viewport.current!;
    const observer = new ResizeObserver(() => setHeight(element.clientHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    let added = 0;
    const timer = window.setInterval(() => {
      setCount(n => n + 1);
      if (++added === 20) window.clearInterval(timer);
    }, 250);
    return () => window.clearInterval(timer);
  }, []);
  return <div ref={viewport} className="virtual-history" data-testid="history" data-count={count}
    aria-label={text.fixtureHistory} onScroll={event => setTop(event.currentTarget.scrollTop)}>
    <div style={{ height: count * rowHeight, position: 'relative' }}>
      {Array.from({ length: last - first }, (_, offset) => {
        const index = first + offset;
        return <article key={index} data-row-index={index} className="history-row"
          style={{ position: 'absolute', top: index * rowHeight, height: rowHeight }}>
          <strong>{text.fixture} {index + 1}</strong><p>{text.fixtureBody}</p>
        </article>;
      })}
    </div>
  </div>;
}
