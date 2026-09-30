import { describe, expect, it } from 'vitest';
import { getContextWindow } from '../../../src/shared/constants';
import { AutoContextCompressor } from '../../../src/host/context/autoCompressor';
import { PIPELINE_AUTOCOMPACT_OCCUPANCY } from '../../../src/host/context/compactionOccupancy';
import {
  resolveTriggerTokens,
  storedTriggerTokens,
} from '../../../src/host/context/triggerTokens';

const LEGACY_FIXED_TRIGGER_TOKENS = 100_000;

// Catalog has no 64K window (nearby: qwen-vl-max 32768, default 128000).
// 64K is the contract tier passed into the pure function. 200K and 1M are real catalog rows.
const WINDOW_64K = 64_000;

describe('resolveTriggerTokens window tiers', () => {
  it('triggers a 64K window at the forced occupancy, not at the legacy 100000', () => {
    expect(PIPELINE_AUTOCOMPACT_OCCUPANCY).toBe(0.85);
    const trigger = resolveTriggerTokens(WINDOW_64K);
    expect(trigger).toBe(54_400);
    const compressor = new AutoContextCompressor();
    expect(compressor.shouldTriggerByTokens(trigger - 1, WINDOW_64K)).toBe(false);
    expect(compressor.shouldTriggerByTokens(trigger, WINDOW_64K)).toBe(true);
  });

  it('triggers the glm-4.7 200K window at 170000', () => {
    const window = getContextWindow('glm-4.7');
    expect(window).toBe(200_000);
    const trigger = resolveTriggerTokens(window);
    expect(trigger).toBe(170_000);
    const compressor = new AutoContextCompressor();
    expect(compressor.shouldTriggerByTokens(trigger - 1, window)).toBe(false);
    expect(compressor.shouldTriggerByTokens(trigger, window)).toBe(true);
  });

  it('does not trigger a 1M window at 10% occupancy', () => {
    const window = getContextWindow('claude-opus-4-7');
    expect(window).toBe(1_000_000);
    const tenPercent = Math.floor(window * 0.1);
    expect(tenPercent).toBe(LEGACY_FIXED_TRIGGER_TOKENS);
    const compressor = new AutoContextCompressor();
    expect(compressor.shouldTriggerByTokens(tenPercent, window)).toBe(false);
    expect(resolveTriggerTokens(window)).toBe(850_000);
    expect(compressor.shouldTriggerByTokens(849_999, window)).toBe(false);
    expect(compressor.shouldTriggerByTokens(850_000, window)).toBe(true);
  });

  it('does not treat the 75% soft gate as the absolute trigger', () => {
    const window = getContextWindow('claude-opus-4-7');
    const soft = Math.floor(window * 0.75);
    const compressor = new AutoContextCompressor();
    expect(compressor.shouldTriggerByTokens(soft, window)).toBe(false);
  });

  it('keeps an explicit override, including a re-saved legacy 100000', () => {
    expect(resolveTriggerTokens(1_000_000, 80_000)).toBe(80_000);
    expect(resolveTriggerTokens(1_000_000, LEGACY_FIXED_TRIGGER_TOKENS)).toBe(LEGACY_FIXED_TRIGGER_TOKENS);
    const compressor = new AutoContextCompressor({ triggerTokens: LEGACY_FIXED_TRIGGER_TOKENS });
    expect(compressor.shouldTriggerByTokens(LEGACY_FIXED_TRIGGER_TOKENS, 1_000_000)).toBe(true);
  });

  it('keeps an explicit trigger below the window ceiling and clamps one above it', () => {
    // 80_000 is under both the 850_000 occupancy line and the 598_976 reserve line.
    expect(resolveTriggerTokens(1_000_000, 80_000, 400_000)).toBe(80_000);
    // 1_000_000 - 400_000 - 1_024 = 598_976. Explicit 900_000 cannot sit above that ceiling.
    expect(resolveTriggerTokens(1_000_000, 900_000, 400_000)).toBe(598_976);
    // No output reserve: the ceiling is the occupancy line, not the raw explicit value.
    expect(resolveTriggerTokens(1_000_000, 900_000)).toBe(850_000);
    // Absurd output floors the ceiling at half the window; a lower explicit still wins.
    expect(resolveTriggerTokens(1_000_000, 900_000, 9_999_999)).toBe(500_000);
    expect(resolveTriggerTokens(1_000_000, 80_000, 9_999_999)).toBe(80_000);
    const compressor = new AutoContextCompressor({ triggerTokens: 900_000 });
    expect(compressor.shouldTriggerByTokens(598_975, 1_000_000, 400_000)).toBe(false);
    expect(compressor.shouldTriggerByTokens(598_976, 1_000_000, 400_000)).toBe(true);
  });

  it('clamps an explicit trigger above a smaller window to the window ceiling', () => {
    // floor(128_000 × 0.85) = 108_800. A stored 200_000 from a larger window cannot sit past it.
    const window = 128_000;
    const explicit = 200_000;
    expect(resolveTriggerTokens(window, explicit)).toBe(108_800);
    const compressor = new AutoContextCompressor({ triggerTokens: explicit });
    expect(compressor.shouldTriggerByTokens(108_799, window)).toBe(false);
    expect(compressor.shouldTriggerByTokens(108_800, window)).toBe(true);
    expect(compressor.shouldTriggerByTokens(explicit, window)).toBe(true);
  });

  it('lowers the trigger line for a large max-output model', () => {
    // min(850_000, 1_000_000 - 200_000 - 1_024) = 798_976, above the 50% floor.
    expect(resolveTriggerTokens(1_000_000, undefined, 200_000)).toBe(798_976);
    const compressor = new AutoContextCompressor();
    expect(compressor.shouldTriggerByTokens(798_975, 1_000_000, 200_000)).toBe(false);
    expect(compressor.shouldTriggerByTokens(798_976, 1_000_000, 200_000)).toBe(true);
    expect(compressor.shouldTriggerByTokens(849_999, 1_000_000, 200_000)).toBe(true);
    const wrap = new AutoContextCompressor({ totalTokenBudget: 1_600_000 });
    wrap.recordCompaction(1);
    wrap.recordCompaction(1);
    expect(wrap.shouldWrapUp(1_000_000, 200_000)).toBe(false);
  });

  it('keeps the occupancy line for a small max-output model', () => {
    expect(resolveTriggerTokens(1_000_000, undefined, 8_192)).toBe(850_000);
    const compressor = new AutoContextCompressor();
    expect(compressor.shouldTriggerByTokens(849_999, 1_000_000, 8_192)).toBe(false);
    expect(compressor.shouldTriggerByTokens(850_000, 1_000_000, 8_192)).toBe(true);
  });

  it('floors an absurd max output at half the window', () => {
    expect(resolveTriggerTokens(1_000_000, undefined, 1_000_000)).toBe(500_000);
    expect(resolveTriggerTokens(1_000_000, undefined, 9_999_999)).toBe(500_000);
    const tiny = resolveTriggerTokens(1, undefined, 1_000);
    expect(tiny).toBe(1);
    expect(Number.isFinite(tiny)).toBe(true);
    expect(resolveTriggerTokens(1_000_000, undefined, Number.NaN)).toBe(850_000);
    const compressor = new AutoContextCompressor();
    expect(compressor.shouldTriggerByTokens(499_999, 1_000_000, 9_999_999)).toBe(false);
    expect(compressor.shouldTriggerByTokens(500_000, 1_000_000, 9_999_999)).toBe(true);
  });

  it('treats a stored legacy 100000 as unset unless the user marked it explicit', () => {
    expect(storedTriggerTokens({ triggerTokens: LEGACY_FIXED_TRIGGER_TOKENS })).toBeUndefined();
    expect(storedTriggerTokens({
      triggerTokens: LEGACY_FIXED_TRIGGER_TOKENS,
      triggerTokensExplicit: true,
    })).toBe(LEGACY_FIXED_TRIGGER_TOKENS);
    expect(storedTriggerTokens({ triggerTokens: 80_000 })).toBe(80_000);
    expect(storedTriggerTokens({ triggerTokens: 80_000, triggerTokensExplicit: false })).toBeUndefined();
  });
});
