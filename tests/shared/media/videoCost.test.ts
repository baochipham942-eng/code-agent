import { describe, it, expect } from 'vitest';
import { estimateVideoCostCny } from '../../../src/shared/media/videoCost';
import { VIDEO_MODELS } from '../../../src/shared/constants/visualModels';

describe('estimateVideoCostCny — 视频按秒计费估算', () => {
  it('命中价表：成本 = 单价/秒 × 时长', () => {
    const cost5 = estimateVideoCostCny('wan2.7-t2v', 5);
    const cost10 = estimateVideoCostCny('wan2.7-t2v', 10);
    expect(cost5).toBeGreaterThan(0);
    expect(cost10).toBeCloseTo(cost5 * 2, 5);
  });

  it('未知模型回退 default 单价', () => {
    expect(estimateVideoCostCny('no-such', 5)).toBeGreaterThan(0);
  });

  it('非法/非正时长按 0 计（不产生负成本）', () => {
    expect(estimateVideoCostCny('wan2.7-t2v', 0)).toBe(0);
    expect(estimateVideoCostCny('wan2.7-t2v', Number.NaN)).toBe(0);
    expect(estimateVideoCostCny('wan2.7-t2v', -3)).toBe(0);
  });

  it('每个注册视频模型都在价表里有条目（无遗漏，避免静默走 default）', () => {
    for (const m of VIDEO_MODELS) {
      expect(estimateVideoCostCny(m.id, 1)).toBeGreaterThan(0);
    }
  });
});
