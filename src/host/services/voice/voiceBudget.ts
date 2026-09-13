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
  VoiceEvent,
  VoiceTokenUsage,
} from '../../../shared/contract/voice';
import { estimateRealtimeVoiceCost } from '../../../shared/pricing/estimateRealtimeVoiceCost';
import { createLogger } from '../infra/logger';

const logger = createLogger('VoiceBudget');

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

export interface VoiceBudgetSubject {
  id: string;
  ending: boolean;
  startedAt: number;
  conversationModel: string;
  tokenUsage: { value?: VoiceTokenUsage };
}

interface VoiceBudgetWatch {
  config: VoiceBudgetConfig;
  lastLevel: VoiceBudgetLevel;
  timer: NodeJS.Timeout | null;
}

const watches = new Map<string, VoiceBudgetWatch>();

export function tickVoiceBudget(
  session: VoiceBudgetSubject,
  send: (event: VoiceEvent) => void,
  hangup: () => void,
): void {
  const watch = watches.get(session.id);
  if (!watch || session.ending) return;
  const estimate = session.tokenUsage.value
    ? estimateRealtimeVoiceCost(session.conversationModel, session.tokenUsage.value)
    : null;
  const evaluation = evaluateVoiceBudget({
    elapsedMs: Date.now() - session.startedAt,
    costAmount: estimate?.amount ?? null,
    minuteLimit: watch.config.minuteLimit,
    costLimit: watch.config.costLimit,
  });
  send({
    type: 'budget',
    ...evaluation,
    costCurrency: estimate?.currency ?? null,
  });
  const previous = watch.lastLevel;
  if (evaluation.level === 'silent' && previous === 'none') {
    logger.info('voice budget silent threshold', {
      voiceSessionId: session.id,
      usageRatio: evaluation.usageRatio,
    });
  }
  if (evaluation.level === 'warning' && previous !== 'warning' && previous !== 'blocked') {
    send({
      type: 'notice',
      code: 'VOICE_BUDGET_WARNING',
      message: 'VOICE_BUDGET_WARNING',
    });
  }
  if (evaluation.level === 'blocked' && previous !== 'blocked') {
    send({
      type: 'notice',
      code: 'VOICE_BUDGET_EXCEEDED',
      message: 'VOICE_BUDGET_EXCEEDED',
    });
    watch.lastLevel = evaluation.level;
    if (watch.config.exceedAction === 'hangup') {
      send({ type: 'session.ended', reason: 'budget' });
      hangup();
      return;
    }
  }
  watch.lastLevel = evaluation.level;
}

export function startVoiceBudgetWatch(
  session: VoiceBudgetSubject,
  live: VoiceLiveSettings | undefined,
  send: (event: VoiceEvent) => void,
  hangup: () => void,
  isCurrent: () => boolean,
): void {
  stopVoiceBudgetWatch(session.id);
  const config = resolveVoiceBudgetConfig(live);
  if (!isVoiceBudgetConfigured(config)) return;
  const watch: VoiceBudgetWatch = { config, lastLevel: 'none', timer: null };
  watches.set(session.id, watch);
  tickVoiceBudget(session, send, hangup);
  watch.timer = setInterval(() => {
    if (isCurrent()) tickVoiceBudget(session, send, hangup);
  }, VOICE_BUDGET.EVAL_INTERVAL_MS);
  watch.timer.unref?.();
}

export function stopVoiceBudgetWatch(sessionId: string): void {
  const watch = watches.get(sessionId);
  if (!watch) return;
  if (watch.timer) clearInterval(watch.timer);
  watches.delete(sessionId);
}
