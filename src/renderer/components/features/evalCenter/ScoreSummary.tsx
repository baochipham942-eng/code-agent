// ============================================================================
// ScoreSummary - 顶部评分摘要（对标 SpreadsheetBench Viewer Score Summary Bar）
// ============================================================================

import React, { useMemo, useState, useCallback } from 'react';
import { IPC_CHANNELS } from '../../../../shared/ipc';
import type { EvaluationResult, EvaluationMetric } from '../../../../shared/types/evaluation';
import { scoreToGrade, GRADE_COLORS, GRADE_BG_COLORS } from '../../../../shared/types/evaluation';

interface SessionInfo {
  title: string;
  modelProvider: string;
  modelName: string;
  turnCount: number;
  totalTokens: number;
  startTime: number;
  endTime?: number;
}

interface ScoreSummaryProps {
  evaluation: EvaluationResult | null;
  sessionInfo: SessionInfo | null;
  sessionId: string;
  onEvaluationComplete?: (result: unknown) => void;
}

export const ScoreSummary: React.FC<ScoreSummaryProps> = ({
  evaluation,
  sessionInfo,
  sessionId,
  onEvaluationComplete,
}) => {
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const counts = useMemo(() => {
    const metrics: EvaluationMetric[] = evaluation?.metrics || [];
    return {
      pass: metrics.filter(m => !m.informational && m.score >= 80).length,
      fail: metrics.filter(m => !m.informational && m.score < 60 && (m.score > 0 || !!m.details?.reason)).length,
      partial: metrics.filter(m => !m.informational && m.score >= 60 && m.score < 80).length,
      skip: metrics.filter(m => !m.informational && m.score === 0 && !m.details?.reason).length,
      info: metrics.filter(m => m.informational).length,
    };
  }, [evaluation]);

  const runEvaluation = useCallback(async () => {
    if (!window.electronAPI) return;
    try {
      setIsEvaluating(true);
      setError(null);
      const result = await window.electronAPI.invoke(
        IPC_CHANNELS.EVALUATION_RUN_SUBJECTIVE,
        { sessionId, save: true }
      );
      onEvaluationComplete?.(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : '评测失败');
    } finally {
      setIsEvaluating(false);
    }
  }, [sessionId, onEvaluationComplete]);

  const duration = sessionInfo
    ? ((sessionInfo.endTime || Date.now()) - sessionInfo.startTime) / 1000
    : 0;
  const durationStr = duration >= 60
    ? `${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`
    : `${Math.floor(duration)}s`;
  const tokensStr = sessionInfo
    ? `${Math.round(sessionInfo.totalTokens / 1000)}K`
    : '—';

  const evalButton = (
    <button
      onClick={runEvaluation}
      disabled={isEvaluating}
      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition shrink-0 ${
        isEvaluating
          ? 'bg-zinc-700 text-zinc-400 cursor-not-allowed'
          : 'bg-amber-600 hover:bg-amber-700 text-white'
      }`}
    >
      {isEvaluating ? (
        <>
          <div className="animate-spin w-3 h-3 border-2 border-zinc-400 border-t-transparent rounded-full" />
          评测中...
        </>
      ) : (
        <>
          <span>🧀</span>
          {evaluation ? '重新评测' : '开始评测'}
        </>
      )}
    </button>
  );

  // No evaluation yet — show CTA
  if (!evaluation) {
    return (
      <div className="bg-zinc-800/40 rounded-lg p-4">
        <div className="flex items-center gap-4">
          <div className="text-center min-w-[64px]">
            <div className="text-3xl font-bold text-zinc-600">—</div>
          </div>
          <div className="flex-1">
            {sessionInfo && (
              <div className="text-[11px] text-zinc-500 mb-2">
                {sessionInfo.modelProvider}/{sessionInfo.modelName} · {sessionInfo.turnCount}轮 · {durationStr} · {tokensStr} tokens
              </div>
            )}
            {error && (
              <div className="text-xs text-red-400 mb-1.5">{error}</div>
            )}
          </div>
          {evalButton}
        </div>
      </div>
    );
  }

  const score = evaluation.overallScore;
  const grade = evaluation.grade || scoreToGrade(score);
  const gradeColor = GRADE_COLORS[grade] || 'text-zinc-400';
  const gradeBg = GRADE_BG_COLORS[grade] || 'bg-zinc-500/20';

  return (
    <div className="bg-zinc-800/40 rounded-lg p-4">
      <div className="flex items-center gap-5">
        {/* Score + Grade */}
        <div className="text-center min-w-[64px]">
          <div className="text-3xl font-bold text-white">{score}</div>
          <span className={`inline-block ${gradeColor} ${gradeBg} px-2.5 py-0.5 rounded-full text-sm font-bold mt-0.5`}>
            {grade}
          </span>
        </div>

        {/* Meta + counts + progress */}
        <div className="flex-1 min-w-0">
          {sessionInfo && (
            <div className="text-[11px] text-zinc-500 mb-1.5">
              {sessionInfo.modelProvider}/{sessionInfo.modelName} · {sessionInfo.turnCount}轮 · {durationStr} · {tokensStr} tokens
            </div>
          )}

          {/* Pass/Fail/Partial/Skip counts */}
          <div className="flex items-center gap-3 text-[11px] mb-2">
            {counts.pass > 0 && <span className="text-green-400">通过: {counts.pass}</span>}
            {counts.fail > 0 && <span className="text-red-400">失败: {counts.fail}</span>}
            {counts.partial > 0 && <span className="text-yellow-400">部分: {counts.partial}</span>}
            {counts.skip > 0 && <span className="text-zinc-500">跳过: {counts.skip}</span>}
            {counts.info > 0 && <span className="text-blue-400">信息: {counts.info}</span>}
          </div>

          {/* Progress bar */}
          <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
            <div
              className={`h-full rounded-full transition-all ${
                score >= 80 ? 'bg-green-500' : score >= 60 ? 'bg-yellow-500' : 'bg-red-500'
              }`}
              style={{ width: `${score}%` }}
            />
          </div>
        </div>

        {/* Re-evaluate button */}
        {evalButton}
      </div>
    </div>
  );
};
