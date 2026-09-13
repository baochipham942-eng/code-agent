// ============================================================================
// 单通电话预算闸（RQ-301）
//
// 用户自配分钟上限 + 可选成本上限；默认不阻断。档位比例与超限动作常量在
// VOICE_BUDGET，价格走 REALTIME_VOICE_PRICING_PER_1M，本文件不写字面量。
// ============================================================================

import { VOICE_BUDGET } from '../../../shared/constants/voice';
import type { VoiceLiveSettings } from '../../../shared/contract/settings';
import type {
  VoiceBudgetExceedAction,
  VoiceBudgetLevel,
  VoiceBudgetSnapshot,
} from '../../../shared/contract/voice';

export interface VoiceBudgetConfig {
  minuteLimit: number | null;
  costLimit: number | null;
  exceedAction: VoiceBudgetExceedAction;
}

export interface VoiceBudgetEvaluationInput {
  elapsedMs: number;
  costAmount: number | null;
  minuteLimit: number | null;
  costLimit: number | null;
}

function finitePositive(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

export function resolveVoiceBudgetConfig(live: VoiceLiveSettings | undefined): VoiceBudgetConfig {
  const exceedAction: VoiceBudgetExceedAction = live?.callCostLimitAction === 'hangup'
    ? 'hangup'
    : VOICE_BUDGET.DEFAULT_EXCEED_ACTION;
  return {
    minuteLimit: finitePositive(live?.callMinuteLimit),
    costLimit: finitePositive(live?.callCostLimit),
    exceedAction,
  };
}

export function isVoiceBudgetConfigured(config: VoiceBudgetConfig): boolean {
  return config.minuteLimit !== null || config.costLimit !== null;
}

function levelForRatio(ratio: number): VoiceBudgetLevel {
  if (ratio >= VOICE_BUDGET.BLOCK_RATIO) return 'blocked';
  if (ratio >= VOICE_BUDGET.WARNING_RATIO) return 'warning';
  if (ratio >= VOICE_BUDGET.SILENT_RATIO) return 'silent';
  return 'none';
}

/**
 * 纯函数：按已用分钟 / 已估成本相对各自上限取最大占用比，再映射到三档。
 * 未设的轨不参与；成本上限在尚无估算时也不参与（避免把「还没账单」当成 0% 安全）。
 */
export function evaluateVoiceBudget(
  input: VoiceBudgetEvaluationInput,
): Omit<VoiceBudgetSnapshot, 'costCurrency'> {
  const minutesUsed = Math.max(0, input.elapsedMs) / 60_000;
  const minutesLimit = finitePositive(input.minuteLimit);
  const costLimit = finitePositive(input.costLimit);
  const costAmount = typeof input.costAmount === 'number' && Number.isFinite(input.costAmount)
    ? Math.max(0, input.costAmount)
    : null;

  const ratios: number[] = [];
  if (minutesLimit !== null) ratios.push(minutesUsed / minutesLimit);
  if (costLimit !== null && costAmount !== null) ratios.push(costAmount / costLimit);

  const usageRatio = ratios.length === 0 ? 0 : Math.max(...ratios);
  return {
    level: ratios.length === 0 ? 'none' : levelForRatio(usageRatio),
    usageRatio,
    minutesUsed,
    minutesLimit,
    costAmount,
    costLimit,
  };
}
