// ============================================================================
// SessionContextMenu - 会话右键上下文菜单
// ============================================================================

import React, { useEffect, useRef, useCallback } from 'react';

export interface ContextMenuItem {
  label: string;
  icon: string;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export interface SessionContextMenuProps {
  x: number;
  y: number;
  items: ContextMenuItem[];
  onClose: () => void;
}

export const SessionContextMenu: React.FC<SessionContextMenuProps> = ({
  x,
  y,
  items,
  onClose,
}) => {
  const menuRef = useRef<HTMLDivElement>(null);

  // 调整位置以避免溢出视口
  const adjustedPosition = useCallback(() => {
    if (!menuRef.current) return { left: x, top: y };

    const rect = menuRef.current.getBoundingClientRect();
    const viewportW = window.innerWidth;
    const viewportH = window.innerHeight;

    let left = x;
    let top = y;

    // 右侧溢出
    if (left + rect.width > viewportW - 8) {
      left = viewportW - rect.width - 8;
    }
    // 底部溢出
    if (top + rect.height > viewportH - 8) {
      top = viewportH - rect.height - 8;
    }
    // 左侧溢出
    if (left < 8) left = 8;
    // 顶部溢出
    if (top < 8) top = 8;

    return { left, top };
  }, [x, y]);

  // 点击外部关闭
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };

    // 延迟一帧绑定，避免触发菜单的 contextmenu 事件立即关闭
    requestAnimationFrame(() => {
      document.addEventListener('mousedown', handleClickOutside);
      document.addEventListener('keydown', handleEscape);
    });

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose]);

  // 位置计算：先渲染在原始位置，再用 ref 调整
  const [pos, setPos] = React.useState({ left: x, top: y });

  useEffect(() => {
    // 需要等 DOM 渲染后才能获取尺寸
    requestAnimationFrame(() => {
      setPos(adjustedPosition());
    });
  }, [adjustedPosition]);

  return (
    <div
      ref={menuRef}
      className="fixed z-[9999] min-w-[160px] py-1 bg-zinc-900 border border-zinc-700/80 rounded-lg shadow-xl"
      style={{ left: pos.left, top: pos.top }}
    >
      {items.map((item, index) => (
        <button
          key={index}
          onClick={() => {
            if (!item.disabled) {
              item.onClick();
              onClose();
            }
          }}
          disabled={item.disabled}
          className={`w-full flex items-center gap-2 px-3 py-1.5 text-sm transition-colors ${
            item.danger
              ? 'text-red-400 hover:bg-red-500/10 hover:text-red-300'
              : 'text-zinc-400 hover:bg-zinc-700 hover:text-zinc-200'
          } ${item.disabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer'}`}
        >
          <span className="w-4 text-center shrink-0">{item.icon}</span>
          <span>{item.label}</span>
        </button>
      ))}
    </div>
  );
};
