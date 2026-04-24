// ============================================================================
// TraceView - 结构化会话回放（三栏布局 + 增强信息面板）
// ============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useEvalCenterStore } from '../../../stores/evalCenterStore';
import { ReplayMessageBlock } from './ReplayMessageBlock';
import { ReplayAnalyticsSidebar } from './ReplayAnalyticsSidebar';

interface Props {
  sessionId: string;
  onRunEvaluation?: () => void;
}

export const TraceView: React.FC<Props> = ({ sessionId, onRunEvaluation }) => {
  const {
    replayData,
    replayLoading,
    objective,
    reviewQueue,
    sessionInfo,
    loadReplay,
    loadReviewQueue,
    enqueueFailureFollowup,
  } = useEvalCenterStore();
  const [activeTurn, setActiveTurn] = useState(0);
  const turnRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (sessionId) {
      loadReplay(sessionId);
      void loadReviewQueue();
    }
  }, [sessionId, loadReplay, loadReviewQueue]);

  const queuedReviewItem = reviewQueue.find((item) => item.sessionId === sessionId) || null;
  const failureFollowupState = queuedReviewItem?.reason === 'failure_followup'
    ? 'queued'
    : queuedReviewItem
      ? 'upgrade'
      : 'available';

  const handleEnqueueFailureFollowup = useCallback(async () => {
    await enqueueFailureFollowup(sessionId, sessionInfo?.title, replayData?.summary.failureAttribution);
  }, [enqueueFailureFollowup, replayData?.summary.failureAttribution, sessionId, sessionInfo?.title]);

  const scrollToTurn = useCallback((turnIdx: number) => {
    setActiveTurn(turnIdx);
    const el = turnRefs.current.get(turnIdx);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  if (replayLoading) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        Loading replay data...
      </div>
    );
  }

  if (!replayData || replayData.turns.length === 0) {
    return (
      <div className="flex items-center justify-center h-64 text-zinc-500 text-sm">
        No replay data available for this session
      </div>
    );
  }

  const turns = replayData.turns;
  const activeTurnData = turns[activeTurn];

  // Collect tool calls from the active turn
  const activeToolCalls = activeTurnData
    ? activeTurnData.blocks
        .filter(b => b.type === 'tool_call' && b.toolCall)
        .map(b => b.toolCall!)
    : [];

  // Find max duration for waterfall scaling
  const maxDuration = activeToolCalls.length > 0
    ? Math.max(...activeToolCalls.map(tc => tc.duration || 0), 1)
    : 1;

  return (
    <div className="flex h-full min-h-0">
      {/* Left: Turn Navigator */}
      <div className="w-[140px] shrink-0 border-r border-zinc-800 overflow-y-auto">
        <div className="p-2 space-y-0.5">
          {turns.map((turn, idx) => {
            const isActive = idx === activeTurn;
            const hasError = turn.blocks.some(b => b.type === 'error');
            const toolCount = turn.blocks.filter(b => b.type === 'tool_call').length;

            return (
              <button
                key={idx}
                onClick={() => scrollToTurn(idx)}
                className={`w-full text-left px-2 py-1.5 rounded transition text-[11px] ${
                  isActive
                    ? 'bg-amber-500/15 text-amber-300 border border-amber-500/30'
                    : 'text-zinc-400 hover:bg-zinc-800 border border-transparent'
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
                    hasError ? 'bg-red-500' : 'bg-green-500'
                  }`} />
                  <span className="font-mono">T{turn.turnNumber}</span>
                </div>
                {toolCount > 0 && (
                  <div className="text-[10px] text-zinc-600 mt-0.5 ml-3">
                    {toolCount} tool{toolCount > 1 ? 's' : ''}
                  </div>
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Center: Message Flow */}
      <div className="flex-1 overflow-y-auto min-w-0">
        <div className="p-4 space-y-6">
          {/* Action bar */}
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-zinc-500">
              {turns.length} turns / {replayData.summary.totalTurns} total
            </div>
            {onRunEvaluation && (
              <button
                onClick={onRunEvaluation}
                className="px-3 py-1 text-[11px] text-amber-400 border border-amber-500/30 rounded-lg hover:bg-amber-500/10 transition"
              >
                Run Evaluation
              </button>
            )}
          </div>

          {/* Turns */}
          {turns.map((turn, idx) => (
            <div
              key={idx}
              ref={(el) => {
                if (el) turnRefs.current.set(idx, el);
              }}
              className="space-y-2"
            >
              {/* Turn header */}
              <div className="flex items-center gap-2 text-[10px] text-zinc-500">
                <span className="font-mono font-medium">Turn {turn.turnNumber}</span>
                <span className="text-zinc-600">|</span>
                <span>{turn.inputTokens + turn.outputTokens} tokens</span>
                <span className="text-zinc-600">|</span>
                <span>
                  {turn.durationMs >= 1000
                    ? `${(turn.durationMs / 1000).toFixed(1)}s`
                    : `${turn.durationMs}ms`}
                </span>
                {turn.startTime > 0 && (
                  <>
                    <span className="text-zinc-600">|</span>
                    <span>
                      {new Date(turn.startTime).toLocaleTimeString('zh-CN', {
                        hour: '2-digit',
                        minute: '2-digit',
                        second: '2-digit',
                      })}
                    </span>
                  </>
                )}
              </div>

              {/* Blocks */}
              <div className="space-y-1.5 ml-2 border-l-2 border-zinc-800 pl-3">
                {turn.blocks.map((block, bIdx) => (
                  <ReplayMessageBlock key={bIdx} block={block} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: Analytics Sidebar + Enhanced Info Panels */}
      <div className="w-[220px] shrink-0 border-l border-zinc-800 overflow-y-auto">
        <ReplayAnalyticsSidebar
          summary={replayData.summary}
          objective={objective}
          failureFollowupState={failureFollowupState}
          onEnqueueFailureFollowup={handleEnqueueFailureFollowup}
        />

        {/* Per-turn Token Distribution */}
        <div className="border-t border-zinc-800 p-3">
          <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2 font-medium">
            Token 分布 (每轮)
          </div>
          <div className="space-y-1">
            {turns.map((turn, idx) => {
              const total = turn.inputTokens + turn.outputTokens;
              const inputPct = total > 0 ? (turn.inputTokens / total) * 100 : 50;
              return (
                <button
                  key={idx}
                  onClick={() => scrollToTurn(idx)}
                  className={`w-full text-left rounded px-1.5 py-1 transition ${
                    idx === activeTurn ? 'bg-amber-500/10' : 'hover:bg-zinc-800'
                  }`}
                >
                  <div className="flex items-center justify-between text-[10px] mb-0.5">
                    <span className={`font-mono ${idx === activeTurn ? 'text-amber-300' : 'text-zinc-400'}`}>
                      T{turn.turnNumber}
                    </span>
                    <span className="text-zinc-500 tabular-nums">
                      {total > 1000 ? `${(total / 1000).toFixed(1)}K` : total}
                    </span>
                  </div>
                  <div className="h-1 bg-zinc-700 rounded-full overflow-hidden flex">
                    <div
                      className="h-full bg-blue-500/70"
                      style={{ width: `${inputPct}%` }}
                      title={`Input: ${turn.inputTokens}`}
                    />
                    <div
                      className="h-full bg-emerald-500/70"
                      style={{ width: `${100 - inputPct}%` }}
                      title={`Output: ${turn.outputTokens}`}
                    />
                  </div>
                </button>
              );
            })}
          </div>
          <div className="flex items-center gap-3 mt-2 text-[9px] text-zinc-600">
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-blue-500/70" /> Input
            </span>
            <span className="flex items-center gap-1">
              <span className="w-2 h-2 rounded-full bg-emerald-500/70" /> Output
            </span>
          </div>
        </div>

        {/* Tool Call Duration Waterfall */}
        {activeToolCalls.length > 0 && (
          <div className="border-t border-zinc-800 p-3">
            <div className="text-[10px] text-zinc-500 uppercase tracking-wider mb-2 font-medium">
              工具耗时 (T{activeTurnData.turnNumber})
            </div>
            <div className="space-y-1.5">
              {activeToolCalls.map((tc, i) => {
                const dur = tc.duration || 0;
                const widthPct = maxDuration > 0 ? Math.max(2, (dur / maxDuration) * 100) : 2;
                return (
                  <div key={i}>
                    <div className="flex items-center justify-between text-[10px] mb-0.5">
                      <span className="text-zinc-400 truncate max-w-[120px]" title={tc.name}>
                        {tc.name}
                      </span>
                      <span className="text-zinc-500 tabular-nums font-mono">
                        {dur >= 1000 ? `${(dur / 1000).toFixed(1)}s` : `${dur}ms`}
                      </span>
                    </div>
                    <div className="h-1.5 bg-zinc-700 rounded-full overflow-hidden">
                      <div
                        className={`h-full rounded-full transition-all ${
                          tc.success ? 'bg-cyan-500/60' : 'bg-red-500/60'
                        }`}
                        style={{ width: `${widthPct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
