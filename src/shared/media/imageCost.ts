// 图像调用成本估算（纯函数，无副作用，main/renderer 共用）。
// 价表唯一真源在 shared/constants/pricing.ts，本模块只做查表与格式化，
// 不持有任何价格字面量（遵守「禁止硬编码价格」规范）。
import { IMAGE_PRICING_CNY } from '../constants/pricing';

/**
 * 估算单次图像生成/编辑的成本（人民币元）。
 * model 命中价表则取实价，未知模型（如动态 flux 模型 id）回退 default 兜底。
 */
export function estimateImageCostCny(model?: string | null): number {
  if (model && Object.prototype.hasOwnProperty.call(IMAGE_PRICING_CNY, model)) {
    return IMAGE_PRICING_CNY[model];
  }
  return IMAGE_PRICING_CNY.default;
}

/** 成本展示格式：¥ 前缀 + 两位小数（如 0.14 → '¥0.14'）。 */
export function formatCny(amount: number): string {
  return `¥${amount.toFixed(2)}`;
}
