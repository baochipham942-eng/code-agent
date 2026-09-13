// ============================================================================
// Harness Knobs — 行为策略数值旋钮的单一读取口（N-HARNESS-PROFILE-SURFACE 试点）
//
// 立场：只收「改了会影响任务成败」的 (a) 类数值；防御性上限 / 展示参数不进来
//（盘点见 private-archive docs/evidence/N-HARNESS-PROFILE-SURFACE-2026-09-12.md）。
// 默认值就是原来的字面量，无覆盖时逐字回到现状；覆盖只活在 AsyncLocalStorage
// 作用域里——与 scaffoldProfile / compressionPipeline 的 runWith*Override 同一套路，
// 进程级零全局态，同一进程可并行跑不同旋钮表的 arm。
// ============================================================================
import { AsyncLocalStorage } from 'node:async_hooks';
import { HARNESS_KNOB_DEFAULTS, type HarnessKnobKey, type HarnessKnobs } from '../../../shared/constants/harnessKnobs';

export { HARNESS_KNOB_DEFAULTS, validateHarnessKnobs, type HarnessKnobKey, type HarnessKnobs } from '../../../shared/constants/harnessKnobs';

const knobScope = new AsyncLocalStorage<HarnessKnobs>();

/** 空表直接透传：默认路径不进 AsyncLocalStorage，与现状零差异。 */
export function runWithHarnessKnobs<T>(knobs: HarnessKnobs | undefined, callback: () => T): T {
  if (!knobs || Object.keys(knobs).length === 0) return callback();
  return knobScope.run({ ...knobScope.getStore(), ...knobs }, callback);
}

export function getHarnessKnob(key: HarnessKnobKey): number {
  return knobScope.getStore()?.[key] ?? HARNESS_KNOB_DEFAULTS[key];
}
