// ============================================================================
// MetricCard - 评测指标卡片组件
// ============================================================================

import React, { useState } from 'react';
import type { EvaluationMetric } from '../../../../shared/types/evaluation';
import {
  DIMENSION_NAMES,
  DIMENSION_ICONS,
  scoreToGrade,
  GRADE_COLORS,
  GRADE_BG_COLORS,
} from '../../../../shared/types/evaluation';

interface MetricCardProps {
  metric: EvaluationMetric;
}

export function MetricCard({ metric }: MetricCardProps) {
  const [expanded, setExpanded] = useState(false);

  const name = DIMENSION_NAMES[metric.dimension];
  const icon = DIMENSION_ICONS[metric.dimension];
  const grade = scoreToGrade(metric.score);
  const gradeColor = GRADE_COLORS[grade];
  const gradeBg = GRADE_BG_COLORS[grade];

  const getProgressColor = (score: number): string => {
    if (score >= 80) return 'bg-green-500';
    if (score >= 60) return 'bg-blue-500';
    if (score >= 40) return 'bg-yellow-500';
    return 'bg-red-500';
  };

  return (
    <div
      className={`
        rounded-lg border border-zinc-700/50 p-3
        transition-all cursor-pointer
        hover:border-zinc-600
        ${expanded ? 'col-span-2' : ''}
      `}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <span className="text-lg">{icon}</span>
          <span className="text-sm font-medium text-gray-200">{name}</span>
        </div>
        <div className={`${gradeColor} ${gradeBg} px-2 py-0.5 rounded text-xs font-bold`}>
          {grade}
        </div>
      </div>

      <div className="mb-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-2xl font-bold text-white">{metric.score}</span>
          <span className="text-xs text-gray-500">权重 {(metric.weight * 100).toFixed(0)}%</span>
        </div>
        <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
          <div
            className={`h-full ${getProgressColor(metric.score)} rounded-full transition-all`}
            style={{ width: `${metric.score}%` }}
          />
        </div>
      </div>

      {expanded && (
        <div className="mt-3 pt-3 border-t border-zinc-700/50 space-y-2">
          {metric.subMetrics.map((sub, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className="text-gray-400">{sub.name}</span>
              <span className="text-gray-200">
                {sub.value}
                {sub.unit && <span className="text-gray-500 ml-0.5">{sub.unit}</span>}
              </span>
            </div>
          ))}

          {metric.suggestions && metric.suggestions.length > 0 && (
            <div className="mt-2 pt-2 border-t border-zinc-700/30">
              <div className="text-xs text-gray-500 mb-1">改进建议</div>
              {metric.suggestions.map((suggestion, i) => (
                <div key={i} className="text-xs text-gray-400 pl-2 border-l-2 border-yellow-500/50">
                  {suggestion}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="mt-2 text-center">
        <span className="text-xs text-gray-600">
          {expanded ? '点击收起' : '点击展开详情'}
        </span>
      </div>
    </div>
  );
}
