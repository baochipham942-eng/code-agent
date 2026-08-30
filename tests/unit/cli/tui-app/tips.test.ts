import { describe, expect, it } from 'vitest';
import { pickStartupTip } from '../../../../src/cli/tui-app/tips';

describe('pickStartupTip（首屏 tip 轮换）', () => {
  it('同种子确定可复现，连续种子覆盖多条不同 tip', () => {
    const seen = new Set<string>();
    for (let seed = 0; seed < 20; seed += 1) {
      const tip = pickStartupTip(seed);
      expect(tip).toBe(pickStartupTip(seed)); // 确定性
      seen.add(tip);
    }
    expect(seen.size).toBeGreaterThan(1); // 轮换而非恒定
  });

  it('负种子/浮点种子不越界、输出均为单行 Tip 格式', () => {
    for (const seed of [-3, -0.5, 0, 1.7, Date.now()]) {
      const tip = pickStartupTip(seed);
      expect(tip.startsWith('Tip: ')).toBe(true);
      expect(tip).not.toContain('\n');
    }
  });
});
