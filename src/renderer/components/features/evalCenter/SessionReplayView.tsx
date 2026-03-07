// ============================================================================
// SessionReplayView - 结构化会话回放（三栏布局）
// ============================================================================

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { useEvalCenterStore } from '../../../stores/evalCenterStore';
import { ReplayMessageBlock } from './ReplayMessageBlock';
import { ReplayAnalyticsSidebar } from './ReplayAnalyticsSidebar';

interface Props {
  sessionId: string;
  onRunEvaluation?: () => void;
}

export const SessionReplayView: React.FC<Props> = ({ sessionId, onRunEvaluation }) => {
  const { replayData, replayLoading, objective, loadReplay } = useEvalCenterStore();
  const [activeTurn, setActiveTurn] = useState(0);
  const turnRefs = useRef<Map<number, HTMLDivElement>>(new Map());

  useEffect(() => {
    if (sessionId) {
      loadReplay(sessionId);
    }
  }, [sessionId, loadReplay]);

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

  return (
    <div className="flex h-full min-h-0">
      {/* Left: Turn Navigator */}
      <div className="w-[140px] shrink-0 border-r border-zinc-700/30 overflow-y-auto">
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
                    : 'text-zinc-400 hover:bg-zinc-800/50 border border-transparent'
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
                <span className="text-zinc-700">|</span>
                <span>{turn.inputTokens + turn.outputTokens} tokens</span>
                <span className="text-zinc-700">|</span>
                <span>
                  {turn.durationMs >= 1000
                    ? `${(turn.durationMs / 1000).toFixed(1)}s`
                    : `${turn.durationMs}ms`}
                </span>
                {turn.startTime > 0 && (
                  <>
                    <span className="text-zinc-700">|</span>
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
              <div className="space-y-1.5 ml-2 border-l-2 border-zinc-700/30 pl-3">
                {turn.blocks.map((block, bIdx) => (
                  <ReplayMessageBlock key={bIdx} block={block} />
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Right: Analytics Sidebar */}
      <div className="w-[200px] shrink-0 border-l border-zinc-700/30 overflow-y-auto">
        <ReplayAnalyticsSidebar summary={replayData.summary} objective={objective} />
      </div>
    </div>
  );
};
