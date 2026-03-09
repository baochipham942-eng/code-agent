// ============================================================================
// UndoToast - 底部居中浮动提示，支持撤销操作
// ============================================================================

import React, { useEffect, useState } from 'react';

export interface UndoToastProps {
  /** 显示的消息文本 */
  message: string;
  /** 撤销回调 */
  onUndo: () => void;
  /** 自动消失时的回调（不撤销，执行删除） */
  onDismiss: () => void;
  /** 自动消失时间（毫秒），默认 5000 */
  duration?: number;
}

export const UndoToast: React.FC<UndoToastProps> = ({
  message,
  onUndo,
  onDismiss,
  duration = 5000,
}) => {
  const [visible, setVisible] = useState(true);
  const [progress, setProgress] = useState(100);

  // 进度条动画
  useEffect(() => {
    const startTime = Date.now();
    const interval = setInterval(() => {
      const elapsed = Date.now() - startTime;
      const remaining = Math.max(0, 100 - (elapsed / duration) * 100);
      setProgress(remaining);
      if (remaining <= 0) {
        clearInterval(interval);
      }
    }, 50);

    return () => clearInterval(interval);
  }, [duration]);

  // 自动消失
  useEffect(() => {
    const timer = setTimeout(() => {
      setVisible(false);
      // 短延迟后回调，让退出动画完成
      setTimeout(onDismiss, 200);
    }, duration);

    return () => clearTimeout(timer);
  }, [duration, onDismiss]);

  const handleUndo = () => {
    setVisible(false);
    onUndo();
  };

  return (
    <div
      className={`fixed bottom-6 left-1/2 -translate-x-1/2 z-[9998] transition-all duration-200 ${
        visible ? 'opacity-100 translate-y-0' : 'opacity-0 translate-y-2'
      }`}
    >
      <div className="flex items-center gap-3 px-4 py-2.5 bg-zinc-700 border border-zinc-700/60 rounded-lg shadow-lg">
        <span className="text-sm text-zinc-400">{message}</span>
        <button
          onClick={handleUndo}
          className="text-sm font-medium text-blue-400 hover:text-blue-300 transition-colors whitespace-nowrap"
        >
          撤销
        </button>
      </div>
      {/* 进度条 */}
      <div className="absolute bottom-0 left-0 right-0 h-0.5 bg-zinc-700 rounded-b-lg overflow-hidden">
        <div
          className="h-full bg-blue-500/60 transition-[width] duration-50 ease-linear"
          style={{ width: `${progress}%` }}
        />
      </div>
    </div>
  );
};
