// ============================================================================
// CaseDetailPage - Case 详情页（快照摘要 + Trace + 评分）
// ============================================================================

import React, { useState, useEffect } from 'react';
import { EVALUATION_CHANNELS } from '@shared/ipc/channels';
import { TraceView } from '../TraceView';
import ipcService from '../../../../services/ipcService';

interface Props {
  experimentId: string;
  caseId: string;
  onBack: () => void;
}

interface CaseDetailData {
  id: string;
  case_id: string;
  status: string;
  score: number;
  duration_ms: number;
  data_json: string;
  session_id?: string;
  // snapshot fields
  task_text?: string;
  tool_calls_count?: number;
  file_diffs_count?: number;
  total_input_tokens?: number;
  total_output_tokens?: number;
  estimated_cost?: number;
}

interface ScoringDimension {
  name: string;
  score: number;
  reason?: string;
}

export const CaseDetailPage: React.FC<Props> = ({ experimentId, caseId, onBack }) => {
  const [caseData, setCaseData] = useState<CaseDetailData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      setLoading(true);
      setError(null);
      try {
        const result = await ipcService.invoke(
          EVALUATION_CHANNELS.GET_CASE_DETAIL as 'evaluation:get-case-detail',
          experimentId,
          caseId
        );
        if (result) {
          setCaseData(result as CaseDetailData);
        } else {
          setError('Case 数据不存在');
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : '加载失败');
      } finally {
        setLoading(false);
      }
    };
    load();
  }, [experimentId, caseId]);

  // Parse scoring dimensions from data_json
  const scoringDimensions: ScoringDimension[] = (() => {
    if (!caseData?.data_json) return [];
    try {
      const parsed = JSON.parse(caseData.data_json);
      if (parsed.dimensions && Array.isArray(parsed.dimensions)) {
        return parsed.dimensions;
      }
      if (parsed.scores && typeof parsed.scores === 'object') {
        return Object.entries(parsed.scores).map(([name, val]: [string, unknown]) => ({
          name,
          score: typeof val === 'number' ? val : (val as { score: number })?.score ?? 0,
          reason: typeof val === 'object' && val !== null ? (val as { reason?: string }).reason : undefined,
        }));
      }
    } catch {
      /* ignore parse errors */
    }
    return [];
  })();

  const handleMarkAsGolden = () => {
    console.log('[CaseDetailPage] Mark as Golden:', { experimentId, caseId });
  };

  const handleFlagAsRegression = () => {
    console.log('[CaseDetailPage] Flag as Regression:', { experimentId, caseId });
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <svg className="animate-spin w-6 h-6 text-blue-400" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
        </svg>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-4">
        <button onClick={onBack} className="text-xs text-zinc-500 hover:text-zinc-400 mb-4 flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
          返回
        </button>
        <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 text-xs text-red-400">
          {error}
        </div>
      </div>
    );
  }

  if (!caseData) return null;

  const statusColor = caseData.status === 'passed'
    ? 'text-emerald-400 bg-emerald-500/10'
    : caseData.status === 'failed'
      ? 'text-red-400 bg-red-500/10'
      : 'text-amber-400 bg-amber-500/10';

  const totalTokens = (caseData.total_input_tokens ?? 0) + (caseData.total_output_tokens ?? 0);

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="shrink-0 border-b border-zinc-700 px-4 py-3">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="flex items-center gap-1.5 text-xs text-zinc-500 hover:text-zinc-400 transition group"
          >
            <svg className="w-3.5 h-3.5 group-hover:-translate-x-0.5 transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
            </svg>
            <span>返回</span>
          </button>
          <div className="h-3 w-px bg-zinc-700" />
          <span className="text-xs text-zinc-300 font-mono">{caseData.case_id}</span>
          <span className={`text-[10px] px-2 py-0.5 rounded-full ${statusColor}`}>
            {caseData.status}
          </span>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 min-h-0 overflow-y-auto">
        {/* Top: Summary + TraceView side by side */}
        <div className="flex gap-4 p-4">
          {/* Left: Snapshot Summary */}
          <div className="w-[320px] shrink-0 space-y-3">
            <div className="bg-zinc-800 rounded-lg border border-zinc-700/30 p-4 space-y-3">
              <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider">快照摘要</h3>

              {caseData.task_text && (
                <div>
                  <div className="text-[10px] text-zinc-500 mb-1">任务描述</div>
                  <div className="text-xs text-zinc-300 leading-relaxed max-h-[120px] overflow-y-auto">
                    {caseData.task_text}
                  </div>
                </div>
              )}

              <div className="grid grid-cols-2 gap-2">
                <div className="bg-zinc-900/50 rounded-lg p-2.5">
                  <div className="text-lg font-bold text-zinc-200 tabular-nums">{caseData.tool_calls_count ?? 0}</div>
                  <div className="text-[10px] text-zinc-500">工具调用</div>
                </div>
                <div className="bg-zinc-900/50 rounded-lg p-2.5">
                  <div className="text-lg font-bold text-zinc-200 tabular-nums">{caseData.file_diffs_count ?? 0}</div>
                  <div className="text-[10px] text-zinc-500">文件变更</div>
                </div>
                <div className="bg-zinc-900/50 rounded-lg p-2.5">
                  <div className="text-lg font-bold text-zinc-200 tabular-nums">
                    {totalTokens > 1000 ? `${(totalTokens / 1000).toFixed(1)}K` : totalTokens}
                  </div>
                  <div className="text-[10px] text-zinc-500">总 Token</div>
                </div>
                <div className="bg-zinc-900/50 rounded-lg p-2.5">
                  <div className="text-lg font-bold text-zinc-200 tabular-nums">
                    {caseData.duration_ms >= 1000
                      ? `${(caseData.duration_ms / 1000).toFixed(1)}s`
                      : `${caseData.duration_ms}ms`}
                  </div>
                  <div className="text-[10px] text-zinc-500">耗时</div>
                </div>
              </div>

              {caseData.estimated_cost !== undefined && caseData.estimated_cost > 0 && (
                <div className="flex items-center justify-between text-xs">
                  <span className="text-zinc-500">预估成本</span>
                  <span className="text-zinc-300 font-mono">${caseData.estimated_cost.toFixed(4)}</span>
                </div>
              )}

              <div className="flex items-center justify-between text-xs">
                <span className="text-zinc-500">得分</span>
                <span className={`font-bold font-mono ${
                  caseData.score >= 80 ? 'text-emerald-400' : caseData.score >= 60 ? 'text-amber-400' : 'text-red-400'
                }`}>
                  {Math.round(caseData.score)}
                </span>
              </div>
            </div>

            {/* Action Buttons */}
            <div className="flex gap-2">
              <button
                onClick={handleMarkAsGolden}
                className="flex-1 px-3 py-2 text-xs text-amber-400 border border-amber-500/30 rounded-lg hover:bg-amber-500/10 transition text-center"
              >
                Mark as Golden
              </button>
              <button
                onClick={handleFlagAsRegression}
                className="flex-1 px-3 py-2 text-xs text-red-400 border border-red-500/30 rounded-lg hover:bg-red-500/10 transition text-center"
              >
                Flag as Regression
              </button>
            </div>
          </div>

          {/* Right: TraceView */}
          <div className="flex-1 min-w-0 bg-zinc-800/50 rounded-lg border border-zinc-700/30 overflow-hidden" style={{ minHeight: 400 }}>
            {caseData.session_id ? (
              <TraceView sessionId={caseData.session_id} />
            ) : (
              <div className="flex items-center justify-center h-full text-zinc-500 text-xs">
                该 Case 无关联会话，无法显示 Trace
              </div>
            )}
          </div>
        </div>

        {/* Bottom: Scoring Details */}
        {scoringDimensions.length > 0 && (
          <div className="px-4 pb-4">
            <div className="bg-zinc-800 rounded-lg border border-zinc-700/30 p-4">
              <h3 className="text-xs font-medium text-zinc-400 uppercase tracking-wider mb-3">评分详情</h3>
              <div className="space-y-2">
                {scoringDimensions.map((dim, i) => (
                  <div key={i} className="flex items-center gap-3 py-1.5 px-3 bg-zinc-900/40 rounded-lg">
                    <span className="text-xs text-zinc-300 w-28 truncate font-medium">{dim.name}</span>
                    <div className="flex-1 h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full ${
                          dim.score >= 80 ? 'bg-emerald-500' : dim.score >= 60 ? 'bg-amber-500' : 'bg-red-500'
                        }`}
                        style={{ width: `${Math.min(100, dim.score)}%` }}
                      />
                    </div>
                    <span className={`text-xs font-mono w-8 text-right font-medium ${
                      dim.score >= 80 ? 'text-emerald-400' : dim.score >= 60 ? 'text-amber-400' : 'text-red-400'
                    }`}>
                      {Math.round(dim.score)}
                    </span>
                    {dim.reason && (
                      <span className="text-[10px] text-zinc-500 truncate max-w-[200px]" title={dim.reason}>
                        {dim.reason}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
