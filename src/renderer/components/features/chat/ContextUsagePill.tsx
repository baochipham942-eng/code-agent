// ============================================================================
// ContextUsagePill — ChatInput 工具栏里的上下文使用 pill（Codex 风格）
// ============================================================================
//
// 小圆环 + 百分比 pill，hover 展开 popover 显示：
//   Context window · X% full · N/M tokens used · [Compact]
// 颜色跟 contextHealth.warningLevel 联动。无 contextHealth 时不渲染。
//
// ============================================================================

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, Shrink } from 'lucide-react';
import { useAppStore } from '../../../stores/appStore';
import { IPC_CHANNELS } from '@shared/ipc';
import type { CompactResult } from '@shared/contract/contextHealth';
import ipcService from '../../../services/ipcService';

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

const TONE_STYLES: Record<Tone, { ring: string; text: string; bg: string }> = {
  normal: { ring: 'stroke-emerald-500', text: 'text-emerald-400', bg: 'bg-emerald-500/10' },
  warning: { ring: 'stroke-yellow-500', text: 'text-yellow-400', bg: 'bg-yellow-500/10' },
  critical: { ring: 'stroke-red-500', text: 'text-red-400', bg: 'bg-red-500/10' },
};

export const ContextUsagePill: React.FC = () => {
  const contextHealth = useAppStore((s) => s.contextHealth);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const [compactResult, setCompactResult] = useState<CompactResult | null>(null);
  const [compactError, setCompactError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const handleCompact = useCallback(async () => {
    if (isCompacting) return;
    setIsCompacting(true);
    setCompactResult(null);
    setCompactError(null);
    try {
      const result = await ipcService.invoke(IPC_CHANNELS.CONTEXT_COMPACT_FROM, '') as CompactResult;
      if (result.success) setCompactResult(result);
      else setCompactError('压缩失败');
      setTimeout(() => { setCompactResult(null); setCompactError(null); }, 5000);
    } catch {
      setCompactError('压缩失败');
      setTimeout(() => setCompactError(null), 3000);
    } finally {
      setIsCompacting(false);
    }
  }, [isCompacting]);

  const usagePercent = contextHealth?.usagePercent ?? 0;
  const currentTokens = contextHealth?.currentTokens ?? 0;
  const maxTokens = contextHealth?.maxTokens ?? 0;
  const pct = Math.max(0, Math.min(100, usagePercent));
  const displayPct = Math.round(pct);
  const tone = toneFromPercent(pct);
  const styles = TONE_STYLES[tone];
  const canCompact = pct >= 70;
  const hasData = !!contextHealth && maxTokens > 0;

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
        className={`inline-flex items-center gap-1.5 h-8 rounded-lg px-2 text-xs tabular-nums transition-colors ${styles.text} hover:${styles.bg}`}
        aria-label="上下文使用"
        title={`${displayPct}% · ${formatTokens(currentTokens)}/${formatTokens(maxTokens)} tokens`}
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
        <span>{displayPct}%</span>
      </button>

      {open && (
        <div className="absolute bottom-full right-0 mb-2 w-56 rounded-lg border border-white/[0.1] bg-zinc-900/95 p-3 shadow-xl backdrop-blur z-30">
          <div className="text-[10px] uppercase tracking-wider text-zinc-500 mb-1">Context window</div>
          <div className={`text-lg font-semibold tabular-nums ${styles.text}`}>
            {displayPct}% full
          </div>
          <div className="text-xs text-zinc-300 tabular-nums mt-1">
            {hasData
              ? `${formatTokens(currentTokens)} / ${formatTokens(maxTokens)} tokens used`
              : '等待首轮对话'}
          </div>

          {canCompact && (
            <button
              type="button"
              onClick={handleCompact}
              disabled={isCompacting}
              className="mt-3 w-full inline-flex items-center justify-center gap-1.5 rounded-md border border-white/[0.08] bg-white/[0.03] px-2 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-white/[0.07] disabled:opacity-50 disabled:cursor-not-allowed"
              title="主动压缩上下文"
            >
              {isCompacting ? (
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
              ) : (
                <Shrink className="w-3.5 h-3.5" />
              )}
              <span>Compact</span>
            </button>
          )}

          {compactResult && (
            <div className="mt-2 text-[11px] text-emerald-400">
              {compactResult.totalSavedTokens > 0
                ? `释放 ${formatTokens(compactResult.totalSavedTokens)} tokens`
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
