// ============================================================================
// ContextUsagePill - ChatInput toolbar context budget control
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Shrink } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useContextCompactionStore } from '../../../stores/contextCompactionStore';
import { IPC_CHANNELS } from '@shared/ipc';
import ipcService from '../../../services/ipcService';
import { formatContextUsagePercent } from '../../../utils/contextUsageFormat';

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(0)}k`;
  return String(n);
}

type Tone = 'normal' | 'warning' | 'critical';

function toneFromPercent(pct: number): Tone {
  if (pct >= 90) return 'critical';
  if (pct >= 70) return 'warning';
  return 'normal';
}

// 视觉简化：normal 走统一灰色（每条 turn 都看的高频元素，不需要装饰色抢注意）；
// warning/critical 保留 functional color，因为这是上下文吃紧的告警信号
const TONE_STYLES: Record<Tone, { ring: string; text: string; hoverBg: string }> = {
  normal: { ring: 'stroke-zinc-500', text: 'text-zinc-400', hoverBg: 'hover:bg-zinc-700/30' },
  warning: { ring: 'stroke-yellow-500', text: 'text-yellow-400', hoverBg: 'hover:bg-yellow-500/10' },
  critical: { ring: 'stroke-red-500', text: 'text-red-400', hoverBg: 'hover:bg-red-500/10' },
};

export const ContextUsagePill: React.FC = () => {
  const contextHealth = useAppStore((s) => s.contextHealth);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const clearTimerRef = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const compactionStatus = useContextCompactionStore((s) => s.status);
  const compactResult = useContextCompactionStore((s) => s.result);
  const compactError = useContextCompactionStore((s) => s.error);
  const startCompaction = useContextCompactionStore((s) => s.start);
  const succeedCompaction = useContextCompactionStore((s) => s.succeed);
  const failCompaction = useContextCompactionStore((s) => s.fail);
  const clearCompaction = useContextCompactionStore((s) => s.clear);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open]);

  useEffect(() => () => {
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
    }
  }, []);

  const scheduleFeedbackClear = useCallback((delayMs: number) => {
    if (clearTimerRef.current !== null) {
      window.clearTimeout(clearTimerRef.current);
    }
    clearTimerRef.current = window.setTimeout(() => {
      clearCompaction();
      clearTimerRef.current = null;
    }, delayMs);
  }, [clearCompaction]);

  const handleCompact = useCallback(async () => {
    if (compactionStatus === 'active') return;
    const sessionId = useSessionStore.getState().currentSessionId;
    startCompaction();
    setOpen(false);
    try {
      const result = await ipcService.invoke(
        IPC_CHANNELS.CONTEXT_COMPACT_CURRENT,
        sessionId ?? undefined,
      );
      if (result.success) {
        succeedCompaction(result);
        if (sessionId) {
          void useSessionStore.getState().refreshContextHealth(sessionId);
        }
      } else {
        failCompaction('压缩失败');
      }
      scheduleFeedbackClear(4500);
    } catch {
      failCompaction('压缩失败');
      scheduleFeedbackClear(3500);
    }
  }, [
    compactionStatus,
    failCompaction,
    scheduleFeedbackClear,
    startCompaction,
    succeedCompaction,
  ]);

  const usagePercent = contextHealth?.usagePercent ?? 0;
  const currentTokens = contextHealth?.currentTokens ?? 0;
  const maxTokens = contextHealth?.maxTokens ?? 0;
  const pct = Math.max(0, Math.min(100, usagePercent));
  const displayPct = formatContextUsagePercent(pct);
  const displayRemainingPct = formatContextUsagePercent(Math.max(0, 100 - pct));
  const tone = toneFromPercent(pct);
  const styles = TONE_STYLES[tone];
  const canCompact = pct >= 70;
  const hasData = !!contextHealth && maxTokens > 0;
  const isCompacting = compactionStatus === 'active';

  // SVG 圆环参数
  const size = 14;
  const strokeWidth = 2;
  const radius = (size - strokeWidth) / 2;
  const center = size / 2;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - pct / 100);

  return (
    <div
      ref={wrapperRef}
      className="relative flex-shrink-0"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        onFocus={() => setOpen(true)}
        className={`inline-flex h-8 w-8 items-center justify-center rounded-lg text-xs tabular-nums transition-colors ${styles.text} ${styles.hoverBg}`}
        aria-label="上下文使用"
        title={`${displayPct}% 已用 · ${formatTokens(currentTokens)}/${formatTokens(maxTokens)} 标记`}
      >
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="transform -rotate-90">
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            className="stroke-zinc-700"
          />
          <circle
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            strokeWidth={strokeWidth}
            strokeLinecap="round"
            strokeDasharray={circumference}
            strokeDashoffset={dashOffset}
            className={`${styles.ring} transition-all duration-500`}
          />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-2 min-w-[260px] rounded-xl border border-white/[0.12] bg-zinc-900/95 px-5 py-4 text-center shadow-2xl backdrop-blur">
          <div className="text-sm font-medium text-zinc-400">背景信息窗口：</div>
          <div className="mt-2 text-[22px] font-semibold leading-tight tracking-normal text-zinc-50 tabular-nums">
            {hasData
              ? `${displayPct}% 已用（剩余 ${displayRemainingPct}%）`
              : '等待首轮对话'}
          </div>
          <div className="mt-2 text-lg leading-tight text-zinc-100 tabular-nums">
            {hasData
              ? `已用 ${formatTokens(currentTokens)} 标记，共 ${formatTokens(maxTokens)}`
              : '等待统计上下文容量'}
          </div>

          {canCompact && (
            <button
              type="button"
              onClick={handleCompact}
              disabled={isCompacting}
              className="mt-3 inline-flex h-8 items-center justify-center gap-1.5 rounded-lg border border-white/[0.1] bg-white/[0.06] px-3 text-xs font-medium text-zinc-100 transition-colors hover:bg-white/[0.1] disabled:cursor-wait disabled:opacity-70"
              title="主动压缩上下文"
            >
              {isCompacting ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Shrink className="h-3.5 w-3.5" />
              )}
              <span>{isCompacting ? '正在压缩' : '压缩'}</span>
            </button>
          )}

          {compactResult && (
            <div className="mt-2 text-[11px] text-emerald-400">
              {compactResult.totalSavedTokens > 0
                ? `释放 ${formatTokens(compactResult.totalSavedTokens)} 标记`
                : `已压缩 ${compactResult.compressionCount} 次`}
            </div>
          )}
          {compactError && (
            <div className="mt-2 text-[11px] text-red-400">{compactError}</div>
          )}
        </div>
      )}
    </div>
  );
};

export default ContextUsagePill;
