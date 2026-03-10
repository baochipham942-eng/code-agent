// ============================================================================
// SessionEvalView - 会话评测详情页（Trace + 评测双 Tab）
// ============================================================================

import React, { useState, useEffect, useCallback } from 'react';
import { EVALUATION_CHANNELS } from '@shared/ipc';
import { SessionReplayView } from '../SessionReplayView';
import { useEvalCenterStore } from '../../../../stores/evalCenterStore';
import ipcService from '../../../../services/ipcService';

// 9 维度颜色映射（借鉴 AGENT_COLORS 风格）
const DIMENSION_COLORS: Record<string, { text: string; bar: string; bg: string }> = {
  accuracy: { text: 'text-emerald-400', bar: 'bg-emerald-500', bg: 'bg-emerald-500/10' },
  completeness: { text: 'text-blue-400', bar: 'bg-blue-500', bg: 'bg-blue-500/10' },
  relevance: { text: 'text-cyan-400', bar: 'bg-cyan-500', bg: 'bg-cyan-500/10' },
  clarity: { text: 'text-purple-400', bar: 'bg-purple-500', bg: 'bg-purple-500/10' },
  efficiency: { text: 'text-amber-400', bar: 'bg-amber-500', bg: 'bg-amber-500/10' },
  safety: { text: 'text-green-400', bar: 'bg-green-500', bg: 'bg-green-500/10' },
  creativity: { text: 'text-indigo-400', bar: 'bg-indigo-500', bg: 'bg-indigo-500/10' },
  reasoning: { text: 'text-orange-400', bar: 'bg-orange-500', bg: 'bg-orange-500/10' },
  helpfulness: { text: 'text-pink-400', bar: 'bg-pink-500', bg: 'bg-pink-500/10' },
};

const DIMENSION_ICONS: Record<string, string> = {
  accuracy: '\u{1F3AF}',
  completeness: '\u{1F4E6}',
  relevance: '\u{1F517}',
  clarity: '\u{1F4A1}',
  efficiency: '\u26A1',
  safety: '\u{1F6E1}\uFE0F',
  creativity: '\u{1F3A8}',
  reasoning: '\u{1F9E0}',
  helpfulness: '\u{1F91D}',
};

type SessionTab = 'trace' | 'evaluation';

interface Props {
  sessionId: string;
  onBack: () => void;
}

export const SessionEvalView: React.FC<Props> = ({ sessionId, onBack }) => {
  const [activeTab, setActiveTab] = useState<SessionTab>('trace');
  const [evalResult, setEvalResult] = useState<any>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedSections, setExpandedSections] = useState<Record<string, boolean>>({
    dimensions: true,
    suggestions: true,
  });

  // Load session info for header display
  const { loadSession, sessionInfo } = useEvalCenterStore();

  useEffect(() => {
    loadSession(sessionId);
  }, [sessionId, loadSession]);

  // Load existing eval result for this session
  useEffect(() => {
    const load = async () => {
      try {
        const results = await ipcService.invoke(
          EVALUATION_CHANNELS.LIST_HISTORY,
          { sessionId, limit: 1 }
        );
        if (results && results.length > 0) {
          setEvalResult(results[0]);
        }
      } catch {
        /* no existing eval */
      }
    };
    load();
  }, [sessionId]);

  // Run evaluation
  const handleRunEval = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setActiveTab('evaluation');
    try {
      const result = await ipcService.invoke(
        EVALUATION_CHANNELS.RUN_SUBJECTIVE_EVALUATION,
        { sessionId, save: true }
      );
      setEvalResult(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '评测失败');
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  const toggleSection = (key: string) => {
    setExpandedSections(prev => ({ ...prev, [key]: !prev[key] }));
  };

  const getScoreColor = (score: number) => {
    if (score >= 80) return 'text-emerald-400';
    if (score >= 60) return 'text-amber-400';
    return 'text-red-400';
  };

  const getScoreBg = (score: number) => {
    if (score >= 80) return 'bg-emerald-500/10 border-emerald-500/20';
    if (score >= 60) return 'bg-amber-500/10 border-amber-500/20';
    return 'bg-red-500/10 border-red-500/20';
  };

  const getDimColor = (key: string) => {
    const k = (key ?? "").toLowerCase();
    return DIMENSION_COLORS[k] || { text: 'text-zinc-400', bar: 'bg-zinc-600', bg: 'bg-zinc-600/10' };
  };

  const getDimIcon = (key: string) => {
    return DIMENSION_ICONS[(key ?? "").toLowerCase()] || '\u{1F4CA}';
  };

  const getDimensionEntries = (): Array<[string, number]> => {
    if (!evalResult) return [];
    if (evalResult.aggregatedMetrics) {
      return Object.entries(evalResult.aggregatedMetrics).map(([k, v]: [string, any]) => [
        k, typeof v === 'number' ? v : (v?.score ?? 0),
      ]);
    }
    if (evalResult.dimensions) {
      return Object.entries(evalResult.dimensions).map(([k, v]: [string, any]) => [
        k, typeof v === 'number' ? v : (v?.score ?? 0),
      ]);
    }
    if (evalResult.metrics && Array.isArray(evalResult.metrics)) {
      return (evalResult.metrics as Array<{ name: string; score: number }>).map((m) => [m.name, m.score]);
    }
    return [];
  };

  const overallScore = evalResult?.overallScore ?? evalResult?.score ?? 0;

  return (
    <div className="flex flex-col h-full">
      {/* Header with back button + session info + tabs */}
      <div className="shrink-0 border-b border-zinc-700">
        <div className="px-4 pt-3 pb-0">
          <div className="flex items-center gap-3 mb-3">
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
            <span className="text-xs text-zinc-400 truncate max-w-[300px]">
              {sessionInfo?.title || sessionId.slice(0, 12) + '...'}
            </span>
            <span className="text-[10px] text-zinc-600 font-mono">
              {sessionId.slice(0, 8)}
            </span>
            {sessionInfo && (
              <>
                <div className="h-3 w-px bg-zinc-700" />
                <span className="text-[10px] text-zinc-500">
                  {sessionInfo.modelProvider}/{sessionInfo.modelName}
                </span>
              </>
            )}
          </div>

          {/* Tab bar */}
          <div className="flex gap-1">
            <button
              onClick={() => setActiveTab('trace')}
              className={`px-3 py-2 text-xs transition border-b-2 ${
                activeTab === 'trace'
                  ? 'text-zinc-200 border-blue-500'
                  : 'text-zinc-500 hover:text-zinc-400 border-transparent'
              }`}
            >
              Trace 轨迹
            </button>
            <button
              onClick={() => setActiveTab('evaluation')}
              className={`px-3 py-2 text-xs transition border-b-2 flex items-center gap-1.5 ${
                activeTab === 'evaluation'
                  ? 'text-zinc-200 border-blue-500'
                  : 'text-zinc-500 hover:text-zinc-400 border-transparent'
              }`}
            >
              评测结果
              {evalResult && (
                <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${getScoreBg(overallScore)} ${getScoreColor(overallScore)}`}>
                  {Math.round(overallScore)}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Tab content */}
      <div className="flex-1 min-h-0 overflow-hidden">
        {/* Trace Tab - SessionReplayView */}
        {activeTab === 'trace' && (
          <SessionReplayView
            sessionId={sessionId}
            onRunEvaluation={handleRunEval}
          />
        )}

        {/* Evaluation Tab */}
        {activeTab === 'evaluation' && (
          <div className="p-4 space-y-4 overflow-y-auto h-full">
            {/* No eval yet */}
            {!evalResult && !isLoading && (
              <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] flex flex-col items-center justify-center py-16 gap-4">
                <div className="w-16 h-16 rounded-2xl bg-zinc-700/60 border border-white/[0.04] flex items-center justify-center text-2xl">
                  {'\u{1F9EA}'}
                </div>
                <p className="text-sm text-zinc-400">该会话尚未评测</p>
                <p className="text-xs text-zinc-500 max-w-xs text-center">
                  使用 Swiss Cheese 4 评审员模型对会话质量进行多维评估
                </p>
                <button
                  onClick={handleRunEval}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-500 text-white text-sm rounded-xl transition-all hover:shadow-lg hover:shadow-blue-500/20 active:scale-[0.98]"
                >
                  {'\u{1F680}'} 运行评测
                </button>
                {error && (
                  <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-3 py-2">
                    <p className="text-xs text-red-400">{error}</p>
                  </div>
                )}
              </div>
            )}

            {/* Loading */}
            {isLoading && (
              <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] flex flex-col items-center justify-center py-16 gap-4">
                <svg className="animate-spin w-10 h-10 text-blue-400" viewBox="0 0 24 24" fill="none">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <p className="text-sm text-zinc-400">正在评测中...</p>
                <div className="flex items-center gap-2">
                  {['\u{1F916}', '\u{1F50D}', '\u{1F4CB}', '\u{1F9EA}'].map((icon, i) => (
                    <div key={i} className="w-8 h-8 rounded-lg bg-zinc-700/60 border border-white/[0.04] flex items-center justify-center text-sm animate-pulse" style={{ animationDelay: `${i * 200}ms` }}>
                      {icon}
                    </div>
                  ))}
                </div>
                <p className="text-xs text-zinc-500">4 个 LLM 评审员并行工作，可能需要 10-30 秒</p>
              </div>
            )}

            {/* Results */}
            {evalResult && !isLoading && (
              <div className="space-y-3">
                {/* Overall score */}
                <div className={`bg-white/[0.02] backdrop-blur-sm rounded-xl p-6 border ${getScoreBg(overallScore)} text-center relative overflow-hidden`}>
                  <div className="absolute inset-0 bg-gradient-to-b from-transparent to-black/20 pointer-events-none" />
                  <div className="relative">
                    <div className={`text-5xl font-bold ${getScoreColor(overallScore)} tabular-nums`}>
                      {Math.round(overallScore)}
                    </div>
                    <p className="text-xs text-zinc-500 mt-2">综合评分 (Swiss Cheese)</p>
                    {evalResult.consensus !== undefined && (
                      <div className={`inline-flex items-center gap-1.5 mt-2 px-2.5 py-1 rounded-full text-xs ${
                        evalResult.consensus ? 'bg-emerald-500/10 text-emerald-400' : 'bg-amber-500/10 text-amber-400'
                      }`}>
                        <span>{evalResult.consensus ? '\u2713' : '\u26A0'}</span>
                        <span>{evalResult.consensus ? '评审员达成共识' : '评审员意见分歧'}</span>
                      </div>
                    )}
                  </div>
                </div>

                {/* Dimension scores */}
                <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] overflow-hidden">
                  <button onClick={() => toggleSection('dimensions')} className="flex items-center w-full px-4 py-3 hover:bg-white/[0.02] transition">
                    <div className="flex items-center gap-2 flex-1 min-w-0">
                      <span className="text-sm">{'\u{1F4CA}'}</span>
                      <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">维度得分</span>
                      <span className="text-xs text-zinc-600">({getDimensionEntries().length})</span>
                    </div>
                    <svg className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${expandedSections.dimensions ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                    </svg>
                  </button>
                  {expandedSections.dimensions && (
                    <div className="px-4 pb-4 space-y-2">
                      {getDimensionEntries().map(([key, score]) => {
                        const colors = getDimColor(key);
                        const icon = getDimIcon(key);
                        return (
                          <div key={key} className={`flex items-center gap-3 py-2 px-3 rounded-lg ${colors.bg}`}>
                            <span className="text-sm flex-shrink-0">{icon}</span>
                            <span className={`text-xs w-24 truncate ${colors.text} font-medium`}>{key}</span>
                            <div className="flex-1 h-2 bg-zinc-700 rounded-full overflow-hidden">
                              <div className={`h-full rounded-full ${colors.bar} transition-all duration-500`} style={{ width: `${Math.min(100, score)}%` }} />
                            </div>
                            <span className={`text-xs font-mono w-8 text-right font-medium ${colors.text}`}>{Math.round(score)}</span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Suggestions */}
                {evalResult.suggestions && evalResult.suggestions.length > 0 && (
                  <div className="bg-white/[0.02] backdrop-blur-sm rounded-xl border border-white/[0.04] overflow-hidden">
                    <button onClick={() => toggleSection('suggestions')} className="flex items-center w-full px-4 py-3 hover:bg-white/[0.02] transition">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <span className="text-sm">{'\u{1F4A1}'}</span>
                        <span className="text-xs font-medium text-zinc-400 uppercase tracking-wide">改进建议</span>
                        <span className="text-xs text-zinc-600">({evalResult.suggestions.length})</span>
                      </div>
                      <svg className={`w-3.5 h-3.5 text-zinc-500 transition-transform ${expandedSections.suggestions ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                      </svg>
                    </button>
                    {expandedSections.suggestions && (
                      <div className="px-4 pb-4 space-y-1.5">
                        {evalResult.suggestions.map((s: string, i: number) => (
                          <div key={i} className="flex gap-2 py-1.5 px-3 bg-zinc-800 rounded-lg">
                            <span className="text-amber-500/60 text-xs mt-0.5 flex-shrink-0">{'\u25B8'}</span>
                            <span className="text-xs text-zinc-400 leading-relaxed">{s}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}

                {/* Re-run button */}
                <div className="flex justify-center pt-2">
                  <button onClick={handleRunEval} className="flex items-center gap-2 px-4 py-2 text-xs text-zinc-500 hover:text-zinc-400 hover:bg-white/[0.03] rounded-lg transition">
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
                    </svg>
                    <span>重新评测</span>
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
