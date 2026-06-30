import { describe, it, expect } from 'vitest';
import { estimateVideoCostCny } from '../../../src/shared/media/videoCost';

describe('Veo 成本估算', () => {
  it('veo-3.1-fast 按 ¥0.72/s × 8s ≈ ¥5.76', () => {
    expect(estimateVideoCostCny('veo-3.1-fast-generate-preview', 8)).toBeCloseTo(5.76, 2);
  });
  it('veo-3.1 标准按 ¥2.88/s × 8s ≈ ¥23.04', () => {
    expect(estimateVideoCostCny('veo-3.1-generate-preview', 8)).toBeCloseTo(23.04, 2);
  });
});
