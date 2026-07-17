import React from 'react';
import { useI18n } from '../hooks/useI18n';

interface TokenWarningProps {
  usagePercent: number;
  currentLayer?: string;
  isCompressing?: boolean;
  fallbackModel?: string;
}

export function TokenWarning({ usagePercent, currentLayer, isCompressing, fallbackModel }: TokenWarningProps) {
  const { t } = useI18n();
  const n = t.notices.tokenWarning;
  // Normal (< 60%): green
  // Warning (60-85%): yellow
  // Compressing: yellow pulse + layer name
  // Overflow/fallback: red + model name

  if (fallbackModel) {
    return (
      <span className="text-red-400 animate-pulse text-xs">
        ⚠ {n.overflow.replace('{model}', fallbackModel)}
      </span>
    );
  }

  if (isCompressing && currentLayer) {
    return (
      <span className="text-yellow-400 animate-pulse text-xs">
        ◐ {currentLayer} {Math.round(usagePercent * 100)}%
      </span>
    );
  }

  const pct = Math.round(usagePercent * 100);
  const color = usagePercent >= 0.85 ? 'text-red-400'
    : usagePercent >= 0.60 ? 'text-yellow-400'
    : 'text-green-400';

  return <span className={`${color} text-xs`}>{n.ctx.replace('{pct}', String(pct))}</span>;
}
