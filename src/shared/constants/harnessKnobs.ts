// ============================================================================
// Harness Knobs — 行为策略数值旋钮的默认表与校验（纯数据，host / renderer / 契约层共用）
// 运行时作用域覆盖在 host: agent/runtime/harnessKnobs.ts（AsyncLocalStorage）。
// 盘点与取舍见 private-archive docs/evidence/N-HARNESS-PROFILE-SURFACE-2026-09-12.md。
// ============================================================================
import { SUBAGENT_COMPACTION, SYSTEM_PROMPT_BUDGET } from './agent';

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

const HARNESS_KNOB_KEYS = Object.keys(HARNESS_KNOB_DEFAULTS) as HarnessKnobKey[];

/** 比例型旋钮必须落在 (0, 1]；其余为正有限数。 */
const RATIO_KEYS: ReadonlySet<HarnessKnobKey> = new Set<HarnessKnobKey>(['subagent.compactionThreshold']);

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

/**
 * profile 文件级校验：顶层必须是带 `knobs` 键的对象（`[]`、`{}`、缺键都拒），再走 validateHarnessKnobs。
 * 不许「文件非法但按默认跑」——run 记录会盖上 profile 路径，结果会被错误归因（PR#1769 ai-review R3）。
 */
export function validateHarnessProfile(value: unknown): HarnessKnobs {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('harness profile 顶层必须是对象：{ "knobs": { … } }');
  }
  if (!('knobs' in value)) {
    throw new Error('harness profile 缺少 knobs 键：{ "knobs": { … } }');
  }
  return validateHarnessKnobs((value as { knobs: unknown }).knobs);
}

/**
 * 归一化为「默认表 + 覆盖」的全表（键按字典序）。省略、空对象、显式写成默认值三者结果相同——
 * 实验臂签名用它比较，避免「配置看着不同、行为完全一样」的假 A/B（PR#1769 ai-review）。
 */
export function normalizeHarnessKnobs(knobs: Record<string, number> | undefined): Record<HarnessKnobKey, number> {
  const merged: Record<string, number> = { ...HARNESS_KNOB_DEFAULTS, ...(knobs ?? {}) };
  return Object.fromEntries(
    HARNESS_KNOB_KEYS.map((key) => [key, merged[key]]),
  ) as Record<HarnessKnobKey, number>;
}
