import type { VoiceTokenUsage } from '../contract/voice';
import {
  REALTIME_VOICE_PRICING_PER_1M,
  type RealtimeVoicePricingEntry,
} from '../constants/pricing';

export interface RealtimeVoiceCostEstimate {
  amount: number;
  currency: RealtimeVoicePricingEntry['currency'];
  source: string;
}

function cost(tokens: number, pricePerMillion: number): number {
  return (Math.max(0, tokens) / 1_000_000) * pricePerMillion;
}

export function estimateRealtimeVoiceCost(
  modelId: string,
  usage: VoiceTokenUsage,
): RealtimeVoiceCostEstimate | null {
  const pricing = REALTIME_VOICE_PRICING_PER_1M[modelId];
  if (!pricing) return null;

  const knownInput = usage.inputAudioTokens + usage.inputTextTokens;
  const knownOutput = usage.outputAudioTokens + usage.outputTextTokens;
  const unclassifiedInput = Math.max(0, usage.inputTokens - knownInput);
  const unclassifiedOutput = Math.max(0, usage.outputTokens - knownOutput);
  const amount = cost(usage.inputAudioTokens, pricing.inputAudio)
    + cost(usage.inputTextTokens + unclassifiedInput, pricing.inputText)
    + cost(usage.outputAudioTokens, pricing.outputAudio)
    + cost(usage.outputTextTokens + unclassifiedOutput, pricing.outputText);

  return { amount, currency: pricing.currency, source: pricing.source };
}
