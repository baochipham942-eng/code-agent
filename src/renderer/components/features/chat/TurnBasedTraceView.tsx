// ============================================================================
// TurnBasedTraceView - Main container for turn-based trace display
// Uses react-virtuoso for virtual scrolling to handle 100+ turn sessions
// ============================================================================

import React, { useRef, useEffect, useCallback } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { TraceProjection } from '@shared/contract/trace';
import type { SearchMatch } from './ChatSearchBar';
import { TurnCard } from './TurnCard';
import { PermissionCard } from '../../PermissionDialog/PermissionCard';

interface TurnBasedTraceViewProps {
  projection: TraceProjection;
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  searchMatches?: SearchMatch[];
  activeMatchIndex?: number;
}

export function getFocusedTurnIndex(projection: TraceProjection): number {
  if (projection.turns.length === 0) return -1;
  if (
    projection.activeTurnIndex >= 0 &&
    projection.activeTurnIndex < projection.turns.length
  ) {
    return projection.activeTurnIndex;
  }
  return projection.turns.length - 1;
}

export function shouldFollowTurnOutput(isAtBottom: boolean): 'smooth' | false {
  return isAtBottom ? 'smooth' : false;
}

export const TurnBasedTraceView: React.FC<TurnBasedTraceViewProps> = ({
  projection,
  hasOlderMessages,
  isLoadingOlder,
  onLoadOlder,
  searchMatches = [],
  activeMatchIndex = 0,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const prevActiveMatchRef = useRef(-1);
  const prevFocusedTurnRef = useRef<string | null>(null);
  const focusedTurnIndex = getFocusedTurnIndex(projection);
  const focusedTurnId =
    focusedTurnIndex >= 0 ? projection.turns[focusedTurnIndex]?.turnId : undefined;

  // 让滚动条在两侧各占一半空间：
  // 否则 macOS scrollbar 吃掉父容器右边 6px，message 区 max-w-3xl 居中后比
  // ChatInput 区偏左 3px，跟 ChatInput 卡片左缘对不齐
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    if (el instanceof HTMLElement) {
      el.style.scrollbarGutter = 'stable both-edges';
    }
  }, []);

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

  useEffect(() => {
    if (focusedTurnIndex < 0 || !focusedTurnId) return;

    const focusKey = `${projection.sessionId}:${focusedTurnId}`;
    if (prevFocusedTurnRef.current === focusKey) return;
    prevFocusedTurnRef.current = focusKey;

    const scroll = () => {
      virtuosoRef.current?.scrollToIndex({
        index: focusedTurnIndex,
        align: 'start',
        behavior: 'auto',
      });
    };

    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(scroll);
      return () => cancelAnimationFrame(frame);
    }

    const timer = setTimeout(scroll, 0);
    return () => clearTimeout(timer);
  }, [projection.sessionId, focusedTurnId, focusedTurnIndex]);

  // Load older messages when scrolling to top
  const handleStartReached = useCallback(() => {
    if (!hasOlderMessages || isLoadingOlder || !onLoadOlder) return;
    onLoadOlder();
  }, [hasOlderMessages, isLoadingOlder, onLoadOlder]);

  // Keep bottom-follow opt-in; active/latest turns get their own top alignment.
  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      return shouldFollowTurnOutput(isAtBottom);
    },
    [],
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
        <div className="w-full px-4">
          <div className="max-w-3xl mx-auto">
            <TurnCard
              key={turn.turnId}
              turn={turn}
              defaultExpanded={isLast || isStreaming}
              forceExpanded={hasSearchMatch}
              highlightActive={isActiveMatchTurn}
            />
          </div>
        </div>
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

  // Footer: permission card (plan moved to PinnedTodoBar above the input)
  const Footer = useCallback(() => <PermissionCard />, []);

  return (
    <Virtuoso
      ref={virtuosoRef}
      role="log"
      aria-live="polite"
      aria-label="对话消息"
      className="h-full py-3 overflow-x-hidden"
      scrollerRef={handleScrollerRef}
      totalCount={projection.turns.length}
      itemContent={itemContent}
      followOutput={followOutput}
      initialTopMostItemIndex={focusedTurnIndex >= 0 ? focusedTurnIndex : undefined}
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
