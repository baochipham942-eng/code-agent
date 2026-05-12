// ============================================================================
// TurnBasedTraceView - Main container for turn-based trace display
// Uses react-virtuoso for virtual scrolling to handle 100+ turn sessions
// ============================================================================

import React, { useRef, useEffect, useCallback, useMemo, useState } from 'react';
import { Virtuoso, type VirtuosoHandle } from 'react-virtuoso';
import type { TraceProjection, TraceTurn } from '@shared/contract/trace';
import type { SearchMatch } from './ChatSearchBar';
import { TurnCard } from './TurnCard';
import { PermissionCard } from '../../PermissionDialog/PermissionCard';
import { useAppStore } from '../../../stores/appStore';
import { useSessionStore } from '../../../stores/sessionStore';
import { useTaskStore } from '../../../stores/taskStore';
import { recordStreamingPerformanceCounter } from '../../../utils/streamingPerformanceMetrics';

interface TurnBasedTraceViewProps {
  projection: TraceProjection;
  hasOlderMessages?: boolean;
  isLoadingOlder?: boolean;
  onLoadOlder?: () => void;
  searchMatches?: SearchMatch[];
  activeMatchIndex?: number;
  onRewindUserPrompt?: (messageId: string, content: string) => void;
}

export const ACTIVE_DISPLAY_SCROLL_INTERVAL_MS = 80;

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

export function shouldFollowTurnOutput(isAtBottom: boolean, keepActiveOutputVisible = false): 'auto' | 'smooth' | false {
  if (keepActiveOutputVisible) return 'auto';
  return isAtBottom ? 'smooth' : false;
}

export interface TurnOutputRevisionOptions {
  includeAssistantContentLength?: boolean;
}

export function getTurnOutputRevision(
  turn: TraceTurn | undefined,
  options: TurnOutputRevisionOptions = {},
): string | null {
  if (!turn) return null;

  const includeAssistantContentLength = options.includeAssistantContentLength ?? true;
  const outputNodes = turn.nodes
    .filter((node) => (
      node.type === 'assistant_text'
      || node.type === 'tool_call'
      || node.type === 'turn_timeline'
      || Boolean(node.reasoning)
      || Boolean(node.thinking)
    ))
    .map((node) => [
      node.id,
      node.type,
      node.type === 'assistant_text' && !includeAssistantContentLength
        ? 0
        : node.content?.length ?? 0,
      node.reasoning?.length ?? 0,
      node.thinking?.length ?? 0,
      node.toolCall?.result?.length ?? 0,
      node.toolCall?._streaming ? 1 : 0,
    ].join(':'));

  return `${turn.turnId}:${turn.status}:${outputNodes.join('|')}`;
}

function scheduleAfterLayout(callback: () => void): () => void {
  if (typeof requestAnimationFrame !== 'function') {
    const timer = setTimeout(callback, 0);
    return () => clearTimeout(timer);
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  const frame = requestAnimationFrame(() => {
    timer = setTimeout(callback, 0);
  });

  return () => {
    cancelAnimationFrame(frame);
    if (timer !== null) clearTimeout(timer);
  };
}

function scheduleAfterDelayAndLayout(callback: () => void, delayMs: number): () => void {
  if (delayMs <= 0) {
    return scheduleAfterLayout(callback);
  }

  let cancelLayout: (() => void) | null = null;
  const timer = setTimeout(() => {
    cancelLayout = scheduleAfterLayout(callback);
  }, delayMs);

  return () => {
    clearTimeout(timer);
    cancelLayout?.();
  };
}

export function getActiveDisplayScrollDelay(
  lastScrollAt: number,
  now: number,
  intervalMs = ACTIVE_DISPLAY_SCROLL_INTERVAL_MS,
): number {
  if (lastScrollAt <= 0) return 0;
  return Math.max(0, intervalMs - (now - lastScrollAt));
}

export function shouldShowTurnTimeSeparator(previousTurn: { startTime: number } | null, currentTurn: { startTime: number }): boolean {
  if (!previousTurn) return true;
  const gapMs = currentTurn.startTime - previousTurn.startTime;
  return gapMs >= 5 * 60 * 1000;
}

function escapeAttributeSelector(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function getTraceNodeSelector(nodeId: string, nodeType: string): string {
  return `[data-trace-node-id="${escapeAttributeSelector(nodeId)}"][data-trace-node-type="${escapeAttributeSelector(nodeType)}"]`;
}

export function getActiveAssistantTextAnchor(projection: TraceProjection): {
  turnIndex: number;
  nodeId: string;
  nodeType: 'assistant_text';
} | null {
  const turnIndex = getFocusedTurnIndex(projection);
  if (turnIndex < 0) return null;

  const turn = projection.turns[turnIndex];
  if (!turn) return null;

  const node = turn.nodes.find((candidate) => (
    candidate.type === 'assistant_text'
    && Boolean(candidate.content?.trim())
  ));
  if (!node) return null;

  return {
    turnIndex,
    nodeId: node.id,
    nodeType: 'assistant_text',
  };
}

export const TurnBasedTraceView: React.FC<TurnBasedTraceViewProps> = ({
  projection,
  hasOlderMessages,
  isLoadingOlder,
  onLoadOlder,
  searchMatches = [],
  activeMatchIndex = 0,
  onRewindUserPrompt,
}) => {
  const virtuosoRef = useRef<VirtuosoHandle>(null);
  const scrollerElementRef = useRef<HTMLElement | null>(null);
  const [scrollerElement, setScrollerElement] = useState<HTMLElement | null>(null);
  const prevActiveMatchRef = useRef(-1);
  const prevFocusedTurnRef = useRef<string | null>(null);
  const prevAssistantAnchorRef = useRef<string | null>(null);
  const activeDisplayScrollCancelRef = useRef<(() => void) | null>(null);
  const activeDisplayScrollLastAtRef = useRef(0);
  const keepActiveOutputVisibleRef = useRef(false);
  const currentSessionId = useSessionStore((state) => state.currentSessionId);
  const streamSnapshot = useSessionStore((state) => state.streamSnapshot);
  const processingSessionIds = useAppStore((state) => state.processingSessionIds);
  const sessionStatus = useTaskStore((state) => state.sessionStates[projection.sessionId]?.status ?? null);
  const isProjectionSessionProcessing = processingSessionIds.has(projection.sessionId)
    || sessionStatus === 'running'
    || sessionStatus === 'queued'
    || sessionStatus === 'cancelling';
  const projectionStreamSnapshot = currentSessionId === projection.sessionId
    ? streamSnapshot
    : null;
  const focusedTurnIndex = getFocusedTurnIndex(projection);
  const focusedTurnId =
    focusedTurnIndex >= 0 ? projection.turns[focusedTurnIndex]?.turnId : undefined;
  const activeTurn = projection.activeTurnIndex >= 0
    ? projection.turns[projection.activeTurnIndex]
    : undefined;
  const activeTurnOutputRevision = useMemo(
    () => getTurnOutputRevision(activeTurn, {
      includeAssistantContentLength: activeTurn?.status !== 'streaming',
    }),
    [activeTurn],
  );
  const hasActiveTurnOutput = projection.activeTurnIndex >= 0 && Boolean(activeTurnOutputRevision);

  // 让滚动条在两侧各占一半空间：
  // 否则 macOS scrollbar 吃掉父容器右边 6px，message 区 max-w-3xl 居中后比
  // ChatInput 区偏左 3px，跟 ChatInput 卡片左缘对不齐
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    if (el instanceof HTMLElement) {
      scrollerElementRef.current = el;
      setScrollerElement(el);
      el.style.scrollbarGutter = 'stable both-edges';
    } else {
      scrollerElementRef.current = null;
      setScrollerElement(null);
    }
  }, []);

  useEffect(() => {
    return () => {
      activeDisplayScrollCancelRef.current?.();
      activeDisplayScrollCancelRef.current = null;
    };
  }, []);

  useEffect(() => {
    const scroller = scrollerElement;
    if (!scroller) return;

    const stopFollowing = () => {
      keepActiveOutputVisibleRef.current = false;
    };
    const handleWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) stopFollowing();
    };
    const handleTouchMove = () => stopFollowing();
    const handleKeyDown = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home', ' ', 'Space'].includes(event.key)) {
        stopFollowing();
      }
    };

    scroller.addEventListener('wheel', handleWheel, { passive: true });
    scroller.addEventListener('touchmove', handleTouchMove, { passive: true });
    scroller.addEventListener('keydown', handleKeyDown);

    return () => {
      scroller.removeEventListener('wheel', handleWheel);
      scroller.removeEventListener('touchmove', handleTouchMove);
      scroller.removeEventListener('keydown', handleKeyDown);
    };
  }, [scrollerElement]);

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
    keepActiveOutputVisibleRef.current = projection.activeTurnIndex === focusedTurnIndex;

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

  const activeAssistantAnchor = useMemo(() => (
    getActiveAssistantTextAnchor(projection)
  ), [projection]);

  useEffect(() => {
    if (!activeAssistantAnchor || !focusedTurnId) return;

    const focusKey = `${projection.sessionId}:${focusedTurnId}:${activeAssistantAnchor.nodeId}`;
    if (prevAssistantAnchorRef.current === focusKey) return;
    prevAssistantAnchorRef.current = focusKey;
    keepActiveOutputVisibleRef.current = projection.activeTurnIndex === activeAssistantAnchor.turnIndex;

    const scroll = () => {
      virtuosoRef.current?.scrollToIndex({
        index: activeAssistantAnchor.turnIndex,
        align: 'start',
        behavior: 'auto',
      });

      setTimeout(() => {
        const scroller = scrollerElementRef.current;
        const target = scroller?.querySelector<HTMLElement>(
          getTraceNodeSelector(activeAssistantAnchor.nodeId, activeAssistantAnchor.nodeType),
        );
        target?.scrollIntoView({ block: 'start', behavior: 'auto' });
      }, 0);
    };

    if (typeof requestAnimationFrame === 'function') {
      const frame = requestAnimationFrame(scroll);
      return () => cancelAnimationFrame(frame);
    }

    const timer = setTimeout(scroll, 0);
    return () => clearTimeout(timer);
  }, [activeAssistantAnchor, focusedTurnId, projection.sessionId]);

  // 用户发新消息时，把这条 user msg 顶到视图上方（让下面的 streaming 内容有空间展开）
  // 现有 L76 effect 只 react to turnId 变化，supplement 模式（in-flight 追加 user msg
  // 到当前 turn）turnId 不变，不会触发 scroll。加这个 effect 监听最新 user node id：
  // - 新开 turn：latestUserNodeId 变（同时 turnId 也变，跟 L76 重复但 prev ref 防止重 scroll）
  // - supplement 追加：latestUserNodeId 变，但 turnId 不变 — 这是关键修复
  const latestUserNodeId = useMemo(() => {
    for (let i = projection.turns.length - 1; i >= 0; i--) {
      const nodes = projection.turns[i].nodes;
      for (let j = nodes.length - 1; j >= 0; j--) {
        if (nodes[j].type === 'user') return nodes[j].id;
      }
    }
    return null;
  }, [projection.turns]);

  const prevLatestUserIdRef = useRef<string | null>(null);
  const prevSessionIdForUserScrollRef = useRef<string | null>(null);

  useEffect(() => {
    // 切换会话：只 sync prev ref，不主动滚动（避免历史会话被强行 jump）
    if (prevSessionIdForUserScrollRef.current !== projection.sessionId) {
      prevSessionIdForUserScrollRef.current = projection.sessionId;
      prevLatestUserIdRef.current = latestUserNodeId;
      return;
    }
    if (!latestUserNodeId) return;
    if (prevLatestUserIdRef.current === latestUserNodeId) return;
    prevLatestUserIdRef.current = latestUserNodeId;
    keepActiveOutputVisibleRef.current = true;

    // 找到包含这条 user msg 的 turn index
    let targetIndex = -1;
    for (let i = projection.turns.length - 1; i >= 0; i--) {
      if (projection.turns[i].nodes.some((n) => n.id === latestUserNodeId)) {
        targetIndex = i;
        break;
      }
    }
    if (targetIndex < 0) return;

    // 下一帧 scroll，让 Virtuoso 先 render 新 item 再定位
    const frame = requestAnimationFrame(() => {
      virtuosoRef.current?.scrollToIndex({
        index: targetIndex,
        align: 'start',
        behavior: 'auto',
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [latestUserNodeId, projection.sessionId, projection.turns]);

  useEffect(() => {
    if (!activeTurnOutputRevision) return;
    if (projection.activeTurnIndex < 0) return;
    if (!keepActiveOutputVisibleRef.current) return;

    return scheduleAfterLayout(() => {
      virtuosoRef.current?.scrollToIndex({
        index: projection.activeTurnIndex,
        align: 'end',
        behavior: 'auto',
      });
    });
  }, [activeTurnOutputRevision, projection.activeTurnIndex]);

  const scheduleActiveDisplayScroll = useCallback((turnIndex: number) => {
    if (!keepActiveOutputVisibleRef.current) return;
    if (turnIndex !== projection.activeTurnIndex) return;
    if (activeDisplayScrollCancelRef.current) return;

    const delay = getActiveDisplayScrollDelay(
      activeDisplayScrollLastAtRef.current,
      Date.now(),
    );

    activeDisplayScrollCancelRef.current = scheduleAfterDelayAndLayout(
      () => {
        activeDisplayScrollCancelRef.current = null;
        if (!keepActiveOutputVisibleRef.current) return;
        if (turnIndex !== projection.activeTurnIndex) return;
        activeDisplayScrollLastAtRef.current = Date.now();
        recordStreamingPerformanceCounter('stream.active_display_scroll');
        virtuosoRef.current?.scrollToIndex({
          index: turnIndex,
          align: 'end',
          behavior: 'auto',
        });
      },
      delay,
    );
  }, [projection.activeTurnIndex]);

  // Load older messages when scrolling to top
  const handleStartReached = useCallback(() => {
    if (!hasOlderMessages || isLoadingOlder || !onLoadOlder) return;
    onLoadOlder();
  }, [hasOlderMessages, isLoadingOlder, onLoadOlder]);

  // Keep bottom-follow opt-in; active/latest turns get their own top alignment.
  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      return shouldFollowTurnOutput(
        isAtBottom,
        hasActiveTurnOutput && keepActiveOutputVisibleRef.current,
      );
    },
    [hasActiveTurnOutput],
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
      const exposesSessionRuntime = isLast || isStreaming;
      const previousTurn = index > 0 ? projection.turns[index - 1] : null;

      return (
        <div className="w-full px-4">
          <div className="max-w-3xl mx-auto">
            <TurnCard
              key={turn.turnId}
              turn={turn}
              defaultExpanded={isLast || isStreaming}
              forceExpanded={hasSearchMatch}
              highlightActive={isActiveMatchTurn}
              isActiveTurn={isStreaming}
              sessionStatus={exposesSessionRuntime ? sessionStatus : null}
              isSessionProcessing={exposesSessionRuntime ? isProjectionSessionProcessing : false}
              streamSnapshot={projectionStreamSnapshot}
              showSeparator={shouldShowTurnTimeSeparator(previousTurn, turn)}
              onStreamingDisplayUpdate={
                isStreaming ? () => scheduleActiveDisplayScroll(index) : undefined
              }
              onRewindUserPrompt={onRewindUserPrompt}
            />
          </div>
        </div>
      );
    },
    [activeMatchIndex, isProjectionSessionProcessing, onRewindUserPrompt, projection.activeTurnIndex, projection.turns, projectionStreamSnapshot, scheduleActiveDisplayScroll, searchMatches, sessionStatus],
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
      className="h-full min-h-0 py-3 overflow-x-hidden"
      scrollerRef={handleScrollerRef}
      totalCount={projection.turns.length}
      itemContent={itemContent}
      followOutput={followOutput}
      atBottomStateChange={(atBottom) => {
        if (atBottom) keepActiveOutputVisibleRef.current = true;
      }}
      atBottomThreshold={96}
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
