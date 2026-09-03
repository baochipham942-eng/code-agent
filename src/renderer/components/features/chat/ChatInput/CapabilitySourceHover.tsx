// ============================================================================
// CapabilitySourceHover —— 底栏图标 / 框内胶囊的「来源」悬停卡外壳
// ============================================================================
// 只管浮层怎么开怎么关，卡里写什么由调用方给。鼠标悬停拿取、移开即走，不占常驻空间；
// 触屏没有 hover，长按兜底——长按打开后**必须留在屏上**，否则用户既读不完卡上的来源，
// 也点不到卡里那个「去能力中心连接」的出口（长按打开＝一次显式开卡，收由点卡外负责）。
// 底栏在窗口最下面，卡一律向上弹。
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';

const LONG_PRESS_MS = 400;

export const CapabilitySourceHover: React.FC<{
  testId: string;
  card: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ testId, card, children, className }) => {
  const [open, setOpen] = useState(false);
  const longPressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 长按开的卡不受鼠标事件支配：移动端浏览器会合成 mouseleave，跟着关就等于没开过 */
  const openedByTouch = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };
  const close = () => {
    openedByTouch.current = false;
    setOpen(false);
  };
  useEffect(() => clearLongPress, []);

  // 长按开的卡靠「点卡外」收。鼠标那条路本来就有 mouseleave，这里顺带兜住
  // 「hover 开着卡、手指/鼠标去点了页面别处」的情况。
  useEffect(() => {
    if (!open) return undefined;
    const onPointerDown = (event: Event) => {
      if (!rootRef.current?.contains(event.target as Node)) close();
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div
      ref={rootRef}
      className={`relative ${className || ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { if (!openedByTouch.current) setOpen(false); }}
      onFocus={() => setOpen(true)}
      onBlur={() => { if (!openedByTouch.current) setOpen(false); }}
      onTouchStart={() => {
        clearLongPress();
        longPressTimer.current = setTimeout(() => {
          openedByTouch.current = true;
          setOpen(true);
        }, LONG_PRESS_MS);
      }}
      onTouchEnd={clearLongPress}
      onTouchCancel={clearLongPress}
    >
      {children}
      {open && (
        <div
          role="tooltip"
          data-testid={testId}
          className="absolute bottom-full left-0 z-30 mb-2 w-[260px] rounded-xl border border-border-hover bg-zinc-900/95 px-3 py-2.5 text-left text-xs shadow-md backdrop-blur dark:shadow-2xl"
        >
          {card}
        </div>
      )}
    </div>
  );
};
