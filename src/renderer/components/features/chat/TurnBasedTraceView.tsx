// ============================================================================
// TurnBasedTraceView - Main container for turn-based trace display
// Replaces Virtuoso flat message list with grouped turn cards
// ============================================================================

import React, { useRef, useEffect } from 'react';
import type { TraceProjection } from '@shared/types/trace';
import { TurnCard } from './TurnCard';

interface TurnBasedTraceViewProps {
  projection: TraceProjection;
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
}

export const TurnBasedTraceView: React.FC<TurnBasedTraceViewProps> = ({
  projection,
  hasOlderMessages,
  isLoadingOlder,
  onLoadOlder,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const prevTurnCountRef = useRef(0);

  // Auto-scroll to bottom when new turns arrive or streaming
  useEffect(() => {
    const turnCount = projection.turns.length;
    const isStreaming = projection.activeTurnIndex >= 0;

    // Scroll on new turn or during streaming
    if (turnCount > prevTurnCountRef.current || isStreaming) {
      bottomRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' });
    }
    prevTurnCountRef.current = turnCount;
  }, [projection.turns, projection.activeTurnIndex]);

  // Scroll-to-top detection for loading older messages
  const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
    if (!hasOlderMessages || isLoadingOlder || !onLoadOlder) return;
    const { scrollTop } = e.currentTarget;
    if (scrollTop < 50) {
      onLoadOlder();
    }
  };

  return (
    <div
      ref={containerRef}
      className="h-full overflow-y-auto px-4 py-3"
      onScroll={handleScroll}
    >
      {/* Load older indicator */}
      {hasOlderMessages && (
        <div className="flex justify-center py-3 text-zinc-500 text-sm">
          {isLoadingOlder ? '加载更早的消息...' : '↑ 滚动加载更多'}
        </div>
      )}

      {/* Turn cards */}
      {projection.turns.map((turn, index) => {
        // Latest turn defaults to expanded, others collapsed
        const isLast = index === projection.turns.length - 1;
        const isStreaming = index === projection.activeTurnIndex;

        return (
          <TurnCard
            key={turn.turnId}
            turn={turn}
            defaultExpanded={isLast || isStreaming}
          />
        );
      })}

      {/* Scroll anchor */}
      <div ref={bottomRef} />
    </div>
  );
};
