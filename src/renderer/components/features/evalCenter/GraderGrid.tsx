// ============================================================================
// GraderGrid - 3 列 Grader Card 网格（对标 SpreadsheetBench Viewer）
// ============================================================================

import React from 'react';
import type { EvaluationMetric } from '../../../../shared/types/evaluation';
import { V3_SCORING_DIMENSIONS, V3_INFO_DIMENSIONS } from '../../../../shared/types/evaluation';
import { GraderCard } from './GraderCard';
import { CollapsibleSection } from './CollapsibleSection';

interface GraderGridProps {
  metrics: EvaluationMetric[];
}

export const GraderGrid: React.FC<GraderGridProps> = ({ metrics }) => {
  if (metrics.length === 0) return null;

  // Sort: scoring dimensions first (by V3_SCORING_DIMENSIONS order), then info
  const dimensionOrder = [...V3_SCORING_DIMENSIONS, ...V3_INFO_DIMENSIONS];
  const sorted = [...metrics].sort((a, b) => {
    const ia = dimensionOrder.indexOf(a.dimension);
    const ib = dimensionOrder.indexOf(b.dimension);
    return (ia === -1 ? 999 : ia) - (ib === -1 ? 999 : ib);
  });

  return (
    <CollapsibleSection title="GRADER 评分卡" defaultOpen>
      <div className="grid grid-cols-3 gap-2.5">
        {sorted.map((metric) => (
          <GraderCard key={metric.dimension} metric={metric} />
        ))}
      </div>
    </CollapsibleSection>
  );
};
