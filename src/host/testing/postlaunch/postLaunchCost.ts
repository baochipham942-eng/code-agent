// ============================================================================
// 上线后打分的两笔钱（N-EVAL-POSTLAUNCH-K2）
// ----------------------------------------------------------------------------
// 刊例成本与预算成本是两个数，别合成一个：
//   - 刊例（listed）：模型有公开单价才算，没有就是 0。展示与落库只认这个
//     （resolveModelPrice §2「未知价不编造、禁止兜底价」）。
//   - 预算（budget）：没有刊例时按产品自己的保守默认价（MODEL_PRICING_PER_1M.default，
//     BudgetService 一直这么兜）估一笔记进日预算。K1 时未知价一律记 0，
//     于是日预算门对自建/自定义 provider 永远不触发，等于没有上限。
// host 运行时与 CLI 共用本模块，两边口径必须是同一份代码。
// ============================================================================
import { MODEL_PRICING_PER_1M } from '../../../shared/constants/pricing';
import { resolveModelPrice } from '../../../shared/pricing/resolveModelPrice';
import { estimateTokens } from '../../context/tokenEstimator';

/** judge 单次调用的输出上限；预算预留按这个估「下一次要花多少」。 */
export const JUDGE_MAX_TOKENS = 400;

interface JudgeCostEstimate {
  usd: number;
  /** true = 这笔钱是按保守默认价估的，只能进预算，不能进 cost_usd 与卡片。 */
  assumed: boolean;
}

/**
 * 估一次 judge 调用的花费。
 * `completion` 省略 = 调用还没发生，按输出上限估（预算预留用这一档）。
 */
export function estimateJudgeCost(
  judge: { provider: string; model: string } | null | undefined,
  prompt: string,
  completion?: string,
): JudgeCostEstimate {
  const inputTokens = estimateTokens(prompt);
  const outputTokens = completion === undefined ? JUDGE_MAX_TOKENS : estimateTokens(completion);
  const price = judge ? resolveModelPrice(judge.provider, judge.model) : undefined;
  if (price?.inputPerMTok === undefined || price.outputPerMTok === undefined) {
    const fallback = MODEL_PRICING_PER_1M.default;
    return { usd: (inputTokens * fallback.input + outputTokens * fallback.output) / 1_000_000, assumed: true };
  }
  return {
    usd: (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000,
    assumed: false,
  };
}
