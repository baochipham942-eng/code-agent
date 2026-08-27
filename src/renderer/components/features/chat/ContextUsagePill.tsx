// ============================================================================
// ContextUsagePill - ChatInput toolbar context budget control
// ============================================================================

import React, { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../../../stores/appStore';
import { useContextCompactionStore } from '../../../stores/contextCompactionStore';
import { useI18n } from '../../../hooks/useI18n';
import { ContextHealthDetailPopover } from './ContextHealthDetailPopover';
import { formatContextUsagePercent } from '../../../utils/contextUsageFormat';
import { OPEN_CONTEXT_HEALTH_EVENT } from '../../../utils/workbenchViews';

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
  warning: { ring: 'stroke-badge-warning', text: 'text-badge-warning', hoverBg: 'hover:bg-yellow-500/10' },
  critical: { ring: 'stroke-red-500', text: 'text-badge-danger', hoverBg: 'hover:bg-red-500/10' },
};

export const ContextUsagePill: React.FC = () => {
  const { t } = useI18n();
  const ch = t.taskStatusPanels.contextHealth;
  const contextHealth = useAppStore((s) => s.contextHealth);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  const [detailOpen, setDetailOpen] = useState(false);
  // 压缩结果/失败的反馈行：压缩动作在明细弹层里触发，气泡只读 store 展示结果
  const compactResult = useContextCompactionStore((s) => s.result);
  const compactError = useContextCompactionStore((s) => s.error);

  useEffect(() => {
    // context 深链直接落到明细弹层（不再只开气泡）
    const handleDeepLink = () => setDetailOpen(true);
    window.addEventListener(OPEN_CONTEXT_HEALTH_EVENT, handleDeepLink);
    return () => window.removeEventListener(OPEN_CONTEXT_HEALTH_EVENT, handleDeepLink);
  }, []);

  useEffect(() => {
    if (!open && !detailOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
        setDetailOpen(false);
      }
    };
    const onPointerDown = (e: MouseEvent) => {
      if (!wrapperRef.current?.contains(e.target as Node)) {
        setOpen(false);
        setDetailOpen(false);
      }
    };
    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onPointerDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onPointerDown);
    };
  }, [open, detailOpen]);

  const usagePercent = contextHealth?.usagePercent ?? 0;
  const currentTokens = contextHealth?.currentTokens ?? 0;
  const maxTokens = contextHealth?.maxTokens ?? 0;
  const pct = Math.max(0, Math.min(100, usagePercent));
  const displayPct = formatContextUsagePercent(pct);
  const displayRemainingPct = formatContextUsagePercent(Math.max(0, 100 - pct));
  const tone = toneFromPercent(pct);
  const styles = TONE_STYLES[tone];
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
      onMouseEnter={() => {
        // 明细弹层展开时不再叠气泡
        if (!detailOpen) setOpen(true);
      }}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        onClick={() => {
          // 点击圆环 = 展开/收起长在输入框上方的明细弹层（hover 气泡只是只读预览）
          setDetailOpen((prev) => !prev);
          setOpen(false);
        }}
        onFocus={() => setOpen(true)}
        aria-expanded={detailOpen}
        className={`inline-flex h-8 items-center justify-center gap-1 rounded-lg px-1.5 text-xs tabular-nums transition-colors ${styles.text} ${styles.hoverBg}`}
        aria-label={ch.usageAriaLabel}
        title={hasData
          ? ch.usageTitle
              .replace('{percent}', displayPct)
              .replace('{used}', formatTokens(currentTokens))
              .replace('{max}', formatTokens(maxTokens))
          : ch.waitingFirstTurn}
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
        {/* 折叠态只留圆环（2026-07-26 底栏收敛拍板，推翻此前"可读锚点"决定）：
            圆环讲进度，精确百分比在 hover title 和展开面板，底栏不再常驻数字。 */}
      </button>

      {open && (
        <div className="absolute bottom-full right-0 z-30 mb-2 min-w-[200px] rounded-xl border border-border-hover bg-zinc-900/95 px-4 py-3 text-center shadow-md dark:shadow-2xl backdrop-blur">
          <div className="text-sm font-semibold leading-tight tracking-normal text-zinc-50 tabular-nums">
            {hasData
              ? ch.usageSummary.replace('{percent}', displayPct).replace('{remaining}', displayRemainingPct)
              : ch.waitingFirstTurn}
          </div>
          <div className="mt-1 text-[11px] leading-tight text-zinc-400 tabular-nums">
            {hasData
              ? ch.tokensFraction.replace('{used}', formatTokens(currentTokens)).replace('{max}', formatTokens(maxTokens))
              : ch.waitingCapacity}
          </div>

          {compactResult && (
            <div className="mt-2 text-[11px] text-badge-success">
              {compactResult.totalSavedTokens > 0
                ? ch.freedTokens.replace('{tokens}', formatTokens(compactResult.totalSavedTokens))
                : ch.compactedCount.replace('{count}', String(compactResult.compressionCount))}
            </div>
          )}
          {compactError && (
            <div className="mt-2 text-[11px] text-badge-danger">{compactError}</div>
          )}
        </div>
      )}

      {detailOpen && (
        <ContextHealthDetailPopover onClose={() => setDetailOpen(false)} />
      )}
    </div>
  );
};

export default ContextUsagePill;
