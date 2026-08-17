import { describe, expect, it } from 'vitest';
import {
  computeSmoothStreamingFrame,
  shouldSyncSmoothStreamingText,
  SMOOTH_STREAMING_TEXT_DEFAULTS,
  type SmoothStreamingRateState,
} from '../../../src/renderer/hooks/smoothStreamingAlgorithm';

function rateState(overrides: Partial<SmoothStreamingRateState> = {}): SmoothStreamingRateState {
  return {
    tick: 0,
    cursor: 0,
    lastUpdate: 0,
    lastUpdateLength: 0,
    charsPerMs: SMOOTH_STREAMING_TEXT_DEFAULTS.INITIAL_CHARS_PER_SEC / 1000,
    initial: true,
    ...overrides,
  };
}

describe('useSmoothStreamingText Convex rate model', () => {
  it('estimates the latest input rate on the first target update', () => {
    const frame = computeSmoothStreamingFrame({
      state: rateState(),
      targetContent: 'a'.repeat(5),
      now: 100,
      targetChanged: true,
    });

    expect(frame.state.charsPerMs).toBeCloseTo((2 * 0.05 + 0.128) / 3);
  });

  it('adds lag catch-up pressure after the initial estimate', () => {
    const withoutLag = computeSmoothStreamingFrame({
      state: rateState({ cursor: 100, lastUpdateLength: 100, charsPerMs: 1, initial: false }),
      targetContent: 'a'.repeat(120),
      now: 100,
      targetChanged: true,
    });
    const withLag = computeSmoothStreamingFrame({
      state: rateState({ cursor: 0, lastUpdateLength: 100, charsPerMs: 1, initial: false }),
      targetContent: 'a'.repeat(120),
      now: 100,
      targetChanged: true,
    });

    expect(withLag.state.charsPerMs).toBeGreaterThan(withoutLag.state.charsPerMs);
  });

  it('caps each observed rate increase at twice the previous rate', () => {
    const frame = computeSmoothStreamingFrame({
      state: rateState({ charsPerMs: 0.1, initial: false }),
      targetContent: 'a'.repeat(10_000),
      now: 10,
      targetChanged: true,
    });

    expect(frame.state.charsPerMs).toBeCloseTo(0.2);
  });

  it('advances from accumulated character credit at the upstream 20fps cadence', () => {
    const frame = computeSmoothStreamingFrame({
      state: rateState({ charsPerMs: 0.128 }),
      targetContent: 'abcdefghijklmnopqrst',
      now: 50,
    });

    expect(frame.displayContent).toBe('abcdef');
    expect(frame.state.cursor).toBe(6);
  });
});

describe('useSmoothStreamingText backlog direct landing', () => {
  it('does not direct-land at the exact 200-character boundary', () => {
    const target = 'a'.repeat(SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS);
    const frame = computeSmoothStreamingFrame({ state: rateState(), targetContent: target, now: 0 });

    expect(frame.directLanding).toBe(false);
    expect(frame.displayContent).toBe('');
  });

  it('direct-lands overflow and leaves exactly the bounded tail', () => {
    const target = 'a'.repeat(SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS + 1);
    const frame = computeSmoothStreamingFrame({ state: rateState(), targetContent: target, now: 0 });

    expect(frame.directLanding).toBe(true);
    expect(frame.displayContent).toBe('a');
    expect(target.length - frame.state.cursor).toBe(
      SMOOTH_STREAMING_TEXT_DEFAULTS.BACKLOG_DIRECT_LAND_CHARS,
    );
  });
});

describe('useSmoothStreamingText local CJK grouping', () => {
  it('lands through Chinese punctuation while charging the full group', () => {
    const target = '这是一段中文，用来验证分段逻辑。';
    const frame = computeSmoothStreamingFrame({
      state: rateState({ charsPerMs: 0.128 }),
      targetContent: target,
      now: 50,
    });

    expect(frame.displayContent).toBe('这是一段中文，');
    expect(frame.state.tick).toBeCloseTo(frame.state.cursor / 0.128);
  });

  it('bounds unpunctuated Chinese groups at ten characters', () => {
    const target = '中'.repeat(30);
    const frame = computeSmoothStreamingFrame({
      state: rateState({ charsPerMs: 0.128 }),
      targetContent: target,
      now: 50,
    });
    expect(frame.displayContent.length).toBe(
      SMOOTH_STREAMING_TEXT_DEFAULTS.CJK_SEGMENT_MAX_CHARS,
    );
  });

  it('keeps Latin pacing character-based like upstream', () => {
    const frame = computeSmoothStreamingFrame({
      state: rateState({ charsPerMs: 0.128 }),
      targetContent: 'hello world',
      now: 50,
    });
    expect(frame.displayContent).toBe('hello ');
  });
});

describe('useSmoothStreamingText recovery snapshots', () => {
  it('syncs non-prefix replacement snapshots', () => {
    expect(shouldSyncSmoothStreamingText('draft answer', 'corrected answer')).toBe(true);
  });

  it('syncs when a recovery snapshot is shorter than displayed text', () => {
    expect(shouldSyncSmoothStreamingText('duplicated duplicated', 'duplicated')).toBe(true);
  });

  it('does not sync a normal appended prefix', () => {
    expect(shouldSyncSmoothStreamingText('draft', 'draft answer')).toBe(false);
  });
});
