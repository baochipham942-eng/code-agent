import { describe, expect, it } from 'vitest';
import {
  computeSmoothStreamingNextContent,
  shouldSyncSmoothStreamingText,
} from '../../../src/renderer/hooks/useSmoothStreamingText';

describe('useSmoothStreamingText helpers', () => {
  it('advances appended text without jumping to the full target immediately', () => {
    const next = computeSmoothStreamingNextContent({
      displayContent: 'hello',
      targetContent: 'hello world, this is a longer streamed answer',
      elapsedMs: 16,
    });

    expect(next.startsWith('hello')).toBe(true);
    expect(next.length).toBeGreaterThan('hello'.length);
    expect(next.length).toBeLessThan('hello world, this is a longer streamed answer'.length);
  });

  it('uses flush mode to catch up faster when the stream ends', () => {
    const target = 'hello world, this is a longer streamed answer';
    const normal = computeSmoothStreamingNextContent({
      displayContent: 'hello',
      targetContent: target,
      elapsedMs: 100,
    });
    const flushing = computeSmoothStreamingNextContent({
      displayContent: 'hello',
      targetContent: target,
      elapsedMs: 100,
      isFlushing: true,
      flushRemainingMs: 500,
    });

    expect(flushing.length).toBeGreaterThan(normal.length);
  });

  it('syncs immediately for non-prefix replacement snapshots', () => {
    expect(shouldSyncSmoothStreamingText('draft answer', 'corrected answer')).toBe(true);
    expect(
      computeSmoothStreamingNextContent({
        displayContent: 'draft answer',
        targetContent: 'corrected answer',
        elapsedMs: 16,
      }),
    ).toBe('corrected answer');
  });

  it('syncs immediately when a recovery snapshot is shorter than the displayed text', () => {
    expect(shouldSyncSmoothStreamingText('duplicated duplicated', 'duplicated')).toBe(true);
  });

  it('keeps already completed text unchanged', () => {
    expect(
      computeSmoothStreamingNextContent({
        displayContent: 'done',
        targetContent: 'done',
        elapsedMs: 16,
      }),
    ).toBe('done');
  });
});
