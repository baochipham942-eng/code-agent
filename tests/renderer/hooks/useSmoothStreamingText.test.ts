import { describe, expect, it } from 'vitest';
import {
  computeSmoothStreamingNextContent,
  findSmoothStreamingSegmentEnd,
  shouldSyncSmoothStreamingText,
  SMOOTH_STREAMING_TEXT_DEFAULTS,
} from '../../../src/renderer/hooks/useSmoothStreamingText';

// 行为推导段间隔：从公共入口逐 ms 找到首次推进时刻。节奏函数不再对外导出（knip 生产档），
// 测试只依赖可观测行为，实现改节奏公式时这里自动跟随。
function segmentIntervalMs(displayContent: string, targetContent: string): number {
  for (let elapsedMs = 1; elapsedMs <= 10_000; elapsedMs++) {
    if (computeSmoothStreamingNextContent({ displayContent, targetContent, elapsedMs }) !== displayContent) {
      return elapsedMs;
    }
  }
  throw new Error('segment interval not found within 10s');
}

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
    const target = 'hello world, this is a longer streamed answer';
    const next = computeSmoothStreamingNextContent({
      displayContent: 'hello',
      targetContent: target,
      elapsedMs: segmentIntervalMs('hello', target) - 1,
    });

    expect(next).toBe('hello');
  });

  it('keeps the same bounded drain when the stream ends instead of jumping the tail', () => {
    const target = 'hello world, this is a longer streamed answer';
    const interval = segmentIntervalMs('hello', target);
    const beforeInterval = computeSmoothStreamingNextContent({
      displayContent: 'hello',
      targetContent: target,
      elapsedMs: interval - 1,
    });
    const flushing = computeSmoothStreamingNextContent({
      displayContent: 'hello',
      targetContent: target,
      elapsedMs: interval - 1,
      isFlushing: true,
    });

    expect(flushing).toBe(beforeInterval);
    expect(flushing).toBe('hello');
  });

  it('shortens the segment interval as backlog grows and drains within the target window', () => {
    const shortTarget = 'one two';
    const longTarget = 'one two three four five six seven eight nine ten';
    const shortInterval = segmentIntervalMs('', shortTarget);
    const longInterval = segmentIntervalMs('', longTarget);

    expect(longInterval).toBeLessThan(shortInterval);
    expect(longInterval).toBeLessThanOrEqual(SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_SEGMENT_INTERVAL_MS);
    expect(computeSmoothStreamingNextContent({
      displayContent: '',
      targetContent: longTarget,
      elapsedMs: SMOOTH_STREAMING_TEXT_DEFAULTS.TAIL_DRAIN_MS,
    })).toBe(longTarget);
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
      elapsedMs: segmentIntervalMs(landed, target),
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
