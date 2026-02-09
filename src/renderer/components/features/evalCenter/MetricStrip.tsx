// ============================================================================
// MetricStrip - Token/成本/耗时 4 卡片紧凑行（对标 SpreadsheetBench Bottom Stat Bar）
// ============================================================================

import React from 'react';
import type { ObjectiveMetrics } from '@shared/types/sessionAnalytics';

interface MetricStripProps {
  objective: ObjectiveMetrics | null;
}

export const MetricStrip: React.FC<MetricStripProps> = ({ objective }) => {
  if (!objective) return null;

  const items = [
    {
      icon: '📥',
      label: '输入',
      value: `${Math.round(objective.totalInputTokens / 1000)}K`,
    },
    {
      icon: '📤',
      label: '输出',
      value: `${Math.round(objective.totalOutputTokens / 1000)}K`,
    },
    {
      icon: '⏱',
      label: '耗时',
      value: formatDuration(objective.duration),
    },
    {
      icon: '💰',
      label: '成本',
      value: `$${objective.estimatedCost.toFixed(2)}`,
    },
  ];

  return (
    <div>
      <div className="text-xs font-medium text-zinc-400 mb-1.5">Token & 成本</div>
      <div className="flex gap-2">
        {items.map((item) => (
          <div
            key={item.label}
            className="flex-1 bg-zinc-800/30 rounded-lg py-2 px-3 flex items-center gap-2"
          >
            <span className="text-sm">{item.icon}</span>
            <div>
              <div className="text-xs font-medium text-zinc-200">{item.value}</div>
              <div className="text-[10px] text-zinc-500">{item.label}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
}
