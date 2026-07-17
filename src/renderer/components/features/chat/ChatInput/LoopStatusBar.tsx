// ============================================================================
// LoopStatusBar — 会话内循环运行时的控制条（运行中 / 第 N 轮 / 停止）。
// 挂在输入框上方；仅当当前 session 有 running loop 时显示。
// ============================================================================

import React, { useEffect } from 'react';
import { RefreshCw, Square } from 'lucide-react';
import { RENDERER_POLLING } from '@shared/constants';
import { useLoopStore } from '../../../../stores/loopStore';
import { useI18n } from '../../../../hooks/useI18n';

interface LoopStatusBarProps {
  sessionId: string | null;
}

export const LoopStatusBar: React.FC<LoopStatusBarProps> = ({ sessionId }) => {
  const { t } = useI18n();
  const refresh = useLoopStore((s) => s.refresh);
  const stop = useLoopStore((s) => s.stop);
  const loops = useLoopStore((s) => s.loops);

  // 空闲门控：有 running loop 时才以 LOOP_BASE 快轮询；否则退到 MAX_BACKOFF 慢心跳，
  // 避免无循环时仍每 2s 猛打 loop:list（实测空闲头号请求源）。会话内启动的 loop 会被
  // ChatInput track() 立即登记，hasRunningLoop 翻 true 触发本 effect 切回快轮询。
  const hasRunningLoop = useLoopStore((s) =>
    Object.values(s.loops).some((l) => l.sessionId === sessionId && l.status === 'running'),
  );

  useEffect(() => {
    if (!sessionId) return;
    void refresh(sessionId);
    const interval = hasRunningLoop ? RENDERER_POLLING.LOOP_BASE : RENDERER_POLLING.MAX_BACKOFF;
    const timer = setInterval(() => void refresh(sessionId), interval);
    return () => clearInterval(timer);
  }, [sessionId, refresh, hasRunningLoop]);

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
            {t.loopStatusBar.runningPrefix}{l.turn}{t.loopStatusBar.runningSuffix}
            {l.intervalMs
              ? t.loopStatusBar.intervalSuffix.replace('{s}', String(Math.round(l.intervalMs / 1000)))
              : t.loopStatusBar.selfPacedSuffix}
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
            {t.loopStatusBar.stop}
          </button>
        </div>
      ))}
    </div>
  );
};

export default LoopStatusBar;
