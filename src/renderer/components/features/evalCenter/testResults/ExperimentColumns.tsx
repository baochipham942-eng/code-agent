import React, { useMemo } from 'react';
import type { TestReportListItem, TestRunReport } from '@shared/ipc';

interface Props {
  reports: TestReportListItem[];
  currentReport: TestRunReport | null;
  onSelectReport: (filePath: string) => void;
  isLoading?: boolean;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}


function getScoreColor(score: number): { bar: string; text: string; bg: string; border: string } {
  if (score >= 0.8) return { bar: 'bg-emerald-500', text: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/30' };
  if (score >= 0.5) return { bar: 'bg-amber-500', text: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/30' };
  return { bar: 'bg-red-500', text: 'text-red-400', bg: 'bg-red-500/10', border: 'border-red-500/30' };
}

export const ExperimentColumns: React.FC<Props> = ({
  reports,
  currentReport,
  onSelectReport,
  isLoading,
}) => {
  // Assign round numbers (oldest = R1, newest = Rn)
  const roundedReports = useMemo(() => {
    return [...reports]
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((r, i) => ({ ...r, roundNum: i + 1 }));
  }, [reports]);

  const currentFilePath = reports.find(
    (r) => r.timestamp === currentReport?.startTime
  )?.filePath;

  if (reports.length === 0) {
    return (
      <div className="flex items-center gap-2 px-1 py-2 text-zinc-500 text-xs">
        暂无历史报告
      </div>
    );
  }

  return (
    <div className="relative">
      {/* Scroll shadow indicators */}
      <div className="overflow-x-auto pb-1 scrollbar-thin scrollbar-thumb-zinc-700 scrollbar-track-transparent">
        <div className="flex items-stretch gap-2 min-w-max px-0.5 py-1">
          {/* Newest first in the UI */}
          {[...roundedReports].reverse().map((r) => {
            const isSelected = r.filePath === currentFilePath;
            const scorePercent = Math.round(r.averageScore * 100);
            const colors = getScoreColor(r.averageScore);

            return (
              <button
                key={r.filePath}
                onClick={() => onSelectReport(r.filePath)}
                className={`
                  group relative flex flex-col gap-1.5 px-3 py-2.5 rounded-lg border transition-all min-w-[130px] max-w-[160px]
                  ${isSelected
                    ? `${colors.bg} ${colors.border} ring-1 ring-offset-1 ring-offset-zinc-900 ring-current`
                    : 'bg-zinc-800/50 border-zinc-700/30 hover:bg-zinc-800 hover:border-zinc-600/50'
                  }
                `}
              >
                {/* Round badge */}
                <div className="flex items-center justify-between">
                  <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded ${
                    isSelected ? colors.text : 'text-zinc-400'
                  } bg-zinc-900/50`}>
                    R{r.roundNum}
                  </span>
                  {isLoading && isSelected && (
                    <svg className="animate-spin w-3 h-3 text-zinc-500" viewBox="0 0 24 24" fill="none">
                      <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                      <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                    </svg>
                  )}
                </div>

                {/* Score */}
                <div className={`text-xl font-bold leading-none ${isSelected ? colors.text : 'text-zinc-300'}`}>
                  {scorePercent}%
                </div>

                {/* Pass count */}
                <div className="text-[10px] text-zinc-500">
                  {r.passed}/{r.total} 通过
                  {r.partial > 0 && <span className="text-amber-500/70"> +{r.partial}</span>}
                </div>

                {/* Progress bar */}
                <div className="w-full h-1 bg-zinc-700/60 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${colors.bar}`}
                    style={{ width: `${scorePercent}%` }}
                  />
                </div>

                {/* Metadata */}
                <div className="text-[9px] text-zinc-600 truncate leading-none">
                  {r.model.split('/').pop() || r.model}
                </div>
                <div className="text-[9px] text-zinc-600 leading-none">
                  {formatTime(r.timestamp)}
                </div>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};
