import React, { useMemo } from 'react';
import type { TestRunReport } from '@shared/ipc';

interface Props {
  report: TestRunReport;
}

interface CategoryStat {
  name: string;
  total: number;
  passed: number;
  partial: number;
  failed: number;
  rate: number;
}

export const TestResultsChart: React.FC<Props> = ({ report }) => {
  const categories = useMemo(() => {
    const map = new Map<string, { total: number; passed: number; partial: number; failed: number }>();

    for (const r of report.results) {
      // Extract category from testId prefix (before first dash) or use 'other'
      const cat = r.category || r.testId.split('-')[0] || 'other';
      const entry = map.get(cat) || { total: 0, passed: 0, partial: 0, failed: 0 };
      entry.total++;
      if (r.status === 'passed') entry.passed++;
      else if (r.status === 'partial') entry.partial++;
      else if (r.status === 'failed') entry.failed++;
      map.set(cat, entry);
    }

    const result: CategoryStat[] = [];
    for (const [name, stats] of map) {
      result.push({
        name,
        ...stats,
        rate: stats.total > 0 ? (stats.passed + stats.partial * 0.5) / stats.total : 0,
      });
    }

    return result.sort((a, b) => b.total - a.total).slice(0, 12);
  }, [report]);

  if (categories.length === 0) return null;

  const maxTotal = Math.max(...categories.map(c => c.total));
  const barHeight = 20;
  const gap = 4;
  const labelWidth = 80;
  const chartWidth = 700;
  const barAreaWidth = chartWidth - labelWidth - 40;
  const svgHeight = categories.length * (barHeight + gap) + 8;

  return (
    <div className="bg-surface border border-border-default/20 rounded-lg p-3">
      <div className="text-xs font-medium text-text-secondary mb-2">分类通过率</div>
      <div className="overflow-x-auto">
        <svg width={chartWidth} height={svgHeight} className="text-xs">
          {categories.map((cat, i) => {
            const y = i * (barHeight + gap) + 4;
            const passedWidth = maxTotal > 0 ? (cat.passed / maxTotal) * barAreaWidth : 0;
            const partialWidth = maxTotal > 0 ? (cat.partial / maxTotal) * barAreaWidth : 0;
            const failedWidth = maxTotal > 0 ? (cat.failed / maxTotal) * barAreaWidth : 0;

            return (
              <g key={cat.name}>
                {/* Label */}
                <text
                  x={labelWidth - 4}
                  y={y + barHeight / 2 + 4}
                  textAnchor="end"
                  className="fill-text-secondary"
                  fontSize={11}
                >
                  {cat.name}
                </text>
                {/* Background */}
                <rect
                  x={labelWidth}
                  y={y}
                  width={barAreaWidth}
                  height={barHeight}
                  rx={3}
                  className="fill-hover"
                />
                {/* Passed */}
                <rect
                  x={labelWidth}
                  y={y}
                  width={passedWidth}
                  height={barHeight}
                  rx={passedWidth > 0 ? 3 : 0}
                  className="fill-emerald-500/60"
                />
                {/* Partial */}
                <rect
                  x={labelWidth + passedWidth}
                  y={y}
                  width={partialWidth}
                  height={barHeight}
                  className="fill-amber-500/60"
                />
                {/* Failed */}
                <rect
                  x={labelWidth + passedWidth + partialWidth}
                  y={y}
                  width={failedWidth}
                  height={barHeight}
                  className="fill-red-500/60"
                />
                {/* Rate label */}
                <text
                  x={labelWidth + barAreaWidth + 4}
                  y={y + barHeight / 2 + 4}
                  className="fill-text-tertiary"
                  fontSize={10}
                >
                  {Math.round(cat.rate * 100)}%
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
};
