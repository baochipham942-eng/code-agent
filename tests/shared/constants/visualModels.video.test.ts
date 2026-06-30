import { describe, it, expect } from 'vitest';
import {
  VIDEO_MODELS,
  videoModelById,
  defaultVideoModelId,
  videoModelsWithCap,
  clampVideoDuration,
} from '../../../src/shared/constants/visualModels';

describe('VIDEO_MODELS 注册表', () => {
  it('provider 仅限已接入集合，且 P3 起多 provider（dashscope + minimax 均在册）', () => {
    expect(VIDEO_MODELS.length).toBeGreaterThan(0);
    const allowed = new Set(['dashscope', 'minimax', 'google', 'ark']);
    expect(VIDEO_MODELS.every((m) => allowed.has(m.provider))).toBe(true);
    const providers = new Set(VIDEO_MODELS.map((m) => m.provider));
    expect(providers.has('dashscope')).toBe(true);
    expect(providers.has('minimax')).toBe(true);
  });

  it('每个模型至少声明一个 cap，且时长区间合法（min<=default<=max 且 >0）', () => {
    for (const m of VIDEO_MODELS) {
      expect(m.caps.length).toBeGreaterThan(0);
      expect(m.minDurationSec).toBeGreaterThan(0);
      expect(m.minDurationSec).toBeLessThanOrEqual(m.defaultDurationSec);
      expect(m.defaultDurationSec).toBeLessThanOrEqual(m.maxDurationSec);
    }
  });

  it('videoModelsWithCap 按能力过滤：t2v 与 i2v 各至少一个', () => {
    expect(videoModelsWithCap('t2v').length).toBeGreaterThan(0);
    expect(videoModelsWithCap('i2v').length).toBeGreaterThan(0);
  });

  it('defaultVideoModelId 命中一个真实注册项', () => {
    expect(videoModelById(defaultVideoModelId())).toBeDefined();
  });

  it('videoModelById 未知 id 返回 undefined', () => {
    expect(videoModelById('no-such-model')).toBeUndefined();
  });
});

describe('clampVideoDuration — 付费前时长守门', () => {
  it('undefined / NaN → 回退模型默认时长', () => {
    const t2v = videoModelById('wan2.7-t2v')!;
    expect(clampVideoDuration(t2v, undefined)).toBe(t2v.defaultDurationSec);
    expect(clampVideoDuration(t2v, Number.NaN)).toBe(t2v.defaultDurationSec);
  });
  it('越界值 clamp 到 [min,max]，小数四舍五入', () => {
    const t2v = videoModelById('wan2.7-t2v')!; // 2..15
    expect(clampVideoDuration(t2v, 999)).toBe(15);
    expect(clampVideoDuration(t2v, 1)).toBe(2);
    expect(clampVideoDuration(t2v, 7.6)).toBe(8);
  });
  it('固定时长模型恒为固定值', () => {
    const i2v = videoModelById('wanx2.1-i2v-turbo')!; // 5..5
    expect(clampVideoDuration(i2v, 12)).toBe(5);
    expect(clampVideoDuration(i2v, undefined)).toBe(5);
  });
});

describe('Seedance（ark）内置视频模型', () => {
  it('注册 pro/fast 两条，provider=ark，t2v+i2v 双 cap', () => {
    const pro = videoModelById('doubao-seedance-2-0-260128');
    const fast = videoModelById('doubao-seedance-2-0-fast-260128');
    expect(pro?.provider).toBe('ark');
    expect(fast?.provider).toBe('ark');
    expect(pro?.caps).toEqual(expect.arrayContaining(['t2v', 'i2v']));
    expect(fast?.caps).toEqual(expect.arrayContaining(['t2v', 'i2v']));
  });
  it('Seedance 同时出现在 t2v 和 i2v 列表', () => {
    expect(videoModelsWithCap('t2v').some((m) => m.provider === 'ark')).toBe(true);
    expect(videoModelsWithCap('i2v').some((m) => m.provider === 'ark')).toBe(true);
  });
  it('duration clamp 配置合法（min ≤ default ≤ max）', () => {
    for (const m of VIDEO_MODELS.filter((x) => x.provider === 'ark')) {
      expect(m.minDurationSec).toBeLessThanOrEqual(m.defaultDurationSec);
      expect(m.defaultDurationSec).toBeLessThanOrEqual(m.maxDurationSec);
    }
  });
});
