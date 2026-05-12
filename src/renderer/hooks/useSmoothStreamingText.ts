import { useEffect, useMemo, useRef, useState } from 'react';

export const SMOOTH_STREAMING_TEXT_DEFAULTS = {
  MIN_CPS: 15,
  DEFAULT_CPS: 50,
  MAX_CPS: 240,
  FLUSH_MAX_SECONDS: 4,
} as const;

const DEFAULT_FRAME_MS = 16;

export interface SmoothStreamingTextInput {
  content: string;
  isStreaming?: boolean;
}

export interface SmoothStreamingTextResult {
  displayContent: string;
  isAnimating: boolean;
}

export interface SmoothStreamingStepInput {
  displayContent: string;
  targetContent: string;
  elapsedMs: number;
  isFlushing?: boolean;
  flushRemainingMs?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function computeSmoothStreamingNextContent(input: SmoothStreamingStepInput): string {
  const { displayContent, targetContent } = input;
  if (displayContent === targetContent) return targetContent;
  if (!targetContent.startsWith(displayContent)) return targetContent;

  const backlog = targetContent.length - displayContent.length;
  if (backlog <= 0) return targetContent;

  const elapsedSeconds = Math.max(input.elapsedMs, DEFAULT_FRAME_MS) / 1000;
  const flushRemainingSeconds = Math.max((input.flushRemainingMs ?? 0) / 1000, elapsedSeconds);
  const catchupCps = input.isFlushing
    ? backlog / flushRemainingSeconds
    : SMOOTH_STREAMING_TEXT_DEFAULTS.DEFAULT_CPS + backlog / 6;
  const cps = clamp(
    catchupCps,
    SMOOTH_STREAMING_TEXT_DEFAULTS.MIN_CPS,
    SMOOTH_STREAMING_TEXT_DEFAULTS.MAX_CPS,
  );
  const nextLength = Math.min(
    targetContent.length,
    displayContent.length + Math.max(1, Math.floor(cps * elapsedSeconds)),
  );

  return targetContent.slice(0, nextLength);
}

export function shouldSyncSmoothStreamingText(displayContent: string, targetContent: string): boolean {
  if (displayContent === targetContent) return false;
  return displayContent.length > targetContent.length || !targetContent.startsWith(displayContent);
}

function getFrameScheduler(): {
  request: (callback: FrameRequestCallback) => number;
  cancel: (id: number) => void;
  now: () => number;
} {
  const request = globalThis.requestAnimationFrame
    ? globalThis.requestAnimationFrame.bind(globalThis)
    : ((callback: FrameRequestCallback) => globalThis.setTimeout(() => callback(Date.now()), DEFAULT_FRAME_MS) as unknown as number);
  const cancel = globalThis.cancelAnimationFrame
    ? globalThis.cancelAnimationFrame.bind(globalThis)
    : ((id: number) => globalThis.clearTimeout(id));
  const now = globalThis.performance?.now
    ? globalThis.performance.now.bind(globalThis.performance)
    : Date.now;

  return { request, cancel, now };
}

export function useSmoothStreamingText({
  content,
  isStreaming = false,
}: SmoothStreamingTextInput): SmoothStreamingTextResult {
  const scheduler = useMemo(() => getFrameScheduler(), []);
  const [displayContent, setDisplayContent] = useState(content);
  const [isAnimating, setIsAnimating] = useState(false);

  const displayRef = useRef(content);
  const targetRef = useRef(content);
  const wasStreamingRef = useRef(isStreaming);
  const frameRef = useRef<number | null>(null);
  const lastFrameAtRef = useRef<number | null>(null);
  const flushDeadlineRef = useRef<number | null>(null);

  const setDisplay = (next: string) => {
    displayRef.current = next;
    setDisplayContent(next);
  };

  useEffect(() => {
    targetRef.current = content;

    if (isStreaming) {
      flushDeadlineRef.current = null;
      if (shouldSyncSmoothStreamingText(displayRef.current, content)) {
        setDisplay(content);
      }
      setIsAnimating(displayRef.current !== targetRef.current);
      wasStreamingRef.current = true;
      return;
    }

    const shouldFlushAfterStreaming =
      wasStreamingRef.current &&
      displayRef.current !== content &&
      content.startsWith(displayRef.current);

    if (shouldFlushAfterStreaming) {
      flushDeadlineRef.current = scheduler.now() + SMOOTH_STREAMING_TEXT_DEFAULTS.FLUSH_MAX_SECONDS * 1000;
      setIsAnimating(true);
    } else {
      flushDeadlineRef.current = null;
      setDisplay(content);
      setIsAnimating(false);
      wasStreamingRef.current = false;
    }
  }, [content, isStreaming, scheduler]);

  useEffect(() => {
    const cancelFrame = () => {
      if (frameRef.current !== null) {
        scheduler.cancel(frameRef.current);
        frameRef.current = null;
      }
    };

    const tick: FrameRequestCallback = (timestamp) => {
      frameRef.current = null;
      const lastFrameAt = lastFrameAtRef.current ?? timestamp;
      lastFrameAtRef.current = timestamp;
      const flushDeadline = flushDeadlineRef.current;
      const nextDisplay = computeSmoothStreamingNextContent({
        displayContent: displayRef.current,
        targetContent: targetRef.current,
        elapsedMs: timestamp - lastFrameAt,
        isFlushing: flushDeadline !== null,
        flushRemainingMs: flushDeadline !== null ? Math.max(0, flushDeadline - scheduler.now()) : undefined,
      });

      if (nextDisplay !== displayRef.current) {
        setDisplay(nextDisplay);
      }

      const done = nextDisplay === targetRef.current;
      if (done || (flushDeadline !== null && scheduler.now() >= flushDeadline)) {
        setDisplay(targetRef.current);
        setIsAnimating(false);
        wasStreamingRef.current = isStreaming;
        flushDeadlineRef.current = null;
        lastFrameAtRef.current = null;
        return;
      }

      frameRef.current = scheduler.request(tick);
    };

    if (displayRef.current !== targetRef.current) {
      setIsAnimating(true);
      cancelFrame();
      lastFrameAtRef.current = scheduler.now();
      frameRef.current = scheduler.request(tick);
    } else {
      setIsAnimating(false);
      cancelFrame();
      lastFrameAtRef.current = null;
    }

    return cancelFrame;
  }, [content, isStreaming, scheduler]);

  if (!isStreaming && !isAnimating && displayContent !== content) {
    return { displayContent: content, isAnimating: false };
  }

  return { displayContent, isAnimating };
}
