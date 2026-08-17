/**
 * Smooth pacing algorithm ported from get-convex/agent@0.6.4
 * `src/react/useSmoothText.ts` / `dist/react/useSmoothText.js`.
 * Ported on 2026-08-17. Licensed under Apache-2.0.
 * Copyright the Convex contributors; see `useSmoothStreamingText.LICENSE`.
 *
 * Modified for Agent Neo: the upstream rate estimator and catch-up strategy are
 * unchanged. A 200-character backlog cap and punctuation/10-character CJK
 * landing groups are local extensions.
 */
export const SMOOTH_STREAMING_TEXT_DEFAULTS = {
  FPS: 20,
  INITIAL_CHARS_PER_SEC: 128,
  BACKLOG_DIRECT_LAND_CHARS: 200,
  CJK_SEGMENT_MAX_CHARS: 10,
} as const;

export const SMOOTH_STREAMING_MS_PER_FRAME = 1000 / SMOOTH_STREAMING_TEXT_DEFAULTS.FPS;
const CJK_CHAR_PATTERN = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;
const CJK_BREAK_PATTERN = /[，。！？；：、…—·]/;

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
  targetChanged?: boolean;
}

export interface SmoothStreamingFrameResult {
  displayContent: string;
  state: SmoothStreamingRateState;
  directLanding: boolean;
  tailStartIndex: number | null;
}

function findCjkSegmentEnd(content: string, fromIndex: number): number {
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
  const next = { ...state };
  if (next.lastUpdateLength !== targetLength) {
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
  next.tick = Math.max(next.tick, now - SMOOTH_STREAMING_MS_PER_FRAME);
  next.lastUpdate = now;
  next.lastUpdateLength = targetLength;
  return next;
}

export function computeSmoothStreamingFrame({
  state,
  targetContent,
  now,
  targetChanged = false,
}: SmoothStreamingFrameInput): SmoothStreamingFrameResult {
  const next = targetChanged ? observeTarget(state, targetContent.length, now) : { ...state };

  if (next.cursor >= targetContent.length) {
    next.cursor = targetContent.length;
    return { displayContent: targetContent, state: next, directLanding: false, tailStartIndex: null };
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
      next.cursor = Math.max(next.cursor, findCjkSegmentEnd(targetContent, previousCursor));
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
