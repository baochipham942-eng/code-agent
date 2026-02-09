// ============================================================================
// GraderCard - 单个 Grader 卡片（对标 SpreadsheetBench Viewer）
// ============================================================================

import React from 'react';
import type { EvaluationMetric } from '../../../../shared/types/evaluation';
import {
  DIMENSION_NAMES,
  DIMENSION_ICONS,
  DIMENSION_WEIGHTS,
} from '../../../../shared/types/evaluation';

type Verdict = 'PASS' | 'FAIL' | 'PARTIAL' | 'SKIP' | 'INFO';

function getVerdict(metric: EvaluationMetric): Verdict {
  if (metric.informational) return 'INFO';
  if (metric.score >= 80) return 'PASS';
  if (metric.score >= 60) return 'PARTIAL';
  if (metric.score === 0 && !metric.details?.reason) return 'SKIP';
  return 'FAIL';
}

const VERDICT_BORDER: Record<Verdict, string> = {
  PASS: 'border-t-green-500/60',
  FAIL: 'border-t-red-500/60',
  PARTIAL: 'border-t-yellow-500/60',
  SKIP: 'border-t-zinc-600/60',
  INFO: 'border-t-blue-500/60',
};

const VERDICT_BADGE: Record<Verdict, string> = {
  PASS: 'bg-green-500/20 text-green-400',
  FAIL: 'bg-red-500/20 text-red-400',
  PARTIAL: 'bg-yellow-500/20 text-yellow-400',
  SKIP: 'bg-zinc-500/20 text-zinc-400',
  INFO: 'bg-blue-500/20 text-blue-400',
};

interface GraderCardProps {
  metric: EvaluationMetric;
}

export const GraderCard: React.FC<GraderCardProps> = ({ metric }) => {
  const verdict = getVerdict(metric);
  const icon = DIMENSION_ICONS[metric.dimension] || '📊';
  const name = DIMENSION_NAMES[metric.dimension] || metric.dimension;
  const weight = DIMENSION_WEIGHTS[metric.dimension];
  const weightStr = weight ? `${Math.round(weight * 100)}%` : '';
  const reason = metric.details?.reason as string | undefined;
  const truncatedReason = reason
    ? reason.length > 80 ? reason.slice(0, 77) + '...' : reason
    : '';

  return (
    <div
      className={`bg-zinc-800/40 rounded-lg border border-zinc-700/30 border-t-2 ${VERDICT_BORDER[verdict]} p-3 flex flex-col justify-between min-h-[100px]`}
    >
      {/* Header: icon + name + weight */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <div className="flex items-center gap-1.5">
            <span className="text-sm">{icon}</span>
            <span className="text-xs font-medium text-zinc-200">{name}</span>
          </div>
          {weightStr && (
            <span className="text-[10px] text-zinc-500">{weightStr}</span>
          )}
        </div>

        {/* Description */}
        {truncatedReason && (
          <p className="text-[11px] text-zinc-500 leading-relaxed mb-2">
            {truncatedReason}
          </p>
        )}
      </div>

      {/* Verdict badge */}
      <div className="flex justify-end">
        <span
          className={`text-[10px] font-bold px-2 py-0.5 rounded ${VERDICT_BADGE[verdict]}`}
        >
          {verdict}
        </span>
      </div>
    </div>
  );
};
