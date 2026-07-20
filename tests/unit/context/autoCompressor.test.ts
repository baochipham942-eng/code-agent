import { describe, expect, it } from 'vitest';
import { AutoContextCompressor } from '../../../src/host/context/autoCompressor';

describe('AutoContextCompressor token threshold', () => {
  it('triggers at or above triggerTokens', () => {
    const compressor = new AutoContextCompressor({ triggerTokens: 100000 });
    expect(compressor.shouldTriggerByTokens(100000)).toBe(true);
    expect(compressor.shouldTriggerByTokens(150000)).toBe(true);
    expect(compressor.shouldTriggerByTokens(99999)).toBe(false);
  });

  it('stays disabled without triggerTokens', () => {
    const compressor = new AutoContextCompressor({ triggerTokens: undefined });
    expect(compressor.shouldTriggerByTokens(10_000_000)).toBe(false);
  });
});

describe('AutoContextCompressor compaction accounting', () => {
  it('records compaction count and saved tokens', () => {
    const compressor = new AutoContextCompressor();
    compressor.recordCompaction(1000);
    compressor.recordCompaction(2000, 'ai_summary');

    expect(compressor.getCompactionCount()).toBe(2);
    expect(compressor.getStats()).toMatchObject({
      compressionCount: 2,
      totalSavedTokens: 3000,
    });
  });

  it('does not wrap up without a complete budget configuration', () => {
    const noBudget = new AutoContextCompressor({ triggerTokens: 100000 });
    expect(noBudget.shouldWrapUp()).toBe(false);
    const noTrigger = new AutoContextCompressor({
      totalTokenBudget: 300000,
      triggerTokens: undefined,
    });
    expect(noTrigger.shouldWrapUp()).toBe(false);
  });

  it('wraps up when compaction count reaches the total token budget', () => {
    const compressor = new AutoContextCompressor({
      triggerTokens: 100000,
      totalTokenBudget: 300000,
    });
    compressor.recordCompaction(1);
    compressor.recordCompaction(1);
    expect(compressor.shouldWrapUp()).toBe(false);
    compressor.recordCompaction(1);
    expect(compressor.shouldWrapUp()).toBe(true);
  });

  it('keeps only the five most recent strategies in stats', () => {
    const compressor = new AutoContextCompressor();
    for (let index = 0; index < 7; index++) {
      compressor.recordCompaction(1, 'ai_summary');
    }
    expect(compressor.getStats().recentStrategies).toHaveLength(5);
  });

  it('resets compaction history', () => {
    const compressor = new AutoContextCompressor();
    compressor.recordCompaction(1);
    compressor.reset();
    expect(compressor.getCompactionCount()).toBe(0);
    expect(compressor.getStats().totalSavedTokens).toBe(0);
  });
});

describe('AutoContextCompressor configuration', () => {
  it('merges updates without dropping existing values', () => {
    const compressor = new AutoContextCompressor({ preserveRecentCount: 10 });
    compressor.updateConfig({ warningThreshold: 0.7 });
    expect(compressor.getConfig().warningThreshold).toBe(0.7);
    expect(compressor.getConfig().preserveRecentCount).toBe(10);
  });
});
