// ============================================================================
// LoopStatusBar — 会话内循环运行时的控制条（运行中 / 第 N 轮 / 停止）。
// 挂在输入框上方；仅当当前 session 有 running loop 时显示。
// ============================================================================

import React, { useEffect } from 'react';
import { RefreshCw, Square } from 'lucide-react';
import { useLoopStore } from '../../../../stores/loopStore';

const POLL_MS = 2000;

interface LoopStatusBarProps {
  sessionId: string | null;
}

export const LoopStatusBar: React.FC<LoopStatusBarProps> = ({ sessionId }) => {
  const refresh = useLoopStore((s) => s.refresh);
  const stop = useLoopStore((s) => s.stop);
  const loops = useLoopStore((s) => s.loops);

  useEffect(() => {
    if (!sessionId) return;
    void refresh(sessionId);
    const timer = setInterval(() => void refresh(sessionId), POLL_MS);
    return () => clearInterval(timer);
  }, [sessionId, refresh]);

  if (!sessionId) return null;
  const running = Object.values(loops).filter(
    (l) => l.sessionId === sessionId && l.status === 'running',
  );
  if (running.length === 0) return null;

  return (
    <div className="flex flex-col gap-1.5 px-3 pb-2">
      {running.map((l) => (
        <div
          key={l.id}
          className="flex items-center gap-2 rounded-lg border border-blue-500/30 bg-blue-500/10 px-3 py-1.5 text-xs text-blue-200"
        >
          <RefreshCw size={13} className="shrink-0 animate-spin" />
          <span className="shrink-0 font-medium">
            循环中 · 第 {l.turn} 轮
            {l.intervalMs
              ? `（每 ${Math.round(l.intervalMs / 1000)}s）`
              : '（自定步调）'}
          </span>
          <span className="min-w-0 flex-1 truncate text-blue-300/80" title={l.prompt}>
            {l.prompt}
          </span>
          <button
            type="button"
            onClick={() => void stop(l.id)}
            className="flex shrink-0 items-center gap-1 rounded-md bg-blue-500/20 px-2 py-0.5 text-blue-100 hover:bg-red-500/30 hover:text-red-100"
          >
            <Square size={11} />
            停止
          </button>
        </div>
      ))}
    </div>
  );
};

export default LoopStatusBar;
