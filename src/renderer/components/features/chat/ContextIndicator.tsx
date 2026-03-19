// ============================================================================
// ContextIndicator - Compact inline context usage bar above ChatInput
// Shows token usage with color-coded progress when usage > 50%
// ============================================================================

import React from 'react';
import { useAppStore } from '../../../stores/appStore';

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export const ContextIndicator: React.FC = () => {
  const contextHealth = useAppStore((s) => s.contextHealth);

  // Only show when usage is notable (> 50%)
  if (!contextHealth || contextHealth.usagePercent < 50) return null;

  const { usagePercent, currentTokens, maxTokens, warningLevel } = contextHealth;

  const barColor =
    warningLevel === 'critical' ? 'bg-red-500' :
    warningLevel === 'warning' ? 'bg-yellow-500' :
    'bg-green-500';

  const textColor =
    warningLevel === 'critical' ? 'text-red-400' :
    warningLevel === 'warning' ? 'text-yellow-400' :
    'text-zinc-500';

  return (
    <div className="flex items-center gap-2 px-4 py-1 max-w-3xl mx-auto animate-fade-in">
      <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
        <div
          className={`h-full ${barColor} transition-all duration-500`}
          style={{ width: `${Math.min(100, usagePercent)}%` }}
        />
      </div>
      <span className={`text-[10px] tabular-nums ${textColor} flex-shrink-0`}>
        {formatTokens(currentTokens)}/{formatTokens(maxTokens)}
      </span>
    </div>
  );
};
