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
import { SUBAGENT_COMPACTION, SYSTEM_PROMPT_BUDGET } from '../../../shared/constants/agent';

export const HARNESS_KNOB_DEFAULTS = {
  /** 子代理上下文压缩触发比例（占模型窗口），subagentCompaction.ts 消费 */
  'subagent.compactionThreshold': SUBAGENT_COMPACTION.THRESHOLD,
  /** 持久系统上下文总 token 预算，systemContextStack.ts 消费 */
  'context.persistentSystemContextTokens': 1200,
  /** system prompt 预算下限（小窗口/无模型信息时的默认），contextAssembly/shared.ts 消费 */
  'context.systemPromptMinTokens': SYSTEM_PROMPT_BUDGET.MIN_TOKENS,
} as const satisfies Record<string, number>;

export type HarnessKnobKey = keyof typeof HARNESS_KNOB_DEFAULTS;
export type HarnessKnobs = Partial<Record<HarnessKnobKey, number>>;

/** 比例型旋钮必须落在 (0, 1]；其余为正有限数。 */
const RATIO_KEYS: ReadonlySet<HarnessKnobKey> = new Set<HarnessKnobKey>(['subagent.compactionThreshold']);

const HARNESS_KNOB_KEYS = Object.keys(HARNESS_KNOB_DEFAULTS) as HarnessKnobKey[];

function isHarnessKnobKey(key: string): key is HarnessKnobKey {
  return Object.prototype.hasOwnProperty.call(HARNESS_KNOB_DEFAULTS, key);
}

/** 校验外部输入（评测请求 / profile 文件）；未知键、非正数、比例越界一律拒收。 */
export function validateHarnessKnobs(value: unknown): HarnessKnobs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('harness.knobs 必须是对象。');
  }
  const out: HarnessKnobs = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!isHarnessKnobKey(key)) {
      throw new Error(`harness.knobs 未知旋钮：${key}（可用：${HARNESS_KNOB_KEYS.join(', ')}）`);
    }
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
      throw new Error(`harness.knobs.${key} 必须是正有限数。`);
    }
    if (RATIO_KEYS.has(key) && raw > 1) {
      throw new Error(`harness.knobs.${key} 是比例，必须 ≤ 1。`);
    }
    out[key] = raw;
  }
  return out;
}

const knobScope = new AsyncLocalStorage<HarnessKnobs>();

/** 空表直接透传：默认路径不进 AsyncLocalStorage，与现状零差异。 */
export function runWithHarnessKnobs<T>(knobs: HarnessKnobs | undefined, callback: () => T): T {
  if (!knobs || Object.keys(knobs).length === 0) return callback();
  return knobScope.run({ ...knobScope.getStore(), ...knobs }, callback);
}

export function getHarnessKnob(key: HarnessKnobKey): number {
  return knobScope.getStore()?.[key] ?? HARNESS_KNOB_DEFAULTS[key];
}
