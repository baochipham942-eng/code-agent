import React from 'react';
import type { TestRunReport, TestReportListItem } from '@shared/ipc';

interface Props {
  report: TestRunReport;
  reports: TestReportListItem[];
  onSelectReport: (filePath: string) => void;
  isLoading: boolean;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const min = Math.floor(ms / 60000);
  const sec = Math.round((ms % 60000) / 1000);
  return `${min}m ${sec}s`;
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const TestResultsHeader: React.FC<Props> = ({ report, reports, onSelectReport, isLoading }) => {
  const scorePercent = Math.round(report.averageScore * 100);

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="flex items-center gap-3 min-w-0">
        {/* Score badge */}
        <div className={`flex-shrink-0 w-12 h-12 rounded-lg flex items-center justify-center text-lg font-bold ${
          scorePercent >= 80 ? 'bg-emerald-500/20 text-emerald-400' :
          scorePercent >= 60 ? 'bg-amber-500/20 text-amber-400' :
          'bg-red-500/20 text-red-400'
        }`}>
          {scorePercent}%
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-xs text-zinc-400">
            <span className="font-medium text-zinc-300">{report.environment?.model || 'unknown'}</span>
            <span className="text-zinc-600">·</span>
            <span>{report.environment?.generation || '-'}</span>
            <span className="text-zinc-600">·</span>
            <span>{formatTime(report.startTime)}</span>
            <span className="text-zinc-600">·</span>
            <span>{formatDuration(report.duration)}</span>
          </div>
          <div className="text-[11px] text-zinc-500 mt-0.5">
            {report.total} 用例 · {report.performance?.totalToolCalls || 0} 工具调用 · {report.performance?.totalTurns || 0} 轮
          </div>
        </div>
      </div>

      {/* Report selector */}
      <div className="flex items-center gap-2">
        {isLoading && (
          <svg className="animate-spin w-3.5 h-3.5 text-zinc-500" viewBox="0 0 24 24" fill="none">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
        )}
        <select
          className="bg-zinc-800 border border-zinc-700 rounded-md px-2 py-1 text-xs text-zinc-300 focus:outline-none focus:border-zinc-600"
          value={reports.find(r => r.timestamp === report.startTime)?.filePath || ''}
          onChange={(e) => onSelectReport(e.target.value)}
        >
          {reports.map((r) => (
            <option key={r.filePath} value={r.filePath}>
              {formatTime(r.timestamp)} — {r.model} ({Math.round(r.averageScore * 100)}%)
            </option>
          ))}
        </select>
      </div>
    </div>
  );
};
