import { describe, it, expect } from 'vitest';
import {
  estimateImageCostCny,
  formatCny,
} from '../../../src/shared/media/imageCost';
import {
  IMAGE_PRICING_CNY,
  DESIGN_IMAGE_MODELS,
} from '../../../src/shared/constants/pricing';

describe('imageCost.estimateImageCostCny', () => {
  it('wanx 文生图 / 局部重绘均为 0.14 元/张（DashScope 实价）', () => {
    expect(estimateImageCostCny(DESIGN_IMAGE_MODELS.generate)).toBe(0.14);
    expect(estimateImageCostCny(DESIGN_IMAGE_MODELS.edit)).toBe(0.14);
    expect(estimateImageCostCny('wanx2.1-t2i-turbo')).toBe(0.14);
    expect(estimateImageCostCny('wanx2.1-imageedit')).toBe(0.14);
  });

  it('cogview-4 按智谱公示价、cogview-3-flash 免费', () => {
    expect(estimateImageCostCny('cogview-4-250304')).toBe(0.06);
    expect(estimateImageCostCny('cogview-3-flash')).toBe(0);
  });

  it('未知模型（如动态 flux 模型）回退 default 价', () => {
    expect(estimateImageCostCny('black-forest-labs/flux-2')).toBe(IMAGE_PRICING_CNY.default);
    expect(estimateImageCostCny(undefined)).toBe(IMAGE_PRICING_CNY.default);
    expect(estimateImageCostCny(null)).toBe(IMAGE_PRICING_CNY.default);
    expect(estimateImageCostCny('')).toBe(IMAGE_PRICING_CNY.default);
  });

  it('DESIGN_IMAGE_MODELS 的 key 必须命中价表（防 model-id 与价表漂移）', () => {
    expect(DESIGN_IMAGE_MODELS.generate in IMAGE_PRICING_CNY).toBe(true);
    expect(DESIGN_IMAGE_MODELS.edit in IMAGE_PRICING_CNY).toBe(true);
  });
});

describe('imageCost.formatCny', () => {
  it('两位小数 + ¥ 前缀', () => {
    expect(formatCny(0.14)).toBe('¥0.14');
    expect(formatCny(0)).toBe('¥0.00');
    expect(formatCny(0.42)).toBe('¥0.42');
    expect(formatCny(1.4)).toBe('¥1.40');
  });
});
