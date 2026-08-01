import { describe, expect, it } from 'vitest';
import {
  computeResizeExpandPlan,
  RESIZE_RATIO_PRESETS,
  type ResizeScales,
} from '../../../src/renderer/components/design/designCanvasResizeRatio';

/**
 * 独立于实现的「回放」校验：按 expand() 的真实语义（每边 scale 相对**原图**对应边长外扩，
 * 该边新增像素 = 原边长 × (scale-1)）把 scales 套到原图宽高上，得到一次扩图实际会产出的宽高——
 * 用来校验产物比例，而不是照抄实现内部变量。
 *
 *   W' = W × (left + right − 1)      H' = H × (top + bottom − 1)
 */
function applyScales(width: number, height: number, s: ResizeScales): { width: number; height: number } {
  for (const v of [s.top, s.bottom, s.left, s.right]) {
    expect(v).toBeGreaterThanOrEqual(1);
    expect(v).toBeLessThanOrEqual(2);
  }
  return { width: width * (s.left + s.right - 1), height: height * (s.top + s.bottom - 1) };
}

const shapes = {
  square: { width: 1000, height: 1000, label: '正方形' },
  landscape: { width: 1600, height: 900, label: '横图 16:9' },
  portrait: { width: 900, height: 1600, label: '竖图 9:16' },
  longStripLandscape: { width: 3000, height: 500, label: '极端横向长条' },
  longStripPortrait: { width: 500, height: 3000, label: '极端纵向长条' },
};

describe('computeResizeExpandPlan — 矩阵：5 档预设 × 常见原图比例', () => {
  for (const [, { width, height, label }] of Object.entries(shapes)) {
    for (const [presetId, ratio] of Object.entries(RESIZE_RATIO_PRESETS)) {
      it(`${label}(${width}x${height}) → ${presetId}`, () => {
        const plan = computeResizeExpandPlan(width, height, ratio);
        if (!plan.feasible) {
          expect(typeof plan.reason).toBe('string');
          expect(plan.reason.length).toBeGreaterThan(0);
          return;
        }
        if (plan.scales === null) {
          // 无需扩图：当前比例已达标（或差距被取整精度吃掉）。
          expect(Math.abs(width / height - ratio)).toBeLessThan(0.01);
          return;
        }
        const result = applyScales(width, height, plan.scales);
        // 只扩不裁：任何一维都不应缩小。
        expect(result.width).toBeGreaterThanOrEqual(width - 0.5);
        expect(result.height).toBeGreaterThanOrEqual(height - 0.5);
        // 扩完的比例应贴近目标（取整误差容忍 <1px 级别）。
        expect(Math.abs(result.width / result.height - ratio)).toBeLessThan(0.01);
        // 只动一个轴：另一轴两边都必须是 1（否则就不是「只扩偏小的那一维」）。
        const widthTouched = plan.scales.left > 1 || plan.scales.right > 1;
        const heightTouched = plan.scales.top > 1 || plan.scales.bottom > 1;
        expect(widthTouched && heightTouched).toBe(false);
        // 对称：被扩的那一维两侧等分，原图仍居中。
        if (widthTouched) expect(plan.scales.left).toBeCloseTo(plan.scales.right, 10);
        if (heightTouched) expect(plan.scales.top).toBeCloseTo(plan.scales.bottom, 10);
      });
    }
  }
});

describe('computeResizeExpandPlan — 一次调用（2026-08-01 由两步降为一次）', () => {
  it('横图变正方形：只需一组四向 scale，且只抬高度两侧', () => {
    const plan = computeResizeExpandPlan(1600, 900, RESIZE_RATIO_PRESETS['1:1']);
    expect(plan.feasible).toBe(true);
    if (!plan.feasible || !plan.scales) throw new Error('应当可行且需要扩图');
    expect(plan.scales.left).toBe(1);
    expect(plan.scales.right).toBe(1);
    expect(plan.scales.top).toBeGreaterThan(1);
    expect(plan.scales.top).toBeCloseTo(plan.scales.bottom, 10);
    // 回放：H' 应等于 1600（变成 1600x1600）
    expect(applyScales(1600, 900, plan.scales).height).toBeCloseTo(1600, 6);
  });

  it('竖图变横向：只抬宽度两侧', () => {
    const plan = computeResizeExpandPlan(900, 1200, RESIZE_RATIO_PRESETS['4:3']);
    expect(plan.feasible).toBe(true);
    if (!plan.feasible || !plan.scales) throw new Error('应当可行且需要扩图');
    expect(plan.scales.top).toBe(1);
    expect(plan.scales.bottom).toBe(1);
    expect(plan.scales.left).toBeCloseTo(plan.scales.right, 10);
    expect(applyScales(900, 1200, plan.scales).width).toBeCloseTo(1600, 6);
  });
});

describe('computeResizeExpandPlan — 可行范围没有因为改成一次调用而缩小', () => {
  // 旧的两步实现上限 ≈ 目标边长 3× 原边长；一次调用对称等分下 scale=(1+targetDim/baseDim)/2 ≤ 2
  // 同样等价于 targetDim ≤ 3×baseDim。这两条把边界钉死，防止改法悄悄砍掉可用档位。
  it('恰好 3× 边界内（targetH ≈ 2.99×H）：可行', () => {
    // 1000x335 → 1:1 需要把高从 335 补到 1000（≈2.985×）
    const plan = computeResizeExpandPlan(1000, 335, 1);
    expect(plan.feasible).toBe(true);
    if (!plan.feasible || !plan.scales) throw new Error('应当可行');
    expect(plan.scales.top).toBeLessThanOrEqual(2);
  });

  it('刚过 3×（targetH ≈ 3.03×H）：不可行', () => {
    // 1000x330 → 1:1 需要把高从 330 补到 1000（≈3.03×）
    const plan = computeResizeExpandPlan(1000, 330, 1);
    expect(plan.feasible).toBe(false);
  });

  it('精确 scale=2 的边界值可行', () => {
    const plan = computeResizeExpandPlan(300, 100, 1);
    expect(plan.feasible).toBe(true);
    if (!plan.feasible || !plan.scales) throw new Error('边界值应当可行');
    expect(plan.scales.top).toBe(2);
    expect(plan.scales.bottom).toBe(2);
  });

  it('scale 刚超 2 一点点就不可行', () => {
    expect(computeResizeExpandPlan(301, 100, 1).feasible).toBe(false);
  });
});

describe('computeResizeExpandPlan — 已达标（无需扩图）', () => {
  it('原图已是目标比例：scales 为 null（不发起付费调用）', () => {
    expect(computeResizeExpandPlan(1600, 900, RESIZE_RATIO_PRESETS['16:9'])).toEqual({
      feasible: true,
      scales: null,
    });
  });

  it('目标比例与原图比例完全相等（1:1 正方形）：scales 为 null', () => {
    expect(computeResizeExpandPlan(500, 500, RESIZE_RATIO_PRESETS['1:1'])).toEqual({
      feasible: true,
      scales: null,
    });
  });
});

describe('computeResizeExpandPlan — 浮点/取整边界（1px 级别差距不应被误判成不可用）', () => {
  it('目标比例仅差 1px 取整精度：仍判可行，四向 scale 都落在 [1,2]', () => {
    // currentRatio = 999/1000 = 0.999，目标 1:1 只比当前宽 1px。
    const plan = computeResizeExpandPlan(999, 1000, 1);
    expect(plan.feasible).toBe(true);
    if (!plan.feasible || !plan.scales) throw new Error('应当可行且需要扩图');
    expect(plan.scales.left).toBeCloseTo(1 + 1 / (2 * 999), 8);
    expect(plan.scales.left).toBeCloseTo(plan.scales.right, 10);
    expect(plan.scales.top).toBe(1);
    expect(plan.scales.bottom).toBe(1);
    expect(applyScales(999, 1000, plan.scales).width).toBeCloseTo(1000, 6);
  });
});

describe('computeResizeExpandPlan — 不可用分支：非极端输入也可能超出扩图能力', () => {
  it('竖图 9:16 → 16:9（跨越到另一端）：单边所需倍数超过 2×，判不可用并给出原因', () => {
    const plan = computeResizeExpandPlan(900, 1600, RESIZE_RATIO_PRESETS['16:9']);
    expect(plan.feasible).toBe(false);
    if (plan.feasible) return;
    // 用户视角说人话（2026-08-01 工单③）：形状描述 + 像素数字保留；内部机制词不出现
    expect(plan.reason).toContain('太窄');
    expect(plan.reason).toContain('横版');
    expect(plan.reason).toContain('900px');
    expect(plan.reason).toContain('超出能力');
    expect(plan.reason).not.toContain('两步对称扩展');
    expect(plan.reason).not.toContain('扩图能力上限');
  });

  it('横图 16:9 → 9:16（跨越到另一端）：同理不可用', () => {
    const plan = computeResizeExpandPlan(1600, 900, RESIZE_RATIO_PRESETS['9:16']);
    expect(plan.feasible).toBe(false);
    if (plan.feasible) return;
    expect(plan.reason).toContain('太扁');
    expect(plan.reason).toContain('竖版');
  });

  it('极端长条（横向 3000x500）：5 档预设全部不可用', () => {
    for (const ratio of Object.values(RESIZE_RATIO_PRESETS)) {
      expect(computeResizeExpandPlan(3000, 500, ratio).feasible).toBe(false);
    }
  });

  it('极端长条（纵向 500x3000）：5 档预设全部不可用', () => {
    for (const ratio of Object.values(RESIZE_RATIO_PRESETS)) {
      expect(computeResizeExpandPlan(500, 3000, ratio).feasible).toBe(false);
    }
  });
});

describe('computeResizeExpandPlan — 非法输入', () => {
  it('宽/高/目标比例非正数：一律判不可用', () => {
    expect(computeResizeExpandPlan(0, 1000, 1).feasible).toBe(false);
    expect(computeResizeExpandPlan(1000, 0, 1).feasible).toBe(false);
    expect(computeResizeExpandPlan(1000, 1000, 0).feasible).toBe(false);
    expect(computeResizeExpandPlan(1000, 1000, -1).feasible).toBe(false);
    expect(computeResizeExpandPlan(-1, 1000, 1).feasible).toBe(false);
  });
});
