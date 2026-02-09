// ============================================================================
// EvalDashboard - 单页 Dashboard（对标 SpreadsheetBench Viewer）
// ============================================================================

import React, { useCallback, useState, useEffect } from 'react';
import { useEvalCenterStore } from '../../../stores/evalCenterStore';
import type { EvaluationResult } from '../../../../shared/types/evaluation';
import type { TelemetryTurn } from '../../../../shared/types/telemetry';
import { ScoreSummary } from './ScoreSummary';
import { GraderGrid } from './GraderGrid';
import { ErrorTags } from './ErrorTags';
import { MetricStrip } from './MetricStrip';
import { TurnTimeline } from './TurnTimeline';
import { CollapsibleSection } from './CollapsibleSection';

interface EvalDashboardProps {
  sessionId: string;
}

export const EvalDashboard: React.FC<EvalDashboardProps> = ({ sessionId }) => {
  const { sessionInfo, objective, latestEvaluation, loadSession } =
    useEvalCenterStore();

  // Extract typed evaluation result
  const evaluation = extractEvaluation(latestEvaluation);

  // Load TelemetryTurn[] — the single source of truth for turns, user prompt, system prompt
  const [turns, setTurns] = useState<TelemetryTurn[]>([]);
  const [systemPrompt, setSystemPrompt] = useState<string | null>(null);
  const [systemPromptLoading, setSystemPromptLoading] = useState(false);

  useEffect(() => {
    setTurns([]);
    setSystemPrompt(null);
    if (!sessionId || !window.electronAPI) return;
    window.electronAPI.invoke(
      'telemetry:get-turns' as 'telemetry:get-turns',
      sessionId
    ).then((result: TelemetryTurn[]) => {
      if (result?.length) setTurns(result);
    }).catch(() => { /* ignore */ });
  }, [sessionId]);

  const firstTurn = turns[0];
  const systemPromptHash = firstTurn?.systemPromptHash;

  const loadSystemPrompt = useCallback(async () => {
    if (!systemPromptHash || systemPrompt !== null || !window.electronAPI) return;
    setSystemPromptLoading(true);
    try {
      const result = await window.electronAPI.invoke(
        'telemetry:get-system-prompt' as 'telemetry:get-system-prompt',
        systemPromptHash
      );
      setSystemPrompt(result?.content || '系统提示词不可用');
    } catch {
      setSystemPrompt('加载失败');
    } finally {
      setSystemPromptLoading(false);
    }
  }, [systemPromptHash, systemPrompt]);

  const handleEvaluationComplete = useCallback(async () => {
    await loadSession(sessionId);
  }, [loadSession, sessionId]);

  return (
    <div className="p-4 space-y-4 overflow-y-auto">
      {/* User Prompt — from first turn's actual userPrompt */}
      {firstTurn?.userPrompt && (
        <div className="bg-zinc-800/30 rounded-lg p-3 border border-zinc-700/20">
          <div className="text-[10px] text-zinc-500 mb-1">USER PROMPT</div>
          <div className="text-sm text-zinc-200 leading-relaxed whitespace-pre-wrap break-words max-h-[200px] overflow-y-auto">
            {firstTurn.userPrompt}
          </div>
        </div>
      )}

      {/* System Prompt (on-demand loading) */}
      <CollapsibleSection
        title="系统提示词"
        defaultOpen={false}
        onToggle={systemPromptHash ? loadSystemPrompt : undefined}
      >
        {!systemPromptHash ? (
          <div className="text-xs text-zinc-600 py-2">此会话录制时未记录系统提示词（仅新会话支持）</div>
        ) : systemPromptLoading ? (
          <div className="text-xs text-zinc-500 py-2">加载中...</div>
        ) : systemPrompt ? (
          <pre className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words max-h-[300px] overflow-y-auto font-mono leading-relaxed bg-zinc-900/50 rounded p-3">
            {systemPrompt}
          </pre>
        ) : (
          <div className="text-xs text-zinc-600 py-2">展开以加载系统提示词</div>
        )}
      </CollapsibleSection>

      {/* Score Summary + Eval CTA */}
      <ScoreSummary
        evaluation={evaluation}
        sessionInfo={sessionInfo}
        sessionId={sessionId}
        onEvaluationComplete={handleEvaluationComplete}
      />

      {/* Grader Card Grid */}
      {evaluation && evaluation.metrics.length > 0 && (
        <GraderGrid metrics={evaluation.metrics} />
      )}

      {/* Error Tags */}
      {evaluation?.transcriptMetrics?.errorTaxonomy && (
        <ErrorTags errorTaxonomy={evaluation.transcriptMetrics.errorTaxonomy} />
      )}

      {/* Token & Cost Strip */}
      <MetricStrip objective={objective} />

      {/* Turn Timeline — from real TelemetryTurn[] */}
      <TurnTimeline turns={turns} sessionId={sessionId} />

      {/* Suggestions */}
      {evaluation && evaluation.topSuggestions.length > 0 && (
        <CollapsibleSection title="改进建议" defaultOpen>
          <div className="bg-yellow-500/10 border border-yellow-500/30 rounded-lg p-3">
            <ul className="space-y-1">
              {evaluation.topSuggestions.map((suggestion, i) => (
                <li key={i} className="text-xs text-yellow-200/80">
                  {i + 1}. {suggestion}
                </li>
              ))}
            </ul>
          </div>
        </CollapsibleSection>
      )}

      {/* AI Summary */}
      {evaluation?.aiSummary && (
        <div className="text-xs text-zinc-500 bg-zinc-800/20 rounded-lg p-3 italic">
          {evaluation.aiSummary}
        </div>
      )}
    </div>
  );
};

/**
 * Extract EvaluationResult from the store's loosely-typed latestEvaluation.
 */
function extractEvaluation(raw: unknown): EvaluationResult | null {
  if (!raw) return null;

  // v3 format: direct EvaluationResult with metrics[]
  if (isEvaluationResult(raw)) return raw;

  // v2 format: { subjective: { overallScore, ... } }
  const obj = raw as Record<string, unknown>;
  if (obj.subjective && typeof obj.subjective === 'object') {
    const sub = obj.subjective as Record<string, unknown>;
    if (typeof sub.overallScore === 'number') {
      return {
        id: (sub.id as string) || '',
        sessionId: (sub.sessionId as string) || '',
        timestamp: (sub.evaluatedAt as number) || Date.now(),
        overallScore: sub.overallScore as number,
        grade: (sub.grade as EvaluationResult['grade']) || 'F',
        metrics: convertAggregatedMetrics(sub.aggregatedMetrics),
        statistics: {
          duration: 0,
          turnCount: 0,
          toolCallCount: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalCost: 0,
        },
        topSuggestions: (sub.suggestions as string[]) || [],
        aiSummary: sub.summary as string | undefined,
      };
    }
  }

  return null;
}

function isEvaluationResult(obj: unknown): obj is EvaluationResult {
  if (!obj || typeof obj !== 'object') return false;
  const o = obj as Record<string, unknown>;
  return Array.isArray(o.metrics) && typeof o.overallScore === 'number';
}

function convertAggregatedMetrics(
  raw: unknown
): EvaluationResult['metrics'] {
  if (!raw || typeof raw !== 'object') return [];
  const entries = Object.entries(raw as Record<string, { score: number; reasons?: string[] }>);
  return entries.map(([key, data]) => ({
    dimension: key as EvaluationResult['metrics'][0]['dimension'],
    score: data.score ?? 0,
    weight: 0,
    details: data.reasons?.length ? { reason: data.reasons.join('; ') } : undefined,
    informational: false,
  }));
}
