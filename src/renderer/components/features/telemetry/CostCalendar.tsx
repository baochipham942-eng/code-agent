// ============================================================================
// Cost Calendar - 成本日历聚合（日/周/月趋势图，跨会话）
// 数据来自 telemetry:get-cost-by-period（GROUP BY date(start_time) 读侧聚合）
// ============================================================================

import React, { useEffect, useMemo, useState } from 'react';
import {
  ResponsiveContainer,
  BarChart, Bar,
  XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { DollarSign } from 'lucide-react';
import { useTelemetryStore } from '../../../stores/telemetryStore';
import type { TelemetryCostGranularity } from '@shared/contract/telemetry';
import type { AdminUserScopeValue } from '../admin/AdminUserScopeSelect';

const GRANULARITIES: Array<{ id: TelemetryCostGranularity; label: string; limit: number }> = [
  { id: 'day', label: '日', limit: 30 },
  { id: 'week', label: '周', limit: 12 },
  { id: 'month', label: '月', limit: 12 },
];

const tooltipStyle = {
  contentStyle: {
    backgroundColor: '#27272a',
    border: '1px solid #3f3f46',
    borderRadius: '0.5rem',
    fontSize: '11px',
  },
  labelStyle: { color: '#a1a1aa' },
};

function formatCost(value: number): string {
  return `$${value.toFixed(value < 1 ? 4 : 2)}`;
}

export const CostCalendar: React.FC<{ userScope: AdminUserScopeValue }> = ({ userScope }) => {
  const [granularity, setGranularity] = useState<TelemetryCostGranularity>('day');
  const costBuckets = useTelemetryStore((s) => s.costBuckets);
  const loadCostByPeriod = useTelemetryStore((s) => s.loadCostByPeriod);

  useEffect(() => {
    const cfg = GRANULARITIES.find((g) => g.id === granularity)!;
    loadCostByPeriod({ granularity, limit: cfg.limit, ...userScope });
  }, [granularity, userScope, loadCostByPeriod]);

  const { totalCost, totalSessions, totalTokens } = useMemo(() => {
    return costBuckets.reduce(
      (acc, b) => ({
        totalCost: acc.totalCost + b.cost,
        totalSessions: acc.totalSessions + b.sessions,
        totalTokens: acc.totalTokens + b.tokens,
      }),
      { totalCost: 0, totalSessions: 0, totalTokens: 0 },
    );
  }, [costBuckets]);

  const hasData = costBuckets.some((b) => b.cost > 0 || b.sessions > 0);

  return (
    <div className="rounded-lg border border-zinc-700/70 bg-zinc-800/40 p-3 mb-3">
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-1.5 text-xs font-medium text-zinc-400">
          <DollarSign className="w-3.5 h-3.5" />
          成本日历
        </div>
        <div className="flex items-center gap-1">
          {GRANULARITIES.map((g) => (
            <button
              key={g.id}
              onClick={() => setGranularity(g.id)}
              className={`text-[10px] px-2 py-0.5 rounded transition-colors ${
                granularity === g.id
                  ? 'bg-blue-500/20 text-blue-400'
                  : 'bg-zinc-700/50 text-zinc-500 hover:text-zinc-400'
              }`}
            >
              {g.label}
            </button>
          ))}
        </div>
      </div>

      {/* 区间汇总 */}
      <div className="flex items-center gap-4 mb-2 text-[10px] text-zinc-500">
        <span>区间总成本 <span className="text-zinc-300 font-medium">{formatCost(totalCost)}</span></span>
        <span>{totalSessions} 会话</span>
        <span>{Math.round(totalTokens / 1000)}K tokens</span>
      </div>

      {hasData ? (
        <ResponsiveContainer width="100%" height={140}>
          <BarChart data={costBuckets} margin={{ top: 4, right: 4, left: -16, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#3f3f46" vertical={false} />
            <XAxis
              dataKey="period"
              tick={{ fontSize: 9, fill: '#71717a' }}
              tickFormatter={(v: string) => (granularity === 'day' ? v.slice(5) : v)}
              interval="preserveStartEnd"
            />
            <YAxis tick={{ fontSize: 9, fill: '#71717a' }} tickFormatter={(v: number) => `$${v}`} width={44} />
            <Tooltip
              {...tooltipStyle}
              formatter={(value) => [formatCost(typeof value === 'number' ? value : Number(value)), '成本']}
            />
            <Bar dataKey="cost" fill="#3b82f6" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      ) : (
        <div className="text-center text-zinc-600 text-[11px] py-8">该区间暂无成本数据</div>
      )}
    </div>
  );
};
