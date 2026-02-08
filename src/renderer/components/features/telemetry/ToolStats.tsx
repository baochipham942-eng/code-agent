// ============================================================================
// Tool Stats - 工具使用统计
// ============================================================================

import React from 'react';
import type { TelemetryToolStat } from '@shared/types/telemetry';
import { CheckCircle, XCircle } from 'lucide-react';

interface ToolStatsProps {
  stats: TelemetryToolStat[];
}

export const ToolStats: React.FC<ToolStatsProps> = ({ stats }) => {
  if (stats.length === 0) {
    return <div className="text-center text-zinc-500 text-sm py-8">暂无工具统计数据</div>;
  }

  const maxCalls = Math.max(...stats.map(s => s.callCount));

  return (
    <div className="space-y-2">
      {stats.map((stat) => {
        const barWidth = maxCalls > 0 ? (stat.callCount / maxCalls) * 100 : 0;
        const successColor = stat.successRate >= 0.8 ? 'bg-green-500/30' : stat.successRate >= 0.5 ? 'bg-amber-500/30' : 'bg-red-500/30';

        return (
          <div key={stat.name} className="p-2.5 bg-zinc-800/30 rounded-lg border border-zinc-700/30">
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs font-mono text-zinc-300">{stat.name}</span>
              <div className="flex items-center gap-3 text-[10px] text-zinc-500">
                <span>{stat.callCount} 次</span>
                <span>avg {stat.avgDurationMs}ms</span>
              </div>
            </div>

            {/* Bar */}
            <div className="relative h-4 bg-zinc-900/50 rounded overflow-hidden">
              <div
                className={`absolute inset-y-0 left-0 ${successColor} rounded transition-all`}
                style={{ width: `${barWidth}%` }}
              />
              <div className="absolute inset-0 flex items-center justify-between px-2">
                <div className="flex items-center gap-1 text-[10px]">
                  <CheckCircle className="w-2.5 h-2.5 text-green-400" />
                  <span className="text-green-400">{stat.successCount}</span>
                </div>
                {stat.failCount > 0 && (
                  <div className="flex items-center gap-1 text-[10px]">
                    <XCircle className="w-2.5 h-2.5 text-red-400" />
                    <span className="text-red-400">{stat.failCount}</span>
                  </div>
                )}
              </div>
            </div>

            {/* Success rate bar */}
            <div className="flex items-center gap-2 mt-1">
              <div className="flex-1 h-1 bg-zinc-700/50 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full ${stat.successRate >= 0.8 ? 'bg-green-500' : stat.successRate >= 0.5 ? 'bg-amber-500' : 'bg-red-500'}`}
                  style={{ width: `${stat.successRate * 100}%` }}
                />
              </div>
              <span className="text-[10px] text-zinc-500 w-8 text-right">
                {(stat.successRate * 100).toFixed(0)}%
              </span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
