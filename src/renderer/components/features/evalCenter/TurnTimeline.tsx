// ============================================================================
// TurnTimeline - 基于 TelemetryTurn[] 的真实轮次时间线
// ============================================================================

import React, { useState, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { CollapsibleSection } from './CollapsibleSection';
import type { TelemetryTurn, TelemetryToolCall } from '../../../../shared/types/telemetry';

interface TurnTimelineProps {
  turns: TelemetryTurn[];
  sessionId: string;
}

const MAX_VISIBLE = 8;

export const TurnTimeline: React.FC<TurnTimelineProps> = ({ turns }) => {
  const [expandedTurns, setExpandedTurns] = useState<Set<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  // Cache loaded tool calls per turn id
  const [turnDetails, setTurnDetails] = useState<Record<string, TelemetryToolCall[]>>({});
  const [loadingTurns, setLoadingTurns] = useState<Set<string>>(new Set());

  const loadTurnDetail = useCallback(async (turnId: string) => {
    if (turnDetails[turnId] || loadingTurns.has(turnId) || !window.electronAPI) return;
    setLoadingTurns(prev => new Set(prev).add(turnId));
    try {
      const result = await window.electronAPI.invoke(
        'telemetry:get-turn-detail' as 'telemetry:get-turn-detail',
        turnId
      );
      if (result?.toolCalls) {
        setTurnDetails(prev => ({ ...prev, [turnId]: result.toolCalls }));
      }
    } catch { /* ignore */ }
    setLoadingTurns(prev => {
      const next = new Set(prev);
      next.delete(turnId);
      return next;
    });
  }, [turnDetails, loadingTurns]);

  if (turns.length === 0) return null;

  const visible = showAll ? turns : turns.slice(0, MAX_VISIBLE);

  const toggleTurn = (turn: TelemetryTurn) => {
    const key = turn.id;
    setExpandedTurns(prev => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
        // Load tool call details on first expand
        loadTurnDetail(turn.id);
      }
      return next;
    });
  };

  return (
    <CollapsibleSection title={`执行轨迹 (${turns.length} 轮)`} defaultOpen={false}>
      <div className="space-y-1">
        {visible.map((turn, idx) => {
          const displayTurnNumber = idx + 1;
          const isExpanded = expandedTurns.has(turn.id);
          const time = turn.startTime
            ? new Date(turn.startTime).toLocaleTimeString('zh-CN', {
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit',
              })
            : '';

          const durationStr = turn.durationMs >= 1000
            ? `${(turn.durationMs / 1000).toFixed(1)}s`
            : `${turn.durationMs}ms`;

          const promptPreview = turn.userPrompt
            ? turn.userPrompt.replace(/\n/g, ' ').substring(0, 60)
            : '';

          const toolCalls = turnDetails[turn.id];
          const isLoadingDetail = loadingTurns.has(turn.id);

          // Outcome status indicator
          const outcomeStatus = turn.outcome?.status;
          const statusColor = outcomeStatus === 'success' ? 'text-green-500'
            : outcomeStatus === 'failure' ? 'text-red-500'
            : outcomeStatus === 'partial' ? 'text-yellow-500'
            : 'text-zinc-500';

          return (
            <div
              key={turn.id}
              className="bg-zinc-800/30 rounded-lg border border-zinc-700/20"
            >
              <button
                onClick={() => toggleTurn(turn)}
                className="w-full flex items-center gap-2 px-3 py-2 text-left"
              >
                <span className="text-[10px] text-zinc-500 font-mono shrink-0 w-12">
                  Turn {displayTurnNumber}
                </span>
                {time && <span className="text-[10px] text-zinc-600 shrink-0">{time}</span>}
                <span className="text-[11px] text-zinc-300 truncate flex-1">
                  {promptPreview || '(no prompt)'}
                </span>
                <span className={`text-[10px] shrink-0 ${statusColor}`}>●</span>
                <span className="text-[10px] text-zinc-600 shrink-0">{durationStr}</span>
                <ChevronDown
                  className={`w-3 h-3 text-zinc-600 shrink-0 transition-transform ${
                    isExpanded ? '' : '-rotate-90'
                  }`}
                />
              </button>

              {isExpanded && (
                <div className="px-3 pb-2.5 border-t border-zinc-700/20 pt-2 space-y-2">
                  {/* User Prompt full */}
                  {turn.userPrompt && (
                    <div>
                      <div className="text-[10px] text-zinc-600 mb-0.5">USER</div>
                      <div className="text-[11px] text-zinc-400 whitespace-pre-wrap break-words max-h-[120px] overflow-y-auto bg-zinc-900/30 rounded p-2">
                        {turn.userPrompt.length > 500
                          ? turn.userPrompt.substring(0, 500) + '...'
                          : turn.userPrompt}
                      </div>
                    </div>
                  )}

                  {/* Tool calls */}
                  {isLoadingDetail ? (
                    <div className="text-[11px] text-zinc-600">加载工具调用...</div>
                  ) : toolCalls && toolCalls.length > 0 ? (
                    <div>
                      <div className="text-[10px] text-zinc-600 mb-0.5">
                        TOOLS ({toolCalls.length})
                      </div>
                      <div className="space-y-0.5">
                        {toolCalls.map((tc, i) => (
                          <div key={i} className="flex items-center gap-2 text-[11px]">
                            <span className={tc.success ? 'text-green-500' : 'text-red-500'}>
                              {tc.success ? '✓' : '✗'}
                            </span>
                            <span className="text-zinc-400 font-mono">{tc.name}</span>
                            <span className="text-zinc-600">{tc.durationMs}ms</span>
                            {tc.error && (
                              <span className="text-red-400 truncate text-[10px]">{tc.error}</span>
                            )}
                          </div>
                        ))}
                      </div>
                    </div>
                  ) : !isLoadingDetail && toolCalls ? (
                    <div className="text-[11px] text-zinc-600">(无工具调用)</div>
                  ) : null}

                  {/* Assistant Response preview */}
                  {turn.assistantResponse && (
                    <div>
                      <div className="text-[10px] text-zinc-600 mb-0.5">ASSISTANT</div>
                      <div className="text-[11px] text-zinc-500 whitespace-pre-wrap break-words max-h-[80px] overflow-y-auto bg-zinc-900/30 rounded p-2">
                        {turn.assistantResponse.length > 300
                          ? turn.assistantResponse.substring(0, 300) + '...'
                          : turn.assistantResponse}
                      </div>
                    </div>
                  )}

                  {/* Token usage */}
                  <div className="flex items-center gap-3 text-[10px] text-zinc-600">
                    <span>输入: {turn.totalInputTokens.toLocaleString()}</span>
                    <span>输出: {turn.totalOutputTokens.toLocaleString()}</span>
                    {turn.iterationCount > 1 && (
                      <span>迭代: {turn.iterationCount}</span>
                    )}
                    {turn.compactionOccurred && (
                      <span className="text-amber-500">已压缩</span>
                    )}
                  </div>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {!showAll && turns.length > MAX_VISIBLE && (
        <button
          onClick={() => setShowAll(true)}
          className="mt-2 text-[11px] text-amber-500 hover:text-amber-400 transition"
        >
          查看完整 {turns.length} 轮 →
        </button>
      )}
    </CollapsibleSection>
  );
};
