// ============================================================================
// OverviewSection - 概览 Tab（合并客观指标 + 工具洞察 + 意图分布）
// ============================================================================

import React from 'react';
import type { ObjectiveMetrics } from '@shared/types/sessionAnalytics';

interface EventSummary {
  eventStats: Record<string, number>;
  toolCalls: Array<{ name: string; success: boolean; duration?: number }>;
  thinkingContent: string[];
  errorEvents: Array<{ type: string; message: string }>;
  timeline: Array<{ time: number; type: string; summary: string }>;
}

interface OverviewSectionProps {
  objective: ObjectiveMetrics | null;
  eventSummary: EventSummary | null;
}

const formatDuration = (ms: number): string => {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  if (m > 0) return `${m}m ${s % 60}s`;
  return `${s}s`;
};

function StatCard({ label, value, icon, color }: {
  label: string;
  value: string;
  icon: string;
  color?: 'green' | 'yellow' | 'red';
}) {
  const colorClass = color === 'green'
    ? 'text-green-400'
    : color === 'yellow'
    ? 'text-yellow-400'
    : color === 'red'
    ? 'text-red-400'
    : 'text-white';

  return (
    <div className="bg-zinc-800/30 rounded-lg p-3 text-center">
      <div className="text-lg mb-1">{icon}</div>
      <div className={`text-lg font-semibold ${colorClass}`}>{value}</div>
      <div className="text-xs text-gray-500">{label}</div>
    </div>
  );
}

export const OverviewSection: React.FC<OverviewSectionProps> = ({ objective, eventSummary }) => {
  if (!objective) {
    return (
      <div className="flex items-center justify-center p-12">
        <div className="animate-spin w-6 h-6 border-2 border-amber-500 border-t-transparent rounded-full mr-3" />
        <span className="text-gray-300 text-sm">加载指标数据...</span>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* 基础统计 */}
      <div>
        <h3 className="text-xs font-medium text-gray-400 mb-2">基础统计</h3>
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="会话时长" value={formatDuration(objective.duration)} icon="⏱️" />
          <StatCard label="交互轮次" value={objective.turnsCount.toString()} icon="💬" />
          <StatCard label="工具调用" value={objective.totalToolCalls.toString()} icon="🔧" />
          <StatCard
            label="成功率"
            value={`${objective.toolSuccessRate}%`}
            icon="✅"
            color={objective.toolSuccessRate >= 80 ? 'green' : objective.toolSuccessRate >= 60 ? 'yellow' : 'red'}
          />
        </div>
      </div>

      {/* Token & 成本 */}
      <div>
        <h3 className="text-xs font-medium text-gray-400 mb-2">Token & 成本</h3>
        <div className="grid grid-cols-4 gap-3">
          <StatCard label="输入 Token" value={objective.totalInputTokens.toLocaleString()} icon="📥" />
          <StatCard label="输出 Token" value={objective.totalOutputTokens.toLocaleString()} icon="📤" />
          <StatCard label="代码块" value={objective.codeBlocksGenerated.toString()} icon="💻" />
          <StatCard label="预估成本" value={`$${objective.estimatedCost.toFixed(4)}`} icon="💰" />
        </div>
      </div>

      {/* 工具洞察（合并工具分布 + 成功率） */}
      {Object.keys(objective.toolCallsByName).length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-gray-400 mb-2">工具洞察</h3>
          <div className="bg-zinc-800/30 rounded-lg p-3">
            <div className="flex flex-wrap gap-2">
              {Object.entries(objective.toolCallsByName)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 12)
                .map(([name, count]) => (
                  <span
                    key={name}
                    className="text-xs px-2 py-1 rounded bg-zinc-700/50 text-gray-300"
                  >
                    {name}: {count}
                  </span>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* 意图分布 */}
      {objective.intentDistribution && Object.keys(objective.intentDistribution).length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-gray-400 mb-2">意图分布</h3>
          <div className="bg-zinc-800/30 rounded-lg p-3">
            <div className="flex flex-wrap gap-2">
              {Object.entries(objective.intentDistribution!)
                .sort((a, b) => b[1] - a[1])
                .map(([intent, count]) => (
                  <span
                    key={intent}
                    className="text-xs px-2 py-1 rounded bg-blue-500/20 text-blue-300"
                  >
                    {intent}: {count}
                  </span>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* 错误分类 */}
      {objective.errorTaxonomy && Object.keys(objective.errorTaxonomy).length > 0 && (
        <div>
          <h3 className="text-xs font-medium text-gray-400 mb-2">错误分类</h3>
          <div className="bg-red-500/10 border border-red-500/30 rounded-lg p-3">
            <div className="flex flex-wrap gap-2">
              {Object.entries(objective.errorTaxonomy!)
                .sort((a, b) => b[1] - a[1])
                .map(([type, count]) => (
                  <span
                    key={type}
                    className="text-xs px-2 py-1 rounded bg-red-500/20 text-red-300"
                  >
                    {type}: {count}
                  </span>
                ))}
            </div>
          </div>
        </div>
      )}

      {/* SSE 事件流摘要 */}
      {eventSummary && (
        <div>
          <h3 className="text-xs font-medium text-gray-400 mb-2">SSE 事件流</h3>
          <div className="bg-zinc-800/30 rounded-lg p-3 space-y-2">
            <div className="flex flex-wrap gap-2">
              {Object.entries(eventSummary.eventStats)
                .sort((a, b) => b[1] - a[1])
                .slice(0, 8)
                .map(([type, count]) => (
                  <span
                    key={type}
                    className="text-xs px-2 py-1 rounded bg-indigo-500/20 text-indigo-300"
                  >
                    {type}: {count}
                  </span>
                ))}
            </div>

            {eventSummary.errorEvents.length > 0 && (
              <div className="text-xs text-red-400">
                {eventSummary.errorEvents.length} 个错误事件
              </div>
            )}
          </div>
        </div>
      )}

      {/* 自修复率 */}
      {(objective.selfRepairRate ?? 0) > 0 && (
        <div className="bg-zinc-800/30 rounded-lg p-3 flex items-center justify-between">
          <span className="text-xs text-gray-400">自修复率</span>
          <span className="text-sm font-medium text-green-400">
            {((objective.selfRepairRate ?? 0) * 100).toFixed(0)}%
          </span>
        </div>
      )}
    </div>
  );
};
