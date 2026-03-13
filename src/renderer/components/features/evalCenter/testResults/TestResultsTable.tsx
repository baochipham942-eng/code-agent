import React, { useState, useMemo } from 'react';
import type { TestCaseResult } from '@shared/ipc';
import { TestResultsDetail } from './TestResultsDetail';
import { ChevronDown, ChevronRight } from 'lucide-react';

interface Props {
  results: TestCaseResult[];
}

type SortKey = 'testId' | 'status' | 'score' | 'duration' | 'turnCount';
type SortDir = 'asc' | 'desc';
type StatusFilter = 'all' | 'passed' | 'failed' | 'partial' | 'unstable';

const STATUS_ICON: Record<string, { icon: string; color: string }> = {
  passed: { icon: '\u2713', color: 'text-emerald-400' },
  failed: { icon: '\u2717', color: 'text-red-400' },
  partial: { icon: '\u25D0', color: 'text-amber-400' },
  skipped: { icon: '\u25CB', color: 'text-zinc-500' },
};

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.floor(ms / 60000)}m ${Math.round((ms % 60000) / 1000)}s`;
}

export const TestResultsTable: React.FC<Props> = ({ results }) => {
  const [sortKey, setSortKey] = useState<SortKey>('testId');
  const [sortDir, setSortDir] = useState<SortDir>('asc');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc');
    } else {
      setSortKey(key);
      setSortDir(key === 'testId' ? 'asc' : 'desc');
    }
  };

  const hasStabilityData = results.some(r => r.unstable != null);
  const unstableCount = results.filter(r => r.unstable).length;

  const filtered = useMemo(() => {
    let items = [...results];
    if (statusFilter === 'unstable') {
      items = items.filter(r => r.unstable);
    } else if (statusFilter !== 'all') {
      items = items.filter(r => r.status === statusFilter);
    }
    items.sort((a, b) => {
      const mul = sortDir === 'asc' ? 1 : -1;
      switch (sortKey) {
        case 'testId': return mul * a.testId.localeCompare(b.testId);
        case 'status': return mul * a.status.localeCompare(b.status);
        case 'score': return mul * (a.score - b.score);
        case 'duration': return mul * (a.duration - b.duration);
        case 'turnCount': return mul * (a.turnCount - b.turnCount);
        default: return 0;
      }
    });
    return items;
  }, [results, statusFilter, sortKey, sortDir]);

  const SortHeader: React.FC<{ label: string; field: SortKey; className?: string }> = ({ label, field, className }) => (
    <th
      className={`px-2 py-1.5 text-left cursor-pointer hover:text-zinc-400 select-none ${className || ''}`}
      onClick={() => handleSort(field)}
    >
      <span className="inline-flex items-center gap-1">
        {label}
        {sortKey === field && (
          <span className="text-[10px]">{sortDir === 'asc' ? '\u2191' : '\u2193'}</span>
        )}
      </span>
    </th>
  );

  return (
    <div className="bg-zinc-800 border border-zinc-700/20 rounded-lg overflow-hidden">
      {/* Filters */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700/20">
        <span className="text-[11px] text-zinc-500">筛选:</span>
        {(['all', 'passed', 'failed', 'partial', ...(hasStabilityData ? ['unstable'] : [])] as StatusFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatusFilter(s)}
            className={`px-2 py-0.5 rounded text-[11px] transition ${
              statusFilter === s
                ? 'bg-zinc-600 text-zinc-200'
                : 'text-zinc-500 hover:text-zinc-400 hover:bg-zinc-700'
            }`}
          >
            {s === 'all' ? '全部' : s === 'passed' ? '通过' : s === 'failed' ? '失败' : s === 'unstable' ? '不稳定' : '部分'}
            {s !== 'all' && ` (${s === 'unstable' ? unstableCount : results.filter(r => r.status === s).length})`}
          </button>
        ))}
        <span className="ml-auto text-[11px] text-zinc-600">
          {filtered.length} / {results.length}
        </span>
      </div>

      {/* Table */}
      <div className="overflow-x-auto max-h-[400px] overflow-y-auto">
        <table className="w-full text-[11px] text-zinc-400">
          <thead className="sticky top-0 bg-zinc-700 backdrop-blur">
            <tr className="border-b border-zinc-800">
              <th className="w-6 px-2 py-1.5" />
              <th className="w-6 px-1 py-1.5" />
              <SortHeader label="用例" field="testId" className="min-w-[140px]" />
              <th className="px-2 py-1.5 text-left">描述</th>
              <SortHeader label="分数" field="score" className="w-16" />
              <SortHeader label="耗时" field="duration" className="w-20" />
              <SortHeader label="轮次" field="turnCount" className="w-14" />
              <th className="px-2 py-1.5 text-left w-14">工具</th>
              {hasStabilityData && <th className="px-2 py-1.5 text-left w-20">稳定性</th>}
            </tr>
          </thead>
          <tbody>
            {filtered.map((r) => {
              const isExpanded = expandedId === r.testId;
              const statusInfo = STATUS_ICON[r.status] || STATUS_ICON.skipped;

              return (
                <React.Fragment key={r.testId}>
                  <tr
                    className="border-b border-zinc-700/10 hover:bg-zinc-800 cursor-pointer transition"
                    onClick={() => setExpandedId(isExpanded ? null : r.testId)}
                  >
                    <td className="px-2 py-1.5 text-zinc-600">
                      {isExpanded ? <ChevronDown className="w-3 h-3" /> : <ChevronRight className="w-3 h-3" />}
                    </td>
                    <td className={`px-1 py-1.5 ${statusInfo.color} font-medium`}>
                      {statusInfo.icon}
                    </td>
                    <td className="px-2 py-1.5 font-mono text-zinc-400">{r.testId}</td>
                    <td className="px-2 py-1.5 truncate max-w-[200px]">{r.description}</td>
                    <td className={`px-2 py-1.5 font-medium ${
                      r.score >= 1 ? 'text-emerald-400' :
                      r.score > 0 ? 'text-amber-400' :
                      'text-red-400'
                    }`}>
                      {r.score >= 0 ? (r.score * 100).toFixed(0) + '%' : '-'}
                    </td>
                    <td className="px-2 py-1.5">{formatDuration(r.duration)}</td>
                    <td className="px-2 py-1.5">{r.turnCount}</td>
                    <td className="px-2 py-1.5">{r.toolExecutions?.length || 0}</td>
                    {hasStabilityData && (
                      <td className="px-2 py-1.5">
                        {r.unstable ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-orange-500/15 text-orange-400 text-[10px] font-medium">
                            ~ {r.stdDev?.toFixed(2)}
                          </span>
                        ) : r.stdDev != null ? (
                          <span className="text-zinc-600">{r.stdDev.toFixed(2)}</span>
                        ) : (
                          <span className="text-zinc-700">-</span>
                        )}
                      </td>
                    )}
                  </tr>
                  {isExpanded && (
                    <tr>
                      <td colSpan={hasStabilityData ? 9 : 8} className="p-0">
                        <TestResultsDetail result={r} />
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
};
