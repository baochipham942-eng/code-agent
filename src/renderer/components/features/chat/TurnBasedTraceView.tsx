// ============================================================================
// TurnBasedTraceView - Main container for turn-based trace display
// Uses react-virtuoso for virtual scrolling to handle 100+ turn sessions
// ============================================================================

import React, { useRef, useEffect, useLayoutEffect, useCallback, useMemo, useState } from 'react';
import { ArrowDown } from 'lucide-react';
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
export const USER_SCROLL_PROGRAMMATIC_PAUSE_MS = 280;

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

export function isProgrammaticScrollSuppressed(suppressionUntil: number, now: number): boolean {
  return suppressionUntil > now;
}

export function getUserScrollSuppressionUntil(
  now: number,
  pauseMs = USER_SCROLL_PROGRAMMATIC_PAUSE_MS,
): number {
  return now + pauseMs;
}

export function shouldStopFollowingForWheel(deltaY: number): boolean {
  return deltaY < 0;
}

export function shouldStopFollowingForTouchMove(
  startY: number | null,
  currentY: number,
  threshold = 2,
): boolean {
  return startY !== null && currentY > startY + threshold;
}

export function shouldStopFollowingForKeyboardScroll(key: string, shiftKey = false): boolean {
  return key === 'ArrowUp'
    || key === 'PageUp'
    || key === 'Home'
    || (key === ' ' && shiftKey)
    || (key === 'Space' && shiftKey);
}

export function shouldFollowTurnOutput(
  isAtBottom: boolean,
  keepActiveOutputVisible = false,
  userScrollSuppressed = false,
): 'auto' | false {
  if (userScrollSuppressed) return false;
  if (keepActiveOutputVisible) return 'auto';
  return isAtBottom ? 'auto' : false;
}

export function isScrollerNearBottom(
  scroller: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = 96,
): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= threshold;
}

export function getOutputFollowTurnIndex(
  projection: TraceProjection,
  followedTurnId: string | null,
  keepOutputVisible: boolean,
): number {
  if (
    projection.activeTurnIndex >= 0 &&
    projection.activeTurnIndex < projection.turns.length
  ) {
    return projection.activeTurnIndex;
  }

  if (!keepOutputVisible || !followedTurnId) return -1;
  return projection.turns.findIndex((turn) => turn.turnId === followedTurnId);
}

export interface TurnOutputRevisionOptions {
  includeAssistantContentLength?: boolean;
  includeThinkingLength?: boolean;
}

export function getTurnOutputRevision(
  turn: TraceTurn | undefined,
  options: TurnOutputRevisionOptions = {},
): string | null {
  if (!turn) return null;

  const includeAssistantContentLength = options.includeAssistantContentLength ?? true;
  const includeThinkingLength = options.includeThinkingLength ?? true;
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
      includeThinkingLength ? node.reasoning?.length ?? 0 : 0,
      includeThinkingLength ? node.thinking?.length ?? 0 : 0,
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

const TRACE_TURN_ANCHOR_SELECTOR = '[data-trace-turn-id]';

export function getTraceTurnSelector(turnId: string): string {
  return `[data-trace-turn-id="${escapeAttributeSelector(turnId)}"]`;
}

export function getPrependedTurnCount(previousFirstTurnId: string | null, turns: TraceTurn[]): number {
  if (!previousFirstTurnId || turns[0]?.turnId === previousFirstTurnId) return 0;
  const previousFirstIndex = turns.findIndex((turn) => turn.turnId === previousFirstTurnId);
  return previousFirstIndex > 0 ? previousFirstIndex : 0;
}

interface PrependViewportAnchor {
  sessionId: string;
  turnId: string;
  offsetTop: number;
}

export function getPrependAnchorScrollLocation(
  anchor: PrependViewportAnchor | null,
  sessionId: string,
  turns: TraceTurn[],
): { index: number; align: 'start'; behavior: 'auto'; offset: number } | null {
  if (anchor?.sessionId !== sessionId) return null;
  const index = turns.findIndex((turn) => turn.turnId === anchor.turnId);
  if (index < 0) return null;
  return { index, align: 'start', behavior: 'auto', offset: -anchor.offsetTop };
}

export function getPrependAnchorScrollCorrection(expectedOffsetTop: number, actualOffsetTop: number): number {
  return actualOffsetTop - expectedOffsetTop;
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
  const historyListRef = useRef<{ sessionId: string; firstTurnId: string | null; firstItemIndex: number }>({
    sessionId: projection.sessionId,
    firstTurnId: projection.turns[0]?.turnId ?? null,
    firstItemIndex: 1_000_000,
  });
  const activeDisplayScrollCancelRef = useRef<(() => void) | null>(null);
  const activeDisplayScrollLastAtRef = useRef(0);
  const userScrollSuppressUntilRef = useRef(0);
  const touchStartYRef = useRef<number | null>(null);
  const keepActiveOutputVisibleRef = useRef(false);
  const historyPrependInProgressRef = useRef(false);
  const prependViewportAnchorRef = useRef<PrependViewportAnchor | null>(null);
  const followedOutputSessionIdRef = useRef<string | null>(null);
  const followedOutputTurnIdRef = useRef<string | null>(null);
  const [followedOutputTurnId, setFollowedOutputTurnId] = useState<string | null>(null);
  // 用户上滚离开底部时浮出「回到底部」按钮（贴底时隐藏）
  const [isAtBottom, setIsAtBottom] = useState(true);
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
  const outputFollowTurnIndex = getOutputFollowTurnIndex(
    projection,
    followedOutputTurnId,
    keepActiveOutputVisibleRef.current,
  );
  const outputFollowTurn = outputFollowTurnIndex >= 0
    ? projection.turns[outputFollowTurnIndex]
    : undefined;
  const outputFollowRevision = useMemo(
    () => getTurnOutputRevision(outputFollowTurn, {
      includeAssistantContentLength: outputFollowTurn?.status !== 'streaming',
      includeThinkingLength: outputFollowTurn?.status !== 'streaming',
    }),
    [outputFollowTurn],
  );
  const hasOutputFollowTurnOutput = outputFollowTurnIndex >= 0 && Boolean(outputFollowRevision);

  const firstTurnId = projection.turns[0]?.turnId ?? null;
  const previousHistoryList = historyListRef.current;
  const prependedTurnCount = previousHistoryList.sessionId === projection.sessionId
    ? getPrependedTurnCount(previousHistoryList.firstTurnId, projection.turns)
    : 0;
  if (prependedTurnCount > 0) historyPrependInProgressRef.current = true;
  const firstItemIndex = previousHistoryList.sessionId === projection.sessionId
    ? previousHistoryList.firstItemIndex - prependedTurnCount
    : 1_000_000;
  historyListRef.current = { sessionId: projection.sessionId, firstTurnId, firstItemIndex };

  useLayoutEffect(() => {
    if (prependedTurnCount <= 0) return;
    const anchor = prependViewportAnchorRef.current;
    const location = getPrependAnchorScrollLocation(
      anchor,
      projection.sessionId,
      projection.turns,
    );
    if (!location || !anchor) return;
    let cancelCorrection: (() => void) | null = null;
    const cancelPosition = scheduleAfterLayout(() => {
      virtuosoRef.current?.scrollToIndex(location);
      cancelCorrection = scheduleAfterLayout(() => {
        const scroller = scrollerElementRef.current;
        const anchoredTurn = scroller?.querySelector<HTMLElement>(getTraceTurnSelector(anchor.turnId));
        if (!scroller || !anchoredTurn) return;
        const actualOffsetTop = anchoredTurn.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        scroller.scrollTop += getPrependAnchorScrollCorrection(anchor.offsetTop, actualOffsetTop);
      });
    });
    return () => {
      cancelPosition();
      cancelCorrection?.();
    };
  }, [firstItemIndex, prependedTurnCount, projection.sessionId, projection.turns]);

  useEffect(() => {
    if (!historyPrependInProgressRef.current) return;
    let cancelSecond: (() => void) | null = null;
    const cancelFirst = scheduleAfterLayout(() => {
      cancelSecond = scheduleAfterLayout(() => {
        historyPrependInProgressRef.current = false;
      });
    });
    return () => {
      cancelFirst();
      cancelSecond?.();
    };
  }, [firstItemIndex]);

  // 让滚动条在两侧各占一半空间：
  // 否则 macOS scrollbar 吃掉父容器右边 6px，message 区 max-w-3xl 居中后比
  // ChatInput 区偏左 3px，跟 ChatInput 卡片左缘对不齐
  const handleScrollerRef = useCallback((el: HTMLElement | Window | null) => {
    if (el instanceof HTMLElement) {
      scrollerElementRef.current = el;
      setScrollerElement(el);
      el.style.scrollbarGutter = 'stable both-edges';
      el.style.overscrollBehaviorY = 'contain';
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

  const updateFollowedOutputTurnId = useCallback((turnId: string | null) => {
    followedOutputTurnIdRef.current = turnId;
    setFollowedOutputTurnId((current) => current === turnId ? current : turnId);
  }, []);

  const isUserScrollSuppressed = useCallback(() => (
    isProgrammaticScrollSuppressed(userScrollSuppressUntilRef.current, Date.now())
  ), []);

  const markUserScrollInteraction = useCallback((now = Date.now()) => {
    userScrollSuppressUntilRef.current = getUserScrollSuppressionUntil(now);
    activeDisplayScrollCancelRef.current?.();
    activeDisplayScrollCancelRef.current = null;
  }, []);

  useEffect(() => {
    if (followedOutputSessionIdRef.current !== projection.sessionId) {
      followedOutputSessionIdRef.current = projection.sessionId;
      updateFollowedOutputTurnId(null);
    }

    if (projection.activeTurnIndex >= 0 && activeTurn?.turnId) {
      updateFollowedOutputTurnId(activeTurn.turnId);
    }
  }, [activeTurn?.turnId, projection.activeTurnIndex, projection.sessionId, updateFollowedOutputTurnId]);

  useEffect(() => {
    const scroller = scrollerElement;
    if (!scroller) return;

    const capturePrependAnchor = () => {
      const scrollerRect = scroller.getBoundingClientRect();
      const visibleTurn = Array.from(scroller.querySelectorAll<HTMLElement>(TRACE_TURN_ANCHOR_SELECTOR))
        .map((element) => ({ element, rect: element.getBoundingClientRect() }))
        .filter(({ rect }) => rect.bottom >= scrollerRect.top && rect.top <= scrollerRect.bottom)
        .sort((left, right) => left.rect.top - right.rect.top)[0];
      if (!visibleTurn?.element.dataset.traceTurnId) return;
      prependViewportAnchorRef.current = {
        sessionId: projection.sessionId,
        turnId: visibleTurn.element.dataset.traceTurnId,
        offsetTop: visibleTurn.rect.top - scrollerRect.top,
      };
    };
    let captureFrame: number | null = null;
    const schedulePrependAnchorCapture = () => {
      if (captureFrame !== null) cancelAnimationFrame(captureFrame);
      captureFrame = requestAnimationFrame(() => {
        captureFrame = null;
        capturePrependAnchor();
      });
    };

    const stopFollowing = () => {
      keepActiveOutputVisibleRef.current = false;
    };
    const handleWheel = (event: WheelEvent) => {
      markUserScrollInteraction();
      if (shouldStopFollowingForWheel(event.deltaY)) stopFollowing();
    };
    const handleTouchStart = (event: TouchEvent) => {
      touchStartYRef.current = event.touches[0]?.clientY ?? null;
    };
    const handleTouchMove = (event: TouchEvent) => {
      markUserScrollInteraction();
      const currentY = event.touches[0]?.clientY;
      if (typeof currentY === 'number' && shouldStopFollowingForTouchMove(touchStartYRef.current, currentY)) {
        stopFollowing();
      }
    };
    const handleTouchEnd = () => {
      touchStartYRef.current = null;
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (!['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Space'].includes(event.key)) {
        return;
      }
      markUserScrollInteraction();
      if (shouldStopFollowingForKeyboardScroll(event.key, event.shiftKey)) {
        stopFollowing();
      }
    };

    scroller.addEventListener('wheel', handleWheel, { passive: true });
    scroller.addEventListener('touchstart', handleTouchStart, { passive: true });
    scroller.addEventListener('touchmove', handleTouchMove, { passive: true });
    scroller.addEventListener('touchend', handleTouchEnd, { passive: true });
    scroller.addEventListener('touchcancel', handleTouchEnd, { passive: true });
    scroller.addEventListener('keydown', handleKeyDown);
    scroller.addEventListener('scroll', schedulePrependAnchorCapture, { passive: true });
    schedulePrependAnchorCapture();

    return () => {
      if (captureFrame !== null) cancelAnimationFrame(captureFrame);
      scroller.removeEventListener('wheel', handleWheel);
      scroller.removeEventListener('touchstart', handleTouchStart);
      scroller.removeEventListener('touchmove', handleTouchMove);
      scroller.removeEventListener('touchend', handleTouchEnd);
      scroller.removeEventListener('touchcancel', handleTouchEnd);
      scroller.removeEventListener('keydown', handleKeyDown);
      scroller.removeEventListener('scroll', schedulePrependAnchorCapture);
    };
  }, [markUserScrollInteraction, projection.sessionId, scrollerElement]);

  useEffect(() => {
    const scroller = scrollerElement;
    if (!scroller) return;

    const handleClickCapture = (event: MouseEvent) => {
      if (!(event.target instanceof Element)) return;
      if (!isScrollerNearBottom(scroller)) return;

      const turnElement = event.target.closest<HTMLElement>(TRACE_TURN_ANCHOR_SELECTOR);
      const turnId = turnElement?.dataset.traceTurnId;
      if (!turnId) return;

      const latestTurn = projection.turns[projection.turns.length - 1];
      if (turnId !== latestTurn?.turnId && turnId !== followedOutputTurnIdRef.current) return;

      keepActiveOutputVisibleRef.current = true;
      updateFollowedOutputTurnId(turnId);
    };

    scroller.addEventListener('click', handleClickCapture, true);
    return () => scroller.removeEventListener('click', handleClickCapture, true);
  }, [projection.turns, scrollerElement, updateFollowedOutputTurnId]);

  // Scroll to active search match when it changes
  useEffect(() => {
    if (searchMatches.length === 0) return;
    const activeMatch = searchMatches[activeMatchIndex];
    if (!activeMatch) return;
    if (activeMatchIndex === prevActiveMatchRef.current) return;
    prevActiveMatchRef.current = activeMatchIndex;
    keepActiveOutputVisibleRef.current = false;
    activeDisplayScrollCancelRef.current?.();
    activeDisplayScrollCancelRef.current = null;

    virtuosoRef.current?.scrollToIndex({
      index: activeMatch.turnIndex,
      align: 'center',
      // Search is exact navigation. Long virtualized jumps can be dropped or
      // left unfinished when animated across hundreds of unmounted items.
      behavior: 'auto',
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
    if (!outputFollowRevision) return;
    if (outputFollowTurnIndex < 0) return;
    if (!keepActiveOutputVisibleRef.current) return;
    if (isUserScrollSuppressed()) return;

    return scheduleAfterLayout(() => {
      if (isUserScrollSuppressed()) return;
      virtuosoRef.current?.scrollToIndex({
        index: outputFollowTurnIndex,
        align: 'end',
        behavior: 'auto',
      });
    });
  }, [isUserScrollSuppressed, outputFollowRevision, outputFollowTurnIndex]);

  const scheduleActiveDisplayScroll = useCallback((turnIndex: number) => {
    if (!keepActiveOutputVisibleRef.current) return;
    if (isUserScrollSuppressed()) return;
    if (turnIndex !== outputFollowTurnIndex) return;
    if (activeDisplayScrollCancelRef.current) return;

    const delay = getActiveDisplayScrollDelay(
      activeDisplayScrollLastAtRef.current,
      Date.now(),
    );

    activeDisplayScrollCancelRef.current = scheduleAfterDelayAndLayout(
      () => {
        activeDisplayScrollCancelRef.current = null;
        if (!keepActiveOutputVisibleRef.current) return;
        if (isUserScrollSuppressed()) return;
        if (turnIndex !== outputFollowTurnIndex) return;
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
  }, [isUserScrollSuppressed, outputFollowTurnIndex]);

  useEffect(() => {
    const scroller = scrollerElement;
    const turnId = outputFollowTurn?.turnId;
    if (!scroller || !turnId || outputFollowTurnIndex < 0) return;
    if (typeof ResizeObserver !== 'function') return;

    const turnSelector = getTraceTurnSelector(turnId);
    const targets = Array.from(scroller.querySelectorAll<HTMLElement>(TRACE_TURN_ANCHOR_SELECTOR));
    if (!targets.some((target) => target.matches(turnSelector))) return;

    const lastHeights = new WeakMap<Element, number>();
    const observer = new ResizeObserver((entries) => {
      const hasHeightChange = entries.some((entry) => {
        const lastHeight = lastHeights.get(entry.target);
        const nextHeight = entry.contentRect.height;
        if (lastHeight === nextHeight) return false;
        lastHeights.set(entry.target, nextHeight);
        return true;
      });
      if (!hasHeightChange) return;
      scheduleActiveDisplayScroll(outputFollowTurnIndex);
    });

    targets.forEach((target) => {
      lastHeights.set(target, target.getBoundingClientRect().height);
      observer.observe(target);
    });
    return () => observer.disconnect();
  }, [outputFollowTurn?.turnId, outputFollowTurnIndex, scheduleActiveDisplayScroll, scrollerElement]);

  // Load older messages when scrolling to top
  const handleStartReached = useCallback(() => {
    if (!hasOlderMessages || isLoadingOlder || !onLoadOlder) return;
    onLoadOlder();
  }, [hasOlderMessages, isLoadingOlder, onLoadOlder]);

  // Keep bottom-follow opt-in; active/latest turns get their own top alignment.
  const followOutput = useCallback(
    (isAtBottom: boolean) => {
      if (historyPrependInProgressRef.current) return false;
      return shouldFollowTurnOutput(
        isAtBottom,
        hasOutputFollowTurnOutput && keepActiveOutputVisibleRef.current,
        isUserScrollSuppressed(),
      );
    },
    [hasOutputFollowTurnOutput, isUserScrollSuppressed],
  );

  // 一键回到底部并恢复跟随；抵达底部后 atBottomStateChange 会重新置位 keepActiveOutputVisible
  const handleJumpToBottom = useCallback(() => {
    const lastIndex = projection.turns.length - 1;
    if (lastIndex < 0) return;
    keepActiveOutputVisibleRef.current = true;
    virtuosoRef.current?.scrollToIndex({ index: lastIndex, align: 'end', behavior: 'auto' });
  }, [projection.turns.length]);

  // Render individual turn card
  const itemContent = useCallback(
    (virtuosoIndex: number, turn: TraceTurn) => {
      const index = virtuosoIndex - firstItemIndex;
      if (!turn) return null;

      const isLast = index === projection.turns.length - 1;
      const isStreaming = index === projection.activeTurnIndex;
      const shouldFollowOutput = index === outputFollowTurnIndex;
      const hasSearchMatch = searchMatches.some(m => m.turnIndex === index);
      const activeMatch = searchMatches.length > 0 ? searchMatches[activeMatchIndex] : undefined;
      const isActiveMatchTurn = activeMatch?.turnIndex === index;
      const exposesSessionRuntime = isLast || isStreaming;
      const previousTurn = index > 0 ? projection.turns[index - 1] : null;

      return (
        <div className="w-full px-4" data-trace-turn-id={turn.turnId}>
          <div className="max-w-3xl mx-auto">
            <TurnCard
              key={turn.turnId}
              turn={turn}
              sessionId={projection.sessionId}
              defaultExpanded={isLast || isStreaming}
              forceExpanded={hasSearchMatch}
              highlightActive={isActiveMatchTurn}
              isActiveTurn={isStreaming}
              sessionStatus={exposesSessionRuntime ? sessionStatus : null}
              isSessionProcessing={exposesSessionRuntime ? isProjectionSessionProcessing : false}
              streamSnapshot={projectionStreamSnapshot}
              showSeparator={shouldShowTurnTimeSeparator(previousTurn, turn)}
              onStreamingDisplayUpdate={
                shouldFollowOutput ? () => scheduleActiveDisplayScroll(index) : undefined
              }
              onRewindUserPrompt={onRewindUserPrompt}
            />
          </div>
        </div>
      );
    },
    [activeMatchIndex, firstItemIndex, isProjectionSessionProcessing, onRewindUserPrompt, outputFollowTurnIndex, projection.activeTurnIndex, projection.sessionId, projection.turns, projectionStreamSnapshot, scheduleActiveDisplayScroll, searchMatches, sessionStatus],
  );

  // Header: load-older indicator
  const Header = useCallback(() => {
    if (!hasOlderMessages) return null;
    return (
      <div className="flex justify-center py-3 text-zinc-500 text-sm">
        {isLoadingOlder ? '加载更早的消息…' : '↑ 滚动加载更多'}
      </div>
    );
  }, [hasOlderMessages, isLoadingOlder]);

  // Footer: permission card (plan moved to PinnedTodoBar above the input)
  const Footer = useCallback(() => (
    <>
      <PermissionCard />
      <div className="h-6" aria-hidden="true" />
    </>
  ), []);

  return (
    <div className="relative h-full min-h-0" data-virtuoso-first-item-index={firstItemIndex}>
      <Virtuoso
        ref={virtuosoRef}
        role="log"
        aria-live="polite"
        aria-label="对话消息"
        className="h-full min-h-0 pt-3 pb-0 overflow-x-hidden"
        scrollerRef={handleScrollerRef}
        data={projection.turns}
        firstItemIndex={firstItemIndex}
        itemContent={itemContent}
        followOutput={followOutput}
        atBottomStateChange={(atBottom) => {
          setIsAtBottom(atBottom);
          if (atBottom && !historyPrependInProgressRef.current && !isUserScrollSuppressed()) {
            keepActiveOutputVisibleRef.current = true;
            const turnId = outputFollowTurn?.turnId ?? projection.turns[projection.turns.length - 1]?.turnId;
            if (turnId) updateFollowedOutputTurnId(turnId);
          }
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
      {!isAtBottom && projection.turns.length > 0 && (
        <button
          type="button"
          onClick={handleJumpToBottom}
          aria-label="回到底部"
          className="absolute bottom-4 left-1/2 -translate-x-1/2 z-10 flex items-center justify-center w-9 h-9 rounded-full bg-zinc-800/80 hover:bg-zinc-700/90 border border-zinc-600/50 text-zinc-200 shadow-lg backdrop-blur-sm transition-colors animate-fade-in"
        >
          <ArrowDown className="w-4 h-4" />
        </button>
      )}
    </div>
  );
};
