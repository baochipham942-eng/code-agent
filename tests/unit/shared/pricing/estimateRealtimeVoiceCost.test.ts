import { describe, expect, it } from 'vitest';
import { estimateRealtimeVoiceCost } from '../../../../src/shared/pricing/estimateRealtimeVoiceCost';

describe('estimateRealtimeVoiceCost', () => {
  it('uses modality token prices from the shared realtime price table', () => {
    const estimate = estimateRealtimeVoiceCost('qwen3.5-omni-flash-realtime', {
      totalTokens: 4_000,
      inputTokens: 2_000,
      outputTokens: 2_000,
      inputAudioTokens: 1_000,
      inputTextTokens: 1_000,
      outputAudioTokens: 1_000,
      outputTextTokens: 1_000,
    });

    expect(estimate).toMatchObject({ currency: 'CNY' });
    expect(estimate?.amount).toBeCloseTo((27 + 3.3 + 107 + 20) / 1_000, 8);
  });

  it('returns unknown when the provider model has no auditable price entry', () => {
    expect(estimateRealtimeVoiceCost('custom-realtime-model', {
      totalTokens: 1,
      inputTokens: 1,
      outputTokens: 0,
      inputAudioTokens: 1,
      inputTextTokens: 0,
      outputAudioTokens: 0,
      outputTextTokens: 0,
    })).toBeNull();
  });
});
