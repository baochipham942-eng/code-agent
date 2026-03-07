// ============================================================================
// ReplayAnalyticsSidebar - 回放分析侧边栏
// ============================================================================

import React from 'react';
import type { ObjectiveMetrics } from '@shared/types/sessionAnalytics';

interface ReplaySummary {
  totalTurns: number;
  toolDistribution: Record<string, number>;
  thinkingRatio: number;
  selfRepairChains: number;
  totalDurationMs: number;
}

interface Props {
  summary: ReplaySummary | null;
  objective: ObjectiveMetrics | null;
}

const CATEGORY_COLORS: Record<string, string> = {
  Read: '#60a5fa',
  Edit: '#facc15',
  Write: '#4ade80',
  Bash: '#fb923c',
  Search: '#a78bfa',
  Web: '#22d3ee',
  Agent: '#f472b6',
  Skill: '#818cf8',
  Other: '#a1a1aa',
};

export const ReplayAnalyticsSidebar: React.FC<Props> = ({ summary, objective }) => {
  if (!summary) {
    return (
      <div className="p-3 text-xs text-zinc-600">
        加载中...
      </div>
    );
  }

  const totalTools = Object.values(summary.toolDistribution).reduce((a, b) => a + b, 0);
  const sortedTools = Object.entries(summary.toolDistribution)
    .filter(([, v]) => v > 0)
    .sort(([, a], [, b]) => b - a);

  const durationStr = summary.totalDurationMs >= 60000
    ? `${(summary.totalDurationMs / 60000).toFixed(1)}m`
    : `${(summary.totalDurationMs / 1000).toFixed(1)}s`;

  return (
    <div className="p-3 space-y-4 text-xs">
      {/* Overview */}
      <div>
        <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2 font-medium">Overview</div>
        <div className="grid grid-cols-2 gap-2">
          <MetricCard label="Turns" value={String(summary.totalTurns)} />
          <MetricCard label="Duration" value={durationStr} />
          <MetricCard label="Tools" value={String(totalTools)} />
          <MetricCard label="Self-Repair" value={String(summary.selfRepairChains)} />
        </div>
      </div>

      {/* Tool Distribution */}
      {sortedTools.length > 0 && (
        <div>
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2 font-medium">Tool Distribution</div>
          <div className="space-y-1.5">
            {sortedTools.map(([cat, count]) => {
              const pct = totalTools > 0 ? (count / totalTools) * 100 : 0;
              const color = CATEGORY_COLORS[cat] || CATEGORY_COLORS.Other;
              return (
                <div key={cat}>
                  <div className="flex items-center justify-between mb-0.5">
                    <span className="text-zinc-400">{cat}</span>
                    <span className="text-zinc-500">{count} ({pct.toFixed(0)}%)</span>
                  </div>
                  <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className="h-full rounded-full transition-all"
                      style={{ width: `${pct}%`, backgroundColor: color }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Thinking Ratio */}
      <div>
        <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2 font-medium">Thinking Ratio</div>
        <div className="flex items-center gap-2">
          <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden flex-1">
            <div
              className="h-full bg-violet-500 rounded-full"
              style={{ width: `${(summary.thinkingRatio * 100).toFixed(0)}%` }}
            />
          </div>
          <span className="text-zinc-400 shrink-0">{(summary.thinkingRatio * 100).toFixed(1)}%</span>
        </div>
      </div>

      {/* Objective Metrics (from existing pipeline) */}
      {objective && (
        <>
          {objective.selfRepairRate !== undefined && (
            <div>
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2 font-medium">Self Repair Rate</div>
              <div className="flex items-center gap-2">
                <div className="h-1.5 bg-zinc-800 rounded-full overflow-hidden flex-1">
                  <div
                    className="h-full bg-emerald-500 rounded-full"
                    style={{ width: `${(objective.selfRepairRate * 100).toFixed(0)}%` }}
                  />
                </div>
                <span className="text-zinc-400 shrink-0">{(objective.selfRepairRate * 100).toFixed(1)}%</span>
              </div>
            </div>
          )}

          {/* Error Taxonomy */}
          {objective.errorTaxonomy && Object.keys(objective.errorTaxonomy).length > 0 && (
            <div>
              <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2 font-medium">Error Types</div>
              <div className="space-y-1">
                {Object.entries(objective.errorTaxonomy)
                  .filter(([, v]) => v > 0)
                  .sort(([, a], [, b]) => b - a)
                  .slice(0, 5)
                  .map(([type, count]) => (
                    <div key={type} className="flex items-center justify-between">
                      <span className="text-zinc-400 truncate mr-2">{type}</span>
                      <span className="text-red-400 shrink-0">{count}</span>
                    </div>
                  ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
};

const MetricCard: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="bg-zinc-800/30 rounded-lg p-2 border border-zinc-700/20">
    <div className="text-[10px] text-zinc-500 mb-0.5">{label}</div>
    <div className="text-sm text-zinc-200 font-medium">{value}</div>
  </div>
);
