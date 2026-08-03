import { describe, expect, it } from 'vitest';
import {
  computeSmoothStreamingNextContent,
  findSmoothStreamingSegmentEnd,
  shouldSyncSmoothStreamingText,
  SMOOTH_STREAMING_TEXT_DEFAULTS,
} from '../../../src/renderer/hooks/useSmoothStreamingText';

describe('useSmoothStreamingText helpers', () => {
  it('advances appended text one segment per interval without jumping to the full target', () => {
    const next = computeSmoothStreamingNextContent({
      displayContent: 'hello',
      targetContent: 'hello world, this is a longer streamed answer',
      elapsedMs: SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_SEGMENT_INTERVAL_MS,
    });

    expect(next.startsWith('hello')).toBe(true);
    expect(next.length).toBeGreaterThan('hello'.length);
    expect(next.length).toBeLessThan('hello world, this is a longer streamed answer'.length);
  });

  it('does not advance before one segment interval has elapsed', () => {
    const next = computeSmoothStreamingNextContent({
      displayContent: 'hello',
      targetContent: 'hello world, this is a longer streamed answer',
      elapsedMs: SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_SEGMENT_INTERVAL_MS - 1,
    });

    expect(next).toBe('hello');
  });

  it('uses flush mode to land the remaining tail immediately when the stream ends', () => {
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
    });

    expect(flushing).toBe(target);
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

describe('useSmoothStreamingText 积压直落', () => {
  it('超过阈值的积压立即落地，只留下阈值内的尾巴参与播放', () => {
    const target = 'a'.repeat(1000);
    const next = computeSmoothStreamingNextContent({
      displayContent: '',
      targetContent: target,
      elapsedMs: 16,
    });

    expect(next).toBe(target.slice(0, target.length - SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS));
    expect(target.length - next.length).toBe(SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS);
  });

  it('阈值内的积压不直落，仍按分段节奏播放', () => {
    const target = 'a'.repeat(SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS);
    const beforeInterval = computeSmoothStreamingNextContent({
      displayContent: '',
      targetContent: target,
      elapsedMs: 16,
    });
    const afterInterval = computeSmoothStreamingNextContent({
      displayContent: '',
      targetContent: target,
      elapsedMs: SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_SEGMENT_INTERVAL_MS,
    });

    expect(beforeInterval).toBe('');
    expect(afterInterval).toBe(target);
  });

  it('直落后的剩余尾巴继续按「词/短段」逐段播放', () => {
    const tail = 'word '.repeat(SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS / 5);
    const bulk = 'x'.repeat(500);
    const target = bulk + tail;
    const landed = computeSmoothStreamingNextContent({
      displayContent: '',
      targetContent: target,
      elapsedMs: 16,
    });
    expect(landed).toBe(bulk);

    const segment = computeSmoothStreamingNextContent({
      displayContent: landed,
      targetContent: target,
      elapsedMs: SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_SEGMENT_INTERVAL_MS,
    });
    expect(segment).toBe(`${bulk}word`);
  });
});

describe('useSmoothStreamingText 尾部分段', () => {
  it('拉丁文本按词切：一个间隔落一个词（含前导空白与词内标点）', () => {
    expect(findSmoothStreamingSegmentEnd('hello world, this is', 0)).toBe('hello'.length);
    expect(findSmoothStreamingSegmentEnd('hello world, this is', 5)).toBe('hello world,'.length);
  });

  it('中文按句读切：落到标点（含）为止', () => {
    const text = '这是一段中文，用来验证分段逻辑。';
    expect(findSmoothStreamingSegmentEnd(text, 0)).toBe('这是一段中文，'.length);
    expect(findSmoothStreamingSegmentEnd(text, '这是一段中文，'.length)).toBe(text.length);
  });

  it('中文无标点时按长度上限切', () => {
    const text = '中'.repeat(30);
    expect(findSmoothStreamingSegmentEnd(text, 0)).toBe(SMOOTH_STREAMING_TEXT_DEFAULTS.CJK_SEGMENT_MAX_CHARS);
  });

  it('换行连同自身自成一段', () => {
    expect(findSmoothStreamingSegmentEnd('line one\nline two', 'line one'.length)).toBe('line one\n'.length);
  });

  it('一个间隔只落一段，攒够多个间隔才连落多段', () => {
    const target = 'one two three four five';
    const one = computeSmoothStreamingNextContent({
      displayContent: '',
      targetContent: target,
      elapsedMs: SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_SEGMENT_INTERVAL_MS,
    });
    const three = computeSmoothStreamingNextContent({
      displayContent: '',
      targetContent: target,
      elapsedMs: SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_SEGMENT_INTERVAL_MS * 3,
    });

    expect(one).toBe('one');
    expect(three).toBe('one two three');
  });
});
