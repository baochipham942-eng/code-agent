// 音乐调用成本估算（纯函数，无副作用，main/renderer 共用）。
// 价表唯一真源在 shared/constants/pricing.ts，本模块只做查表，
// 不持有任何价格字面量（遵守「禁止硬编码价格」规范）。
import { MUSIC_PRICING_CNY } from '../constants/pricing';

/**
 * 估算单次音乐生成的成本（人民币元）。
 * model 命中价表则取实价，未知模型回退 default 兜底。
 */
export function estimateMusicCostCny(model?: string | null): number {
  if (model && Object.prototype.hasOwnProperty.call(MUSIC_PRICING_CNY, model)) {
    return MUSIC_PRICING_CNY[model];
  }
  return MUSIC_PRICING_CNY.default;
}
