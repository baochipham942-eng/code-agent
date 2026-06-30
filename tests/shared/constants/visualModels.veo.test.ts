import { describe, it, expect } from 'vitest';
import { videoModelById, videoModelsWithCap, clampVideoDuration } from '../../../src/shared/constants/visualModels';

describe('Veo 注册表', () => {
  it('veo-3.1-fast 已登记：google provider、t2v+i2v、固定 8s', () => {
    const m = videoModelById('veo-3.1-fast-generate-preview');
    expect(m).toBeDefined();
    expect(m!.provider).toBe('google');
    expect(m!.caps).toEqual(['t2v', 'i2v']);
    expect(clampVideoDuration(m!, 3)).toBe(8); // 越界回退固定 8s
  });
  it('veo-3.1 标准已登记', () => {
    expect(videoModelById('veo-3.1-generate-preview')?.provider).toBe('google');
  });
  it('t2v 列表含 Veo fast', () => {
    expect(videoModelsWithCap('t2v').some((m) => m.id === 'veo-3.1-fast-generate-preview')).toBe(true);
  });
});
