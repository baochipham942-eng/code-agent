import React, { useMemo, useState } from 'react';
import type { TestRunReport, TestCaseResult } from '@shared/ipc';

interface Props {
  reports: TestRunReport[];
}

interface CellData {
  status: TestCaseResult['status'] | null;
  score: number | null;
}

interface TooltipInfo {
  caseId: string;
  roundLabel: string;
  score: number | null;
  status: TestCaseResult['status'] | null;
  description?: string;
  failureReason?: string;
  x: number;
  y: number;
}

function getCellColor(status: TestCaseResult['status'] | null, score: number | null): string {
  if (status === null || score === null) return 'bg-zinc-700/60';
  if (status === 'passed') return 'bg-emerald-500/80';
  if (status === 'partial') {
    if (score >= 0.7) return 'bg-amber-400/80';
    return 'bg-amber-600/80';
  }
  return 'bg-red-500/70';
}

function getScoreLabel(score: number | null): string {
  if (score === null) return '—';
  return `${Math.round(score * 100)}%`;
}

export const ScoreHeatmap: React.FC<Props> = ({ reports }) => {
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);

  // Sorted reports: oldest → newest = R1 → Rn
  const sortedReports = useMemo(
    () => [...reports].sort((a, b) => a.startTime - b.startTime),
    [reports]
  );

  // Union of all case IDs, preserving insertion order
  const allCaseIds = useMemo(() => {
    const seen = new Set<string>();
    const ids: string[] = [];
    for (const report of sortedReports) {
      for (const r of report.results) {
        if (!seen.has(r.testId)) {
          seen.add(r.testId);
          ids.push(r.testId);
        }
      }
    }
    return ids.sort();
  }, [sortedReports]);

  // Build lookup: reportIndex → caseId → result
  const lookup = useMemo(() => {
    return sortedReports.map((report) => {
      const map = new Map<string, TestCaseResult>();
      for (const r of report.results) {
        map.set(r.testId, r);
      }
      return map;
    });
  }, [sortedReports]);

  // Per-case stats across rounds
  const caseStats = useMemo(() => {
    return allCaseIds.map((caseId) => {
      const scores = sortedReports
        .map((_, i) => lookup[i].get(caseId)?.score)
        .filter((s): s is number => s !== undefined);
      const avg = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : null;
      const std =
        scores.length > 1
          ? Math.sqrt(
              scores.reduce((sum, s) => sum + Math.pow(s - (avg ?? 0), 2), 0) / scores.length
            )
          : null;
      return { caseId, avg, std };
    });
  }, [allCaseIds, sortedReports, lookup]);

  const handleMouseEnter = (
    e: React.MouseEvent<HTMLTableCellElement>,
    caseId: string,
    roundLabel: string,
    cell: CellData,
    description?: string,
    failureReason?: string
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    setTooltip({
      caseId,
      roundLabel,
      score: cell.score,
      status: cell.status,
      description,
      failureReason,
      x: rect.left + rect.width / 2,
      y: rect.top - 8,
    });
  };

  if (reports.length < 2) {
    return (
      <div className="flex items-center justify-center py-6 text-zinc-500 text-xs">
        需要至少 2 轮报告才能显示热力图
      </div>
    );
  }

  return (
    <div className="bg-zinc-800 border border-zinc-700/20 rounded-lg overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700/20">
        <span className="text-xs font-medium text-zinc-400">分数热力图</span>
        <span className="text-[10px] text-zinc-500 ml-1">
          {allCaseIds.length} 用例 × {sortedReports.length} 轮
        </span>
        <div className="ml-auto flex items-center gap-2 text-[10px] text-zinc-500">
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-emerald-500/80 inline-block" />通过
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-amber-500/80 inline-block" />部分
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-red-500/70 inline-block" />失败
          </span>
          <span className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-sm bg-zinc-700/60 inline-block" />未测
          </span>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="text-[10px] text-zinc-400 border-collapse w-full">
          <thead>
            <tr>
              <th className="px-2 py-1.5 text-left font-medium text-zinc-500 sticky left-0 bg-zinc-700 backdrop-blur z-10 min-w-[100px]">
                用例
              </th>
              {sortedReports.map((_, i) => (
                <th key={i} className="px-1.5 py-1.5 text-center font-medium text-zinc-400 min-w-[44px]">
                  R{i + 1}
                </th>
              ))}
              <th className="px-1.5 py-1.5 text-center font-medium text-blue-400/80 min-w-[44px]">
                均值
              </th>
              <th className="px-1.5 py-1.5 text-center font-medium text-orange-400/80 min-w-[44px]">
                标准差
              </th>
            </tr>
          </thead>
          <tbody>
            {allCaseIds.map((caseId, rowIdx) => {
              const { avg, std } = caseStats[rowIdx];
              const isHighStd = std !== null && std > 0.2; // std > 0.2 (=20% on 0-1 scale)

              return (
                <tr key={caseId} className="border-t border-zinc-700/10 hover:bg-zinc-800">
                  <td className="px-2 py-1 font-mono text-zinc-400 sticky left-0 bg-zinc-900 backdrop-blur z-10 truncate max-w-[120px]">
                    {caseId}
                  </td>
                  {sortedReports.map((_report, roundIdx) => {
                    const result = lookup[roundIdx].get(caseId);
                    const cell: CellData = result
                      ? { status: result.status, score: result.score }
                      : { status: null, score: null };
                    const color = getCellColor(cell.status, cell.score);

                    return (
                      <td
                        key={roundIdx}
                        className={`px-1 py-1 text-center cursor-pointer transition-opacity hover:opacity-80 ${color} rounded-sm mx-0.5`}
                        onMouseEnter={(e) =>
                          handleMouseEnter(
                            e,
                            caseId,
                            `R${roundIdx + 1}`,
                            cell,
                            result?.description,
                            result?.failureReason
                          )
                        }
                        onMouseLeave={() => setTooltip(null)}
                      >
                        <span className="text-white/90 font-medium">
                          {getScoreLabel(cell.score)}
                        </span>
                      </td>
                    );
                  })}
                  {/* Avg column */}
                  <td className="px-1 py-1 text-center text-blue-300 font-medium">
                    {avg !== null ? `${Math.round(avg * 100)}%` : '—'}
                  </td>
                  {/* Std column */}
                  <td
                    className={`px-1 py-1 text-center font-medium rounded-sm ${
                      isHighStd ? 'bg-orange-500/20 text-orange-400' : 'text-zinc-500'
                    }`}
                  >
                    {std !== null ? (
                      <>
                        {isHighStd && <span className="mr-0.5">⚠️</span>}
                        {(std * 100).toFixed(1)}
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {/* Tooltip */}
      {tooltip && (
        <div
          className="fixed z-50 bg-zinc-700 border border-zinc-600/50 rounded-lg shadow-xl px-3 py-2 text-xs pointer-events-none max-w-[240px]"
          style={{ left: tooltip.x, top: tooltip.y, transform: 'translate(-50%, -100%)' }}
        >
          <div className="font-mono text-zinc-200 mb-1">
            {tooltip.caseId} · {tooltip.roundLabel}
          </div>
          {tooltip.description && (
            <div className="text-zinc-400 mb-1 truncate">{tooltip.description}</div>
          )}
          <div className="flex items-center gap-2">
            <span className={`font-medium ${
              tooltip.status === 'passed' ? 'text-emerald-400' :
              tooltip.status === 'partial' ? 'text-amber-400' :
              tooltip.status === 'failed' ? 'text-red-400' : 'text-zinc-500'
            }`}>
              {tooltip.status ?? '未测'}
            </span>
            {tooltip.score !== null && (
              <span className="text-zinc-400">{Math.round(tooltip.score * 100)}%</span>
            )}
          </div>
          {tooltip.failureReason && (
            <div className="mt-1 text-red-400/80 text-[10px] line-clamp-2">
              {tooltip.failureReason}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
