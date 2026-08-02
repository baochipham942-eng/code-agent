import { describe, expect, it } from 'vitest';
import {
  findTextClickableCollisions,
  overlapSize,
  rectsIntersect,
  type OcclusionItem,
} from '../../../scripts/acceptance/fixtures/design-topbar-occlusion.ts';

const item = (name: string, x: number, y: number, width: number, height: number): OcclusionItem => ({
  name,
  rect: { x, y, width, height },
});

describe('rectsIntersect / overlapSize', () => {
  it('正面积相交 → true，且回报重叠宽高', () => {
    const a = item('引导文字', 10, 10, 200, 28).rect;
    const b = item('导出 PPTX', 150, 20, 120, 32).rect;
    expect(rectsIntersect(a, b)).toBe(true);
    expect(overlapSize(a, b)).toEqual({ width: 60, height: 18 });
  });

  it('边缘相贴（共边/共点）不算遮挡', () => {
    const a = item('a', 0, 0, 100, 40).rect;
    expect(rectsIntersect(a, item('右边贴着', 100, 0, 50, 40).rect)).toBe(false);
    expect(rectsIntersect(a, item('下边贴着', 0, 40, 100, 20).rect)).toBe(false);
    expect(rectsIntersect(a, item('角点相贴', 100, 40, 30, 30).rect)).toBe(false);
    expect(overlapSize(a, item('右边贴着', 100, 0, 50, 40).rect)).toBeNull();
  });

  it('完全分离 → false；一方包含另一方 → true', () => {
    const a = item('a', 0, 0, 100, 40).rect;
    expect(rectsIntersect(a, item('远处', 300, 300, 50, 50).rect)).toBe(false);
    expect(rectsIntersect(a, item('被包含', 10, 10, 20, 10).rect)).toBe(true);
  });

  it('零尺寸矩形不参与判定（隐藏/未布局元素不制造碰撞）', () => {
    const a = item('a', 0, 0, 100, 40).rect;
    expect(rectsIntersect(a, item('零宽', 10, 10, 0, 20).rect)).toBe(false);
    expect(rectsIntersect(item('零高', 10, 10, 20, 0).rect, a)).toBe(false);
  });
});

describe('findTextClickableCollisions（文本 × 可点两两判定）', () => {
  it('文本与可点元素相交 → 报碰撞（2026-08-01 引导文字被导出按钮压住的场景）', () => {
    const collisions = findTextClickableCollisions(
      [item('点选一张图后可圈选区域做局部重绘 · …', 16, 60, 320, 26)],
      [item('导出 PPTX', 300, 56, 130, 34)],
    );
    expect(collisions).toHaveLength(1);
    expect(collisions[0]).toMatchObject({
      overlapWidth: 36,
      overlapHeight: 26,
    });
    expect(collisions[0]?.text).toContain('局部重绘');
    expect(collisions[0]?.clickable).toBe('导出 PPTX');
  });

  it('只报跨组碰撞：text×text 与 clickable×clickable 相交不在本口径', () => {
    const collisions = findTextClickableCollisions(
      [item('文本甲', 0, 0, 100, 20), item('文本乙（与甲重叠）', 50, 10, 100, 20)],
      [item('按钮甲', 500, 0, 80, 30)],
    );
    expect(collisions).toEqual([]);
  });

  it('不相交的文本/可点组合全过', () => {
    const collisions = findTextClickableCollisions(
      [item('图解提示', 16, 60, 200, 24)],
      [item('导出 PPTX', 700, 56, 130, 34), item('图层面板', 960, 48, 32, 32)],
    );
    expect(collisions).toEqual([]);
  });

  it('一个文本压多个可点元素 → 逐对全报', () => {
    const collisions = findTextClickableCollisions(
      [item('超长引导', 0, 0, 500, 24)],
      [item('按钮A', 100, 4, 80, 20), item('按钮B', 300, 4, 80, 20), item('远处按钮', 900, 4, 80, 20)],
    );
    expect(collisions.map((c) => c.clickable)).toEqual(['按钮A', '按钮B']);
  });
});
