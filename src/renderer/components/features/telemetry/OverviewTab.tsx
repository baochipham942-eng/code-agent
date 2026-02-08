// ============================================================================
// Overview Tab - 概览统计
// ============================================================================

import React from 'react';
import type {
  TelemetrySession,
  TelemetryToolStat,
  TelemetryIntentStat,
} from '@shared/types/telemetry';
import { Activity, Cpu, Wrench, AlertTriangle } from 'lucide-react';

interface OverviewTabProps {
  session: TelemetrySession;
  toolStats: TelemetryToolStat[];
  intentDistribution: TelemetryIntentStat[];
}

const INTENT_LABELS: Record<string, string> = {
  code_generation: '代码生成',
  bug_fix: '修复 Bug',
  code_review: '代码审查',
  explanation: '解释',
  refactoring: '重构',
  file_operation: '文件操作',
  search: '搜索',
  conversation: '对话',
  planning: '规划',
  multi_step_task: '多步任务',
  testing: '测试',
  documentation: '文档',
  configuration: '配置',
  research: '研究',
  unknown: '未知',
};

const StatCard: React.FC<{
  icon: React.FC<{ className?: string }>;
  label: string;
  value: string | number;
  iconColor?: string;
}> = ({ icon: Icon, label, value, iconColor = 'text-zinc-400' }) => (
  <div className="p-3 bg-zinc-800/50 rounded-lg border border-zinc-700/30">
    <div className="flex items-center gap-2 mb-1">
      <Icon className={`w-4 h-4 ${iconColor}`} />
      <span className="text-[10px] text-zinc-500 uppercase tracking-wider">{label}</span>
    </div>
    <p className="text-lg font-semibold text-zinc-200">{value}</p>
  </div>
);

export const OverviewTab: React.FC<OverviewTabProps> = ({ session, toolStats, intentDistribution }) => {
  const formatTokens = (n: number) => {
    if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
    if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
    return String(n);
  };

  return (
    <div className="space-y-4">
      {/* Stat Cards */}
      <div className="grid grid-cols-2 gap-2">
        <StatCard icon={Activity} label="轮次数" value={session.turnCount} iconColor="text-blue-400" />
        <StatCard icon={Cpu} label="Token 总量" value={formatTokens(session.totalTokens)} iconColor="text-cyan-400" />
        <StatCard icon={Wrench} label="工具调用" value={session.totalToolCalls} iconColor="text-green-400" />
        <StatCard icon={AlertTriangle} label="错误数" value={session.totalErrors} iconColor="text-red-400" />
      </div>

      {/* Intent Distribution */}
      {intentDistribution.length > 0 && (
        <div className="p-3 bg-zinc-800/30 rounded-lg border border-zinc-700/30">
          <h4 className="text-xs font-medium text-zinc-400 mb-2">意图分布</h4>
          <div className="space-y-1.5">
            {intentDistribution.map((item) => (
              <div key={item.intent} className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400 w-16 truncate">
                  {INTENT_LABELS[item.intent] ?? item.intent}
                </span>
                <div className="flex-1 h-3 bg-zinc-900/50 rounded-full overflow-hidden">
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
        <div className="p-3 bg-zinc-800/30 rounded-lg border border-zinc-700/30">
          <h4 className="text-xs font-medium text-zinc-400 mb-2">工具成功率</h4>
          <div className="space-y-1.5">
            {toolStats.slice(0, 8).map((stat) => (
              <div key={stat.name} className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-zinc-400 w-20 truncate">{stat.name}</span>
                <div className="flex-1 h-3 bg-zinc-900/50 rounded-full overflow-hidden">
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
