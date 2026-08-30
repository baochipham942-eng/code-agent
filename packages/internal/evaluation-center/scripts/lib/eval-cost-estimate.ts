import {
  MODEL_PRICING_PER_1M,
  PRICING_TABLE_VERSION,
} from '@shared/constants/pricing';

const AVERAGE_TOKENS_PER_CASE = 5_000;
const TOKENS_PER_MILLION = 1_000_000;

export { PRICING_TABLE_VERSION };

export function estimateCostPerCase(modelName: string): number {
  const pricing = MODEL_PRICING_PER_1M[modelName]
    ?? MODEL_PRICING_PER_1M[modelName.toLowerCase()]
    ?? MODEL_PRICING_PER_1M.default;
  return (pricing.input + pricing.output) * AVERAGE_TOKENS_PER_CASE / TOKENS_PER_MILLION;
}

export function estimateRunCost(modelName: string, cases: number): number {
  return estimateCostPerCase(modelName) * Math.max(0, cases);
}
