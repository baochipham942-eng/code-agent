// 视频调用成本估算（纯函数，main/renderer 共用）。价表唯一真源在 pricing.ts，
// 本模块只查表 × 时长，不持有任何价格字面量（遵守「禁止硬编码价格」规范）。
import { VIDEO_PRICING_CNY_PER_SEC } from '../constants/pricing';

/** 估算单次视频生成成本（人民币元）= 单价/秒 × 时长；非正时长记 0；未知模型回退 default。 */
export function estimateVideoCostCny(model: string | null | undefined, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  const perSec =
    model && Object.prototype.hasOwnProperty.call(VIDEO_PRICING_CNY_PER_SEC, model)
      ? VIDEO_PRICING_CNY_PER_SEC[model]
      : VIDEO_PRICING_CNY_PER_SEC.default;
  return perSec * durationSec;
}
