// ============================================================================
// Overview Tab - 概览统计
// 2026-07-27 评测中心 v2：文案改走 i18n（t.telemetry.stats / t.telemetry.intents），
// 随 EvalTelemetryTab 内嵌进评测中心「遥测」tab。
// ============================================================================

import React from 'react';
import type {
  TelemetrySession,
  TelemetryToolStat,
  TelemetryIntentStat,
} from '@shared/contract/telemetry';
import { Activity, Cpu, Wrench, AlertTriangle } from 'lucide-react';
import { useI18n } from '../../../hooks/useI18n';

interface OverviewTabProps {
  session: TelemetrySession;
  toolStats: TelemetryToolStat[];
  intentDistribution: TelemetryIntentStat[];
}

const StatCard: React.FC<{
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string | number;
  iconColor?: string;
}> = ({ icon: Icon, label, value, iconColor = 'text-zinc-400' }) => (
  <div className="p-3 bg-zinc-800 rounded-lg border border-zinc-800">
    <div className="flex items-center gap-2 mb-1">
      <Icon className={`w-4 h-4 ${iconColor}`} />
      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
    </div>
    <p className="text-lg font-semibold text-zinc-200">{value}</p>
  </div>
);

export const OverviewTab: React.FC<OverviewTabProps> = ({ session, toolStats, intentDistribution }) => {
  const { t } = useI18n();
  const s = t.telemetry.stats;
  const intentLabels = t.telemetry.intents as Record<string, string>;

  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  };

  return (
    <div className="space-y-4">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard icon={Activity} label={s.turnCount} value={session.turnCount} iconColor="text-blue-400" />
        <StatCard icon={Cpu} label={s.totalTokens} value={formatTokens(session.totalTokens)} iconColor="text-cyan-400" />
        <StatCard icon={Wrench} label={s.toolCalls} value={session.totalToolCalls} iconColor="text-badge-success" />
        <StatCard icon={AlertTriangle} label={s.errorCount} value={session.totalErrors} iconColor="text-badge-danger" />
      </div>

      {/* Intent Distribution */}
      {intentDistribution.length > 0 && (
        <div className="p-3 bg-zinc-800 rounded-lg border border-zinc-800">
          <h4 className="text-xs font-medium text-zinc-400 mb-2">{s.intentDistribution}</h4>
          <div className="space-y-1.5">
            {intentDistribution.map((item) => (
              <div key={item.intent} className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400 w-16 truncate">
                  {intentLabels[item.intent] ?? item.intent}
                </span>
                <div className="flex-1 h-3 bg-zinc-900 rounded-full overflow-hidden">
                  <div
                    className="h-full bg-blue-500/40 rounded-full"
                    style={{ width: `${item.percentage * 100}%` }}
                  />
                </div>
                <span className="text-[10px] text-zinc-500 w-6 text-right">{item.count}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Tool Success Rate */}
      {toolStats.length > 0 && (
        <div className="p-3 bg-zinc-800 rounded-lg border border-zinc-800">
          <h4 className="text-xs font-medium text-zinc-400 mb-2">{s.toolSuccessRate}</h4>
          <div className="space-y-1.5">
            {toolStats.slice(0, 8).map((stat) => (
              <div key={stat.name} className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-zinc-400 w-20 truncate">{stat.name}</span>
                <div className="flex-1 h-3 bg-zinc-900 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full ${
                      stat.successRate >= 0.8 ? 'bg-green-500/40' : stat.successRate >= 0.5 ? 'bg-amber-500/40' : 'bg-red-500/40'
                    }`}
                    style={{ width: `${stat.successRate * 100}%` }}
                  />
                </div>
                <span className="text-[10px] text-zinc-500 w-8 text-right">
                  {(stat.successRate * 100).toFixed(0)}%
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
