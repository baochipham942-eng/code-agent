// ============================================================================
// CapabilitySourceHover —— 底栏图标 / 框内胶囊的「来源」悬停卡外壳
// ============================================================================
// 只管浮层怎么开怎么关，卡里写什么由调用方给。鼠标悬停拿取、移开即走，不占常驻空间；
// 触屏没有 hover，长按兜底——长按打开后**必须留在屏上**，否则用户既读不完卡上的来源，
// 也点不到卡里那个「去能力中心连接」的出口（长按打开＝一次显式开卡，收由点卡外负责）。
// 底栏在窗口最下面，卡一律向上弹。
// 🔴 卡与触发器之间的视觉间距必须用外壳的 **padding** 做出来，不能用 margin：
// margin 的空隙既不属根 div 也不属卡，鼠标从 chip 移进卡先经过它就触发 mouseleave，
// 卡半路卸载，卡内出口永远点不到。padding 的空隙在 hover 判定区内，路是通的。
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
      className={`relative shrink-0 ${className || ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => { if (!openedByTouch.current) setOpen(false); }}
      onFocus={() => setOpen(true)}
      onBlur={(event) => {
        // 焦点在根内移动（chip → 卡内按钮）不算失焦——否则键盘用户永远到不了卡内出口
        if (!openedByTouch.current && !event.currentTarget.contains(event.relatedTarget as Node)) setOpen(false);
      }}
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
        // 外壳是透明的定位/间距层（pb-2 那段空隙归它，见文件头🔴）；视觉卡是内层
        <div data-testid={testId} className="absolute bottom-full left-0 z-30 pb-2">
          <div className="w-[260px] rounded-xl border border-border-hover bg-zinc-900/95 px-3 py-2.5 text-left text-xs shadow-md backdrop-blur dark:shadow-2xl">
            {card}
          </div>
        </div>
      )}
    </div>
  );
};
