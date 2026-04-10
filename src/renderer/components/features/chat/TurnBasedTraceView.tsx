// ============================================================================
// TurnBasedTraceView - Main container for turn-based trace display
// Uses react-virtuoso for virtual scrolling to handle 100+ turn sessions
// ============================================================================

import React, { useRef, useEffect, useCallback } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { TraceProjection } from '@shared/types/trace';
import type { TaskPlan } from '@shared/types';
import type { SearchMatch } from './ChatSearchBar';
import { TurnCard } from './TurnCard';
import { PermissionCard } from '../../PermissionDialog/PermissionCard';
import { InlinePlanCard } from './InlinePlanCard';

interface TurnBasedTraceViewProps {
  projection: TraceProjection;
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  plan?: TaskPlan | null;
  searchMatches?: SearchMatch[];
  activeMatchIndex?: number;
}

export const TurnBasedTraceView: React.FC<TurnBasedTraceViewProps> = ({
  projection,
  hasOlderMessages,
  isLoadingOlder,
  onLoadOlder,
  plan,
  searchMatches = [],
  activeMatchIndex = 0,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const prevActiveMatchRef = useRef(-1);

  // Scroll to active search match when it changes
  useEffect(() => {
    if (searchMatches.length === 0) return;
    const activeMatch = searchMatches[activeMatchIndex];
    if (!activeMatch) return;
    if (activeMatchIndex === prevActiveMatchRef.current) return;
    prevActiveMatchRef.current = activeMatchIndex;

    virtuosoRef.current?.scrollToIndex({
      index: activeMatch.turnIndex,
      align: 'center',
      behavior: 'smooth',
    });
  }, [activeMatchIndex, searchMatches]);

  // Load older messages when scrolling to top
  const handleStartReached = useCallback(() => {
    if (!hasOlderMessages || isLoadingOlder || !onLoadOlder) return;
    onLoadOlder();
  }, [hasOlderMessages, isLoadingOlder, onLoadOlder]);

  // Auto-follow output: keep scrolled to bottom during streaming
  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      const isStreaming = projection.activeTurnIndex >= 0;
      // Follow if streaming or if already at bottom
      if (isStreaming) return 'smooth';
      if (isAtBottom) return 'smooth';
      return false;
    },
    [projection.activeTurnIndex],
  );

  // Render individual turn card
  const itemContent = useCallback(
    (index: number) => {
      const turn = projection.turns[index];
      if (!turn) return null;

      const isLast = index === projection.turns.length - 1;
      const isStreaming = index === projection.activeTurnIndex;
      const hasSearchMatch = searchMatches.some(m => m.turnIndex === index);
      const activeMatch = searchMatches.length > 0 ? searchMatches[activeMatchIndex] : undefined;
      const isActiveMatchTurn = activeMatch?.turnIndex === index;

      return (
        <TurnCard
          key={turn.turnId}
          turn={turn}
          defaultExpanded={isLast || isStreaming}
          forceExpanded={hasSearchMatch}
          highlightActive={isActiveMatchTurn}
        />
      );
    },
    [projection.turns, projection.activeTurnIndex, searchMatches, activeMatchIndex],
  );

  // Header: load-older indicator
  const Header = useCallback(() => {
    if (!hasOlderMessages) return null;
    return (
      <div className="flex justify-center py-3 text-zinc-500 text-sm">
        {isLoadingOlder ? '加载更早的消息...' : '↑ 滚动加载更多'}
      </div>
    );
  }, [hasOlderMessages, isLoadingOlder]);

  // Footer: plan card + permission card
  const Footer = useCallback(() => (
    <>
      {plan && <InlinePlanCard plan={plan} />}
      <PermissionCard />
    </>
  ), [plan]);

  return (
    <Virtuoso
      ref={virtuosoRef}
      role="log"
      aria-live="polite"
      aria-label="对话消息"
      className="h-full px-4 py-3 overflow-x-hidden"
      totalCount={projection.turns.length}
      itemContent={itemContent}
      followOutput={followOutput}
      startReached={handleStartReached}
      overscan={300}
      increaseViewportBy={{ top: 200, bottom: 200 }}
      defaultItemHeight={80}
      components={{
        Header,
        Footer,
      }}
    />
  );
};
