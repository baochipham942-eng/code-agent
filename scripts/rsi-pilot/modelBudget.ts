// modelBudget — rsi-pilot runner 的 per-model 时间/输出预算（N-SOL-GAME-AB-FU2）
//
// 动机（父单 N-SOL-GAME-AB 证据档 FC-2）：36 unit A/B 里 glm-5.3 在 18/18 unit
// 撞 600s 硬超时（kill 时 stream snapshot = 55,842 chars reasoning / 0 chars
// content，一个工具轮都没完成）；gpt-6.1-sol 只 2/18 且都在产出地写游戏。
// 预算按实测校准（测量表见证据档 ①），未知模型保持旧行为逐字节不变。
import { BASH, MODEL_MAX_TOKENS } from '../../src/shared/constants/index.ts';

/** 一个 unit（case × rep）的预算。maxTokens = null 表示不写 modelConfig.maxTokens，
 *  适配器回落 MODEL_MAX_TOKENS.DEFAULT（= 16384）——与 FU2 之前的旧行为一致。 */
export interface UnitBudget {
  timeoutMs: number;
  maxTokens: number | null;
}

/** --timeout-ms / --max-tokens 的 CLI 覆盖；给了的字段逐字段赢过表。 */
export interface UnitBudgetOverrides {
  timeoutMs?: number;
  maxTokens?: number;
}

/** 旧行为 = 唯一默认：600s（与 BASH.MAX_TIMEOUT 同值，即 runner 旧的
 *  PER_RUN_HARD_TIMEOUT_MS）+ 不带 maxTokens（适配器默认 16384）。 */
export const DEFAULT_UNIT_BUDGET: UnitBudget = { timeoutMs: BASH.MAX_TIMEOUT, maxTokens: null };

/**
 * 实测预算表（测量记录见证据档 ①）。键 = model id，provider 只用于未来的
 * provider 级细分，不参与当前命中（zhipu / zhipu_coding 的 glm-5.3 同一预算）。
 */
export const MODEL_UNIT_BUDGETS: Record<string, UnitBudget> = {
  // 9-unit 实测：600s/default 0/3 产物；1200s/default 与 1200s/EXTENDED
  // 均有 1/3 完成 Write 且 HTML 离线全契约校验通过。取实测过的 EXTENDED 档。
  'glm-5.3': { timeoutMs: BASH.MAX_TIMEOUT * 2, maxTokens: MODEL_MAX_TOKENS.EXTENDED },
};

/** 非正数/非整数覆盖直接拒——静默回落表值会把一次笔误伪装成一次有效测量。 */
function assertPositiveIntegerOverride(name: string, value: number | undefined): void {
  if (value === undefined) return;
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`Invalid --${name} override "${String(value)}" — expected a positive integer.`);
  }
}

/** 纯函数：provider/model → 本 unit 的硬超时与 maxTokens；CLI 覆盖逐字段赢过表。 */
export function resolveUnitBudget(provider: string, model: string, overrides?: UnitBudgetOverrides): UnitBudget {
  void provider; // 签名预留：表按 model id 命中；需要 provider 级细分时再启用
  assertPositiveIntegerOverride('timeout-ms', overrides?.timeoutMs);
  assertPositiveIntegerOverride('max-tokens', overrides?.maxTokens);
  const base = MODEL_UNIT_BUDGETS[model] ?? DEFAULT_UNIT_BUDGET;
  return {
    timeoutMs: overrides?.timeoutMs ?? base.timeoutMs,
    maxTokens: overrides?.maxTokens ?? base.maxTokens,
  };
}
