import { useEffect, useMemo, useRef, useState } from 'react';

// 流式长内容渲染自然化（工单 2026-08-01）：积压直落 + 只动尾巴 + 块级淡入。
// - 待播积压超过 BACKLOG_DIRECT_LAND_CHARS 时超出部分立即落地，从左到右的扫描
//   在任何情况下都不超过约一行；
// - 只有阈值内的尾巴保留生长感，粒度是「词/短段」而非字符，每段按
//   TAIL_SEGMENT_INTERVAL_MS 节奏落定（淡入由消费层 CSS 负责）；
// - prefers-reduced-motion 下全部直落零动画。
export const SMOOTH_STREAMING_TEXT_DEFAULTS = {
  /** 积压直落阈值（字符）：超出部分立即落地，不参与尾部播放 */
  BACKLOG_DIRECT_LAND_CHARS: 200,
  /** 尾段落定节奏：每个「词/短段」的播放间隔 */
  TAIL_SEGMENT_INTERVAL_MS: 120,
  /** 中文短段长度上限（工单：按标点或 8-12 字切） */
  CJK_SEGMENT_MAX_CHARS: 10,
} as const;

const DEFAULT_FRAME_MS = 16;

// CJK 表意文字 + 常用全角标点（段内字符）
const CJK_CHAR_PATTERN = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;
// 中文句读：短段切到标点（含）为止
const CJK_BREAK_PATTERN = /[，。！？；：、…—·]/;

export interface SmoothStreamingTextInput {
  content: string;
  isStreaming?: boolean;
}

export interface SmoothStreamingTextResult {
  displayContent: string;
  isAnimating: boolean;
  /**
   * 最近一次逐段落定的尾段在 displayContent 里的起始下标；无尾段
   * （直落/追平/同步/静止）为 null。消费层用它给尾段包淡入 span。
   */
  tailStartIndex: number | null;
}

export interface SmoothStreamingStepInput {
  displayContent: string;
  targetContent: string;
  elapsedMs: number;
  /** 流已结束：剩余尾巴立即落定，不再逐段播放 */
  isFlushing?: boolean;
}

/**
 * 从 fromIndex 找一个「词/短段」的结束下标（不含）：
 * - 前导空白（不含换行）并入本段，换行连同自身自成一段；
 * - 中文：切到句读（含）为止，最多 CJK_SEGMENT_MAX_CHARS 字；
 * - 拉丁/数字等：一个连续非空白非 CJK 的「词」。
 */
export function findSmoothStreamingSegmentEnd(content: string, fromIndex: number): number {
  const length = content.length;
  if (fromIndex >= length) return length;

  let index = fromIndex;
  while (index < length && content[index] !== '\n' && /\s/.test(content[index])) index += 1;
  if (index >= length) return length;
  if (content[index] === '\n') return index + 1;

  if (CJK_CHAR_PATTERN.test(content[index])) {
    while (index < length) {
      const ch = content[index];
      if (ch === '\n') break;
      if (!CJK_CHAR_PATTERN.test(ch) && index > fromIndex) break;
      index += 1;
      if (CJK_BREAK_PATTERN.test(ch)) break;
      if (index - fromIndex >= SMOOTH_STREAMING_TEXT_DEFAULTS.CJK_SEGMENT_MAX_CHARS) break;
    }
    return index;
  }

  while (index < length) {
    const ch = content[index];
    if (/\s/.test(ch) || CJK_CHAR_PATTERN.test(ch)) break;
    index += 1;
  }
  return index;
}

export function computeSmoothStreamingNextContent(input: SmoothStreamingStepInput): string {
  const { displayContent, targetContent } = input;
  if (displayContent === targetContent) return targetContent;
  if (!targetContent.startsWith(displayContent)) return targetContent;

  const backlog = targetContent.length - displayContent.length;
  if (backlog <= 0) return targetContent;

  // 积压直落：超出阈值的部分立即落地，只把最后一段窗口留给尾部播放
  if (backlog > SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS) {
    return targetContent.slice(0, targetContent.length - SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS);
  }

  // 流结束追平：剩余尾巴一次落定（工单：直落让 isAnimating 更快变 false，属正向）
  if (input.isFlushing) return targetContent;

  // 尾部生长：按节奏一次落一个「词/短段」，不做字符级 reveal
  const segmentBudget = Math.floor(
    Math.max(input.elapsedMs, 0) / SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_SEGMENT_INTERVAL_MS,
  );
  if (segmentBudget <= 0) return displayContent;

  let nextLength = displayContent.length;
  for (let landed = 0; landed < segmentBudget && nextLength < targetContent.length; landed += 1) {
    nextLength = findSmoothStreamingSegmentEnd(targetContent, nextLength);
  }
  return targetContent.slice(0, nextLength);
}

export function shouldSyncSmoothStreamingText(displayContent: string, targetContent: string): boolean {
  if (displayContent === targetContent) return false;
  return displayContent.length > targetContent.length || !targetContent.startsWith(displayContent);
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
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
  // 跨帧累积的播放时长额度：rAF 每帧 ~16ms，攒够一个段落间隔才落一段
  const segmentCreditMsRef = useRef(0);
  const tailStartRef = useRef<number | null>(null);

  const setDisplay = (next: string, tailStart: number | null = null) => {
    displayRef.current = next;
    tailStartRef.current = tailStart;
    setDisplayContent(next);
  };

  useEffect(() => {
    targetRef.current = content;

    // prefers-reduced-motion：全部直落零动画
    if (prefersReducedMotion()) {
      segmentCreditMsRef.current = 0;
      setDisplay(content);
      setIsAnimating(false);
      wasStreamingRef.current = isStreaming;
      return;
    }

    if (isStreaming) {
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
      // 流结束：剩余尾巴由 tick 以 isFlushing 一次落定
      setIsAnimating(true);
    } else {
      segmentCreditMsRef.current = 0;
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

      const prevDisplay = displayRef.current;
      const backlog = targetRef.current.length - prevDisplay.length;
      const directLanding = backlog > SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS;
      const flushing = !isStreaming;
      const creditMs = segmentCreditMsRef.current + (timestamp - lastFrameAt);
      const segmentsSpent = Math.floor(
        Math.max(creditMs, 0) / SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_SEGMENT_INTERVAL_MS,
      );

      const nextDisplay = computeSmoothStreamingNextContent({
        displayContent: prevDisplay,
        targetContent: targetRef.current,
        elapsedMs: creditMs,
        isFlushing: flushing,
      });

      if (nextDisplay !== prevDisplay) {
        segmentCreditMsRef.current = nextDisplay === targetRef.current
          ? 0
          : Math.max(0, creditMs - segmentsSpent * SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_SEGMENT_INTERVAL_MS);
        // 只有逐段落定的小段淡入；直落/追平的大块立即可读
        const tailStart = !directLanding && !flushing ? prevDisplay.length : null;
        setDisplay(nextDisplay, tailStart);
      } else {
        segmentCreditMsRef.current = creditMs;
      }

      if (nextDisplay === targetRef.current) {
        // 落定完成：保留 tailStartRef（最后一段的淡入仍在跑），只停动画信号
        displayRef.current = targetRef.current;
        setDisplayContent(targetRef.current);
        setIsAnimating(false);
        wasStreamingRef.current = isStreaming;
        lastFrameAtRef.current = null;
        return;
      }

      frameRef.current = scheduler.request(tick);
    };

    if (!prefersReducedMotion() && displayRef.current !== targetRef.current) {
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
    return { displayContent: content, isAnimating: false, tailStartIndex: null };
  }

  return { displayContent, isAnimating, tailStartIndex: tailStartRef.current };
}
