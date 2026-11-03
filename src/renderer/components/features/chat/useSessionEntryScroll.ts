import { useCallback, useEffect, useRef } from 'react';
import type { Dispatch, RefObject, SetStateAction } from 'react';
import type { VirtuosoHandle } from 'react-virtuoso';
import type { TraceTurn } from '@shared/contract/trace';

export function scheduleAfterLayout(callback: () => void): () => void {
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

export function isScrollerNearBottom(
  scroller: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold = 96,
): boolean {
  return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight <= threshold;
}

interface BottomSettlementOptions {
  turnsAtJump: TraceTurn[];
  projectionTurnsRef: RefObject<TraceTurn[]>;
  scrollerElementRef: RefObject<HTMLElement | null>;
  keepActiveOutputVisibleRef: RefObject<boolean>;
  activeDisplayScrollCancelRef: RefObject<(() => void) | null>;
  shouldContinue?: () => boolean;
  onSettled?: () => void;
  onCancel?: () => void;
}

export function startBottomSettlement({
  turnsAtJump,
  projectionTurnsRef,
  scrollerElementRef,
  keepActiveOutputVisibleRef,
  activeDisplayScrollCancelRef,
  shouldContinue = () => true,
  onSettled = () => undefined,
  onCancel = () => undefined,
}: BottomSettlementOptions): void {
  let remainingFrames = 60;
  let settled = false;
  let frame: number | ReturnType<typeof setTimeout> | null = null;
  const cancelSettlement = () => {
    if (frame !== null) {
      if (typeof cancelAnimationFrame === 'function' && typeof frame === 'number') {
        cancelAnimationFrame(frame);
      } else {
        clearTimeout(frame);
      }
    }
    frame = null;
    if (activeDisplayScrollCancelRef.current === cancelSettlement) {
      activeDisplayScrollCancelRef.current = null;
    }
    if (!settled) onCancel();
  };
  const settleBottom = () => {
    frame = null;
    if (
      projectionTurnsRef.current !== turnsAtJump
      || !keepActiveOutputVisibleRef.current
      || !shouldContinue()
    ) {
      cancelSettlement();
      return;
    }
    const scroller = scrollerElementRef.current;
    if (scroller) scroller.scrollTop = scroller.scrollHeight;
    remainingFrames -= 1;
    if (remainingFrames <= 0) {
      settled = true;
      onSettled();
      cancelSettlement();
      return;
    }
    frame = typeof requestAnimationFrame === 'function'
      ? requestAnimationFrame(settleBottom)
      : setTimeout(settleBottom, 16);
  };
  activeDisplayScrollCancelRef.current = cancelSettlement;
  frame = typeof requestAnimationFrame === 'function'
    ? requestAnimationFrame(settleBottom)
    : setTimeout(settleBottom, 16);
}

interface SessionEntryScrollState {
  sessionId: string;
  hasTurns: boolean;
  pending: boolean;
  resetBottom: boolean;
  interactionAt: number;
}

interface SessionEntryScrollOptions {
  sessionId: string;
  turns: TraceTurn[];
  projectionTurnsRef: RefObject<TraceTurn[]>;
  virtuosoRef: RefObject<VirtuosoHandle | null>;
  scrollerElementRef: RefObject<HTMLElement | null>;
  outputFollowStreamingRef: RefObject<boolean>;
  keepActiveOutputVisibleRef: RefObject<boolean>;
  activeDisplayScrollCancelRef: RefObject<(() => void) | null>;
  sessionEntrySettlingRef: RefObject<boolean>;
  userScrollLastInteractionAtRef: RefObject<number>;
  setIsAtBottom: Dispatch<SetStateAction<boolean>>;
}

export function useSessionEntryScroll({
  sessionId,
  turns,
  projectionTurnsRef,
  virtuosoRef,
  scrollerElementRef,
  outputFollowStreamingRef,
  keepActiveOutputVisibleRef,
  activeDisplayScrollCancelRef,
  sessionEntrySettlingRef,
  userScrollLastInteractionAtRef,
  setIsAtBottom,
}: SessionEntryScrollOptions): () => void {
  const entryRef = useRef<SessionEntryScrollState>({
    sessionId,
    hasTurns: turns.length > 0,
    pending: turns.length > 0,
    resetBottom: false,
    interactionAt: userScrollLastInteractionAtRef.current,
  });
  const entry = entryRef.current;
  if (entry.sessionId !== sessionId) {
    entryRef.current = {
      sessionId,
      hasTurns: turns.length > 0,
      pending: turns.length > 0,
      resetBottom: false,
      interactionAt: userScrollLastInteractionAtRef.current,
    };
  } else if (!entry.hasTurns && turns.length > 0) {
    entry.hasTurns = true;
    entry.pending = true;
    entry.resetBottom = true;
    entry.interactionAt = userScrollLastInteractionAtRef.current;
  }

  const previousSessionIdRef = useRef(sessionId);
  useEffect(() => {
    if (previousSessionIdRef.current === sessionId) return;
    previousSessionIdRef.current = sessionId;
    setIsAtBottom(true);
  }, [sessionId, setIsAtBottom]);

  return useCallback(() => {
    const entry = entryRef.current;
    if (!entry.pending || entry.sessionId !== sessionId || projectionTurnsRef.current.length === 0) return;
    entry.pending = false;
    if (entry.resetBottom) {
      entry.resetBottom = false;
      setIsAtBottom(true);
    }
    if (outputFollowStreamingRef.current || userScrollLastInteractionAtRef.current !== entry.interactionAt) return;
    const scroller = scrollerElementRef.current;
    if (scroller && scroller.scrollHeight > scroller.clientHeight && isScrollerNearBottom(scroller)) return;
    const lastIndex = projectionTurnsRef.current.length - 1;
    if (lastIndex < 0) return;
    sessionEntrySettlingRef.current = true;

    scheduleAfterLayout(() => {
      if (
        entryRef.current !== entry
        || outputFollowStreamingRef.current
        || userScrollLastInteractionAtRef.current !== entry.interactionAt
      ) {
        sessionEntrySettlingRef.current = false;
        return;
      }
      keepActiveOutputVisibleRef.current = true;
      virtuosoRef.current?.scrollToIndex({ index: lastIndex, align: 'end', behavior: 'auto' });
      activeDisplayScrollCancelRef.current?.();
      startBottomSettlement({
        turnsAtJump: projectionTurnsRef.current,
        projectionTurnsRef,
        scrollerElementRef,
        keepActiveOutputVisibleRef,
        activeDisplayScrollCancelRef,
        shouldContinue: () => (
          entryRef.current === entry
          && !outputFollowStreamingRef.current
          && userScrollLastInteractionAtRef.current === entry.interactionAt
        ),
        onSettled: () => {
          sessionEntrySettlingRef.current = false;
          setIsAtBottom(true);
        },
        onCancel: () => {
          sessionEntrySettlingRef.current = false;
          const scroller = scrollerElementRef.current;
          if (scroller && scroller.scrollHeight > 0) {
            setIsAtBottom(scroller.scrollHeight <= scroller.clientHeight || isScrollerNearBottom(scroller));
          }
        },
      });
    });
  }, [projectionTurnsRef, sessionId, setIsAtBottom, userScrollLastInteractionAtRef, outputFollowStreamingRef, keepActiveOutputVisibleRef, virtuosoRef, scrollerElementRef, activeDisplayScrollCancelRef, sessionEntrySettlingRef]);
}
