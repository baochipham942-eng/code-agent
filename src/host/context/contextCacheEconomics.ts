import {
  DEFAULT_CACHE_READ_PRICE_RATIO,
  DEFAULT_CACHE_WRITE_PRICE_RATIO,
  MODEL_PRICING_PER_1M,
  getCuratedModelPricing,
} from '../../shared/constants/pricing';
import type { SystemPromptCacheCost } from '../../shared/contract/contextHealth';
import type { ProviderContextUsage } from './contextHealthService';

/** 20% tokenizer 尺差富余；低于该门槛时系统提示缓存成本必须保持未知。 */
const SYSTEM_PROMPT_CACHE_CERTAINTY_RATIO = 1.2;

/**
 * 系统提示位于请求最前缀，因此 cacheRead 足够长时可单独判定为完整缓存。
 * 这里不尝试把剩余 cacheRead 分配给其他展示桶。
 */
export function calculateSystemPromptCacheCost(
  systemPromptTokens: number,
  usage: ProviderContextUsage,
  model: string,
): SystemPromptCacheCost {
  const tokens = Number.isFinite(systemPromptTokens) && systemPromptTokens > 0
    ? systemPromptTokens
    : 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;

  if (tokens === 0 || cacheReadTokens < tokens * SYSTEM_PROMPT_CACHE_CERTAINTY_RATIO) {
    return { status: 'unknown', tokens };
  }

  const pricing = getCuratedModelPricing(usage.provider ?? '', model)
    ?? MODEL_PRICING_PER_1M.default;
  const cacheReadPrice = pricing.cacheRead ?? pricing.input * DEFAULT_CACHE_READ_PRICE_RATIO;
  const cacheWritePrice = pricing.cacheWrite ?? pricing.input * DEFAULT_CACHE_WRITE_PRICE_RATIO;
  const costUsd = (tokens / 1_000_000) * cacheReadPrice;
  const totalInputCostUsd =
    (usage.inputTokens / 1_000_000) * pricing.input
    + (cacheReadTokens / 1_000_000) * cacheReadPrice
    + ((usage.cacheCreationTokens ?? 0) / 1_000_000) * cacheWritePrice;

  return {
    status: 'known_cached',
    tokens,
    costUsd,
    inputCostPercent: totalInputCostUsd > 0 ? (costUsd / totalInputCostUsd) * 100 : 0,
  };
}
