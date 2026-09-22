import { describe, expect, it } from 'vitest';
import { getContextWindow } from '../../../src/shared/constants';
import { AutoContextCompressor } from '../../../src/host/context/autoCompressor';
import { PIPELINE_AUTOCOMPACT_OCCUPANCY } from '../../../src/host/context/compactionOccupancy';
import {
  LEGACY_FIXED_TRIGGER_TOKENS,
  resolveTriggerTokens,
  storedTriggerTokens,
} from '../../../src/host/context/triggerTokens';

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
