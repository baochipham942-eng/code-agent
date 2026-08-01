import { describe, expect, it } from 'vitest';
import {
  computeResizeExpandPlan,
  RESIZE_RATIO_PRESETS,
  type ExpandStep,
} from '../../../src/renderer/components/design/designCanvasResizeRatio';

/**
 * 独立于实现的「回放」校验：按 expand() 的真实语义（某边这一步新增像素 = 该边当前边长 ×
 * (ratio-1)，'left'/'right' 作用于宽、'up'/'down' 作用于高）依次把 steps 套到原图宽高上，
 * 得到扩图流程实际会产出的最终宽高——用来校验产物比例，而不是照抄实现内部变量。
 */
function applySteps(width: number, height: number, steps: readonly ExpandStep[]): { width: number; height: number } {
  let w = width;
  let h = height;
  for (const step of steps) {
    expect(step.ratio).toBeGreaterThanOrEqual(1);
    expect(step.ratio).toBeLessThanOrEqual(2);
    if (step.direction === 'left' || step.direction === 'right') {
      w += w * (step.ratio - 1);
    } else if (step.direction === 'up' || step.direction === 'down') {
      h += h * (step.ratio - 1);
    }
  }
  return { width: w, height: h };
}

const shapes = {
  square: { width: 1000, height: 1000, label: '正方形' },
  landscape: { width: 1600, height: 900, label: '横图 16:9' },
  portrait: { width: 900, height: 1600, label: '竖图 9:16' },
  longStripLandscape: { width: 3000, height: 500, label: '极端横向长条' },
  longStripPortrait: { width: 500, height: 3000, label: '极端纵向长条' },
};

describe('computeResizeExpandPlan — 矩阵：5 档预设 × 常见原图比例', () => {
  for (const [shapeName, { width, height, label }] of Object.entries(shapes)) {
    for (const [presetId, ratio] of Object.entries(RESIZE_RATIO_PRESETS)) {
      it(`${label}(${width}x${height}) → ${presetId}`, () => {
        const plan = computeResizeExpandPlan(width, height, ratio);
        if (!plan.feasible) {
          expect(typeof plan.reason).toBe('string');
          expect(plan.reason.length).toBeGreaterThan(0);
          return;
        }
        expect(plan.steps.length === 0 || plan.steps.length === 2).toBe(true);
        if (plan.steps.length === 0) {
          // 无需扩图：当前比例已达标（或差距被取整精度吃掉）。
          expect(Math.abs(width / height - ratio)).toBeLessThan(0.01);
          return;
        }
        const result = applySteps(width, height, plan.steps);
        // 只扩不裁：任何一维都不应缩小。
        expect(result.width).toBeGreaterThanOrEqual(width - 0.5);
        expect(result.height).toBeGreaterThanOrEqual(height - 0.5);
        // 扩完的比例应贴近目标（取整误差容忍 <1px 级别）。
        expect(Math.abs(result.width / result.height - ratio)).toBeLessThan(0.01);
        // 两步方向须成对（左右或上下），不会混用/不会用 'all'。
        const dirs = plan.steps.map((s) => s.direction).sort();
        expect(['left', 'right'].sort().join() === dirs.join() || ['down', 'up'].sort().join() === dirs.join()).toBe(
          true,
        );
      });
    }
  }
});

describe('computeResizeExpandPlan — 已达标（无需扩图）', () => {
  it('原图已是目标比例：steps 为空', () => {
    const plan = computeResizeExpandPlan(1600, 900, RESIZE_RATIO_PRESETS['16:9']);
    expect(plan).toEqual({ feasible: true, steps: [] });
  });

  it('目标比例与原图比例完全相等（1:1 正方形）：steps 为空', () => {
    const plan = computeResizeExpandPlan(500, 500, RESIZE_RATIO_PRESETS['1:1']);
    expect(plan).toEqual({ feasible: true, steps: [] });
  });
});

describe('computeResizeExpandPlan — 浮点/取整边界（1px 级别差距不应被误判成不可用）', () => {
  it('目标比例仅差 1px 取整精度：仍判可行，产出的两步 ratio 都落在 [1,2]', () => {
    // currentRatio = 999/1000 = 0.999，目标 1:1 只比当前宽 1px。
    const plan = computeResizeExpandPlan(999, 1000, 1);
    expect(plan.feasible).toBe(true);
    if (!plan.feasible) return;
    expect(plan.steps).toHaveLength(2);
    const [step1, step2] = plan.steps;
    expect(step1.direction).toBe('left');
    expect(step2.direction).toBe('right');
    expect(step1.ratio).toBeCloseTo(1 + 1 / 999, 5);
    expect(step2.ratio).toBe(1); // 差值只有 1px，全部分给第一步，第二步是幂等 no-op
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
      const plan = computeResizeExpandPlan(3000, 500, ratio);
      expect(plan.feasible).toBe(false);
    }
  });

  it('极端长条（纵向 500x3000）：5 档预设全部不可用', () => {
    for (const ratio of Object.values(RESIZE_RATIO_PRESETS)) {
      const plan = computeResizeExpandPlan(500, 3000, ratio);
      expect(plan.feasible).toBe(false);
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
