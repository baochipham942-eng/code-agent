// useToolbarOverflow 纯决策函数 computeVisibleCount 单测（K1 溢出折叠）。
// 覆盖：全放得下 / 从末尾收折 / 收折时计入 reserve / 量不到宽度不收 / 滞回（放回要多余量）。
import { describe, expect, it } from 'vitest';
import { computeVisibleCount } from '../../../src/renderer/components/design/useToolbarOverflow';

// 参数速查：computeVisibleCount(widths, avail, reserve, gap, chrome, hysteresis, prev)
const GAP = 4;
const CHROME = 18;
const HYST = 8;

describe('computeVisibleCount', () => {
  it('全放得下：返回全部项数，且不计 reserve', () => {
    // total(3) = 18 + 150 + gap*2 = 176 ≤ 200
    expect(computeVisibleCount([50, 50, 50], 200, 30, GAP, CHROME, HYST, 3)).toBe(3);
  });

  it('最后一项刚好放下时不收折（不收就不预留 reserve）', () => {
    // total(1) = 18 + 50 = 68 ≤ 68 → 全可见；若误加 reserve（68+30=98）会收掉
    expect(computeVisibleCount([50], 68, 30, GAP, CHROME, HYST, 1)).toBe(1);
  });

  it('放不下从末尾收折，收折后计入 reserve 宽度', () => {
    // total(3)=206 >150；total(2)=18+120+30+gap*2=176 >150；total(1)=18+60+30+gap=112 ≤150
    expect(computeVisibleCount([60, 60, 60], 150, 30, GAP, CHROME, HYST, 3)).toBe(1);
  });

  it('一项都放不下：收到 0（全进溢出，至少 ⋯ 可达）', () => {
    // total(2)=18+120+gap*2=146 >100；total(1)=18+60+30+gap=112 >100；total(0)=18+30=48 ≤100
    expect(computeVisibleCount([60, 60], 100, 30, GAP, CHROME, HYST, 2)).toBe(0);
  });

  it('量不到宽度（avail=0，jsdom/SSR）保持 prev 不收折', () => {
    expect(computeVisibleCount([60, 60], 0, 30, GAP, CHROME, HYST, 2)).toBe(2);
  });

  it('滞回：往回放要求多出 hysteresis 余量，刚好放下不放回（防抖）', () => {
    const widths = [60, 60, 60];
    // avail=176：total(2)=176 刚好 ≤176，但 176 > 176-8 → 维持 prev=1
    expect(computeVisibleCount(widths, 176, 30, GAP, CHROME, HYST, 1)).toBe(1);
    // avail=184：total(2)=176 ≤ 184-8=176 → 放回到 2
    expect(computeVisibleCount(widths, 184, 30, GAP, CHROME, HYST, 1)).toBe(2);
  });

  it('滞回不挡收折：宽度变窄立即收，不留余量', () => {
    // prev=2，avail=175：total(2)=176 >175 → 收到 1（total(1)=112 ≤175）
    expect(computeVisibleCount([60, 60, 60], 175, 30, GAP, CHROME, HYST, 2)).toBe(1);
  });

  it('常驻「更多」在全展开态也计入，刚好差它的宽度时必须收折', () => {
    expect(computeVisibleCount([50, 50, 50], 180, 30, GAP, CHROME, HYST, 3, {
      reserveAlways: true,
    })).toBe(2);
  });

  it('条件删除段（含分隔条）计入实测宽度，出现后边界会立即收折', () => {
    expect(computeVisibleCount([100, 50], 200, 30, GAP, CHROME, HYST, 2)).toBe(2);
    expect(computeVisibleCount([100, 50], 200, 30, GAP, CHROME, HYST, 2, {
      fixedWidth: 41,
      fixedElementCount: 1,
    })).toBe(1);
  });
});
