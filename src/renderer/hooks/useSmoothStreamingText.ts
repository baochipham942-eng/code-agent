/**
 * Adapter for the pacing algorithm ported from get-convex/agent@0.6.4
 * `src/react/useSmoothText.ts` / `dist/react/useSmoothText.js`.
 * Ported on 2026-08-17. Licensed under Apache-2.0.
 * Copyright the Convex contributors; see `useSmoothStreamingText.LICENSE`.
 *
 * Modified for Agent Neo to preserve the existing object API, animation state,
 * reduced-motion direct landing, and tail span metadata. Algorithm details and
 * documented local extensions live in `smoothStreamingAlgorithm.ts`.
 */
import { useEffect, useRef, useState } from 'react';
import {
  computeSmoothStreamingFrame,
  shouldSyncSmoothStreamingText,
  SMOOTH_STREAMING_MS_PER_FRAME,
  SMOOTH_STREAMING_TEXT_DEFAULTS,
  type SmoothStreamingRateState,
} from './smoothStreamingAlgorithm';

export interface SmoothStreamingTextInput {
  content: string;
  isStreaming?: boolean;
}

export interface SmoothStreamingTextResult {
  displayContent: string;
  isAnimating: boolean;
  tailStartIndex: number | null;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function createRateState(content: string, startStreaming: boolean): SmoothStreamingRateState {
  const now = Date.now();
  return {
    tick: now,
    cursor: startStreaming ? 0 : content.length,
    lastUpdate: now,
    lastUpdateLength: content.length,
    charsPerMs: SMOOTH_STREAMING_TEXT_DEFAULTS.INITIAL_CHARS_PER_SEC / 1000,
    initial: true,
  };
}

export function useSmoothStreamingText({
  content,
  isStreaming = false,
}: SmoothStreamingTextInput): SmoothStreamingTextResult {
  // 挂载直落：mount 时已有的内容立即可见（与移植前语义一致——占位消失的同一帧正文必须在场，
  // 否则出现"占位没了正文也没出"的空窗；真机回归见 traceNodeRenderer.streamGapPlaceholder）。
  // Convex 节奏只作用于挂载后的增量。
  const [displayContent, setDisplayContent] = useState(content);
  const [isAnimating, setIsAnimating] = useState(false);
  const rateStateRef = useRef(createRateState(content, isStreaming));
  const displayRef = useRef(content);
  const tailStartRef = useRef<number | null>(null);
  const wasStreamingRef = useRef(isStreaming);

  const syncDisplay = (nextContent: string, tailStartIndex: number | null) => {
    displayRef.current = nextContent;
    tailStartRef.current = tailStartIndex;
    setDisplayContent(nextContent);
  };

  useEffect(() => {
    if (prefersReducedMotion()) {
      rateStateRef.current = createRateState(content, false);
      syncDisplay(content, null);
      setIsAnimating(false);
      wasStreamingRef.current = isStreaming;
      return;
    }

    if (shouldSyncSmoothStreamingText(displayRef.current, content)) {
      rateStateRef.current = createRateState(content, false);
      syncDisplay(content, null);
      setIsAnimating(false);
      wasStreamingRef.current = isStreaming;
      return;
    }

    if (!isStreaming && !wasStreamingRef.current) {
      rateStateRef.current = createRateState(content, false);
      syncDisplay(content, null);
      setIsAnimating(false);
      return;
    }

    wasStreamingRef.current = wasStreamingRef.current || isStreaming;
    let targetChanged = rateStateRef.current.lastUpdateLength !== content.length;

    const update = () => {
      const previousDisplay = displayRef.current;
      const frame = computeSmoothStreamingFrame({
        state: rateStateRef.current,
        targetContent: content,
        now: Date.now(),
        targetChanged,
      });
      targetChanged = false;
      rateStateRef.current = frame.state;

      if (frame.displayContent !== previousDisplay) {
        syncDisplay(
          frame.displayContent,
          isStreaming && !frame.directLanding ? frame.tailStartIndex : null,
        );
      }

      const caughtUp = frame.state.cursor >= content.length;
      setIsAnimating(!caughtUp);
      if (caughtUp && !isStreaming) wasStreamingRef.current = false;
    };

    update();
    if (rateStateRef.current.cursor >= content.length) return;
    const interval = globalThis.setInterval(update, SMOOTH_STREAMING_MS_PER_FRAME);
    return () => globalThis.clearInterval(interval);
  }, [content, isStreaming]);

  if (!isStreaming && !isAnimating && displayContent !== content) {
    return { displayContent: content, isAnimating: false, tailStartIndex: null };
  }

  return { displayContent, isAnimating, tailStartIndex: tailStartRef.current };
}
