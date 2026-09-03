// ============================================================================
// CapabilitySourceHover —— 底栏图标 / 框内胶囊的「来源」悬停卡外壳
// ============================================================================
// 只管浮层怎么开怎么关，卡里写什么由调用方给。悬停拿取、移开即走，不占常驻空间；
// 触屏没有 hover，长按兜底。底栏在窗口最下面，卡一律向上弹。
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

  const clearLongPress = () => {
    if (longPressTimer.current) {
      clearTimeout(longPressTimer.current);
      longPressTimer.current = null;
    }
  };
  useEffect(() => clearLongPress, []);

  return (
    <div
      className={`relative ${className || ''}`}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
      onTouchStart={() => {
        clearLongPress();
        longPressTimer.current = setTimeout(() => setOpen(true), LONG_PRESS_MS);
      }}
      onTouchEnd={() => {
        clearLongPress();
        setOpen(false);
      }}
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
