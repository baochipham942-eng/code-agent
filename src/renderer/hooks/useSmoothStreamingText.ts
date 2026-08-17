/**
 * Smooth pacing algorithm ported from get-convex/agent@0.6.4
 * `src/react/useSmoothText.ts` / `dist/react/useSmoothText.js`.
 * Ported on 2026-08-17. Licensed under Apache-2.0.
 * Copyright the Convex contributors; see `useSmoothStreamingText.LICENSE`.
 *
 * This file has been modified for Agent Neo. The rate estimation, lag catch-up,
 * weighted smoothing, and per-update 2x rate cap follow the upstream algorithm.
 * Local extensions preserve Neo's public hook API, reduced-motion direct landing,
 * a 200-character backlog cap, and punctuation/10-character CJK landing groups.
 */
import { useEffect, useRef, useState } from 'react';

export const SMOOTH_STREAMING_TEXT_DEFAULTS = {
  FPS: 20,
  INITIAL_CHARS_PER_SEC: 128,
  /** Neo local extension: never leave more than this many characters queued. */
  BACKLOG_DIRECT_LAND_CHARS: 200,
  /** Neo local extension: preserve punctuation/8-12 character Chinese groups. */
  CJK_SEGMENT_MAX_CHARS: 10,
} as const;

const MS_PER_FRAME = 1000 / SMOOTH_STREAMING_TEXT_DEFAULTS.FPS;
const CJK_CHAR_PATTERN = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const CJK_BREAK_PATTERN = /[，。！？；：、…—·]/;

export interface SmoothStreamingTextInput {
  content: string;
  isStreaming?: boolean;
}

export interface SmoothStreamingTextResult {
  displayContent: string;
  isAnimating: boolean;
  /** Latest locally grouped CJK/character landing; null for direct/synchronous updates. */
  tailStartIndex: number | null;
}

export interface SmoothStreamingRateState {
  tick: number;
  cursor: number;
  lastUpdate: number;
  lastUpdateLength: number;
  charsPerMs: number;
  initial: boolean;
}

export interface SmoothStreamingFrameInput {
  state: SmoothStreamingRateState;
  targetContent: string;
  now: number;
  /** True exactly once when a new target snapshot is observed. */
  targetChanged?: boolean;
}

export interface SmoothStreamingFrameResult {
  displayContent: string;
  state: SmoothStreamingRateState;
  directLanding: boolean;
  tailStartIndex: number | null;
}

/**
 * Neo local CJK extension. Once the upstream character budget reaches a CJK
 * group, land through punctuation or at most ten UTF-16 code units. Charging
 * the whole group against `tick` keeps the upstream average character rate.
 */
export function findSmoothStreamingSegmentEnd(content: string, fromIndex: number): number {
  if (fromIndex >= content.length) return content.length;
  if (!CJK_CHAR_PATTERN.test(content[fromIndex])) return fromIndex + 1;

  let index = fromIndex;
  while (index < content.length) {
    const character = content[index];
    if (character === '\n') break;
    if (!CJK_CHAR_PATTERN.test(character) && index > fromIndex) break;
    index += 1;
    if (CJK_BREAK_PATTERN.test(character)) break;
    if (index - fromIndex >= SMOOTH_STREAMING_TEXT_DEFAULTS.CJK_SEGMENT_MAX_CHARS) break;
  }
  return index;
}

export function shouldSyncSmoothStreamingText(displayContent: string, targetContent: string): boolean {
  return displayContent !== targetContent
    && (displayContent.length > targetContent.length || !targetContent.startsWith(displayContent));
}

function observeTarget(
  state: SmoothStreamingRateState,
  targetLength: number,
  now: number,
): SmoothStreamingRateState {
  let next = { ...state };
  if (next.lastUpdateLength !== targetLength) {
    // Kept faithful to upstream. A same-millisecond update can produce Infinity,
    // which is still bounded by the final 2x cap.
    const timeSinceLastUpdate = now - next.lastUpdate;
    const latestCharsPerMs = (targetLength - next.lastUpdateLength) / timeSinceLastUpdate;
    const rateError = latestCharsPerMs - next.charsPerMs;
    const charLag = next.lastUpdateLength - next.cursor;
    const lagRate = charLag / timeSinceLastUpdate;
    const charsPerMs = latestCharsPerMs
      + (next.initial ? 0 : Math.max(0, (rateError + lagRate) / 2));
    next.initial = false;
    next.charsPerMs = Math.min(
      (2 * charsPerMs + next.charsPerMs) / 3,
      next.charsPerMs * 2,
    );
  }
  next.tick = Math.max(next.tick, now - MS_PER_FRAME);
  next.lastUpdate = now;
  next.lastUpdateLength = targetLength;
  return next;
}

/**
 * One deterministic upstream pacing tick plus Neo's documented local landing
 * extensions. Production and unit tests share this exact state transition.
 */
export function computeSmoothStreamingFrame({
  state,
  targetContent,
  now,
  targetChanged = false,
}: SmoothStreamingFrameInput): SmoothStreamingFrameResult {
  let next = targetChanged ? observeTarget(state, targetContent.length, now) : { ...state };

  if (next.cursor >= targetContent.length) {
    next.cursor = targetContent.length;
    return {
      displayContent: targetContent,
      state: next,
      directLanding: false,
      tailStartIndex: null,
    };
  }

  const backlog = targetContent.length - next.cursor;
  if (backlog > SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS) {
    next.cursor = targetContent.length - SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS;
    next.tick = now;
    return {
      displayContent: targetContent.slice(0, next.cursor),
      state: next,
      directLanding: true,
      tailStartIndex: null,
    };
  }

  const previousCursor = next.cursor;
  const timeSinceLastUpdate = now - next.tick;
  const charsSinceLastUpdate = Math.floor(timeSinceLastUpdate * next.charsPerMs);
  const chars = Math.min(charsSinceLastUpdate, targetContent.length - next.cursor);
  if (chars > 0) {
    next.cursor += chars;
    if (CJK_CHAR_PATTERN.test(targetContent[previousCursor])) {
      next.cursor = Math.max(
        next.cursor,
        findSmoothStreamingSegmentEnd(targetContent, previousCursor),
      );
    }
    next.cursor = Math.min(next.cursor, targetContent.length);
    next.tick += (next.cursor - previousCursor) / next.charsPerMs;
  }

  return {
    displayContent: targetContent.slice(0, next.cursor),
    state: next,
    directLanding: false,
    tailStartIndex: next.cursor > previousCursor ? previousCursor : null,
  };
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
  const [displayContent, setDisplayContent] = useState(isStreaming ? '' : content);
  const [isAnimating, setIsAnimating] = useState(isStreaming && content.length > 0);
  const rateStateRef = useRef(createRateState(content, isStreaming));
  const displayRef = useRef(isStreaming ? '' : content);
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
    const interval = globalThis.setInterval(update, MS_PER_FRAME);
    return () => globalThis.clearInterval(interval);
  }, [content, isStreaming]);

  if (!isStreaming && !isAnimating && displayContent !== content) {
    return { displayContent: content, isAnimating: false, tailStartIndex: null };
  }

  return { displayContent, isAnimating, tailStartIndex: tailStartRef.current };
}
